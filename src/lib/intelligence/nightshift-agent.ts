/**
 * @file    nightshift-agent.ts
 * @purpose Local LLM overnight email pre-classification using llama-server (Qwen).
 *          Enqueues unprocessed AP emails at 6 PM, runs a classification loop
 *          overnight, and stores results in nightshift_queue for the 8 AM AP
 *          identifier to consume — skipping the paid Sonnet call when confident.
 *
 *          Safety posture: every exported function catches all errors and returns
 *          null/void. If nightshift completely fails, daytime AP flow is untouched.
 *
 * @author  Aria / Antigravity
 * @created 2026-03-24
 */

import os from "os";
import { createClient } from "../supabase";
import { recall } from "./memory";
import { getAnthropicClient } from "../anthropic";

// ── Constants (overridable via env) ──────────────────────────────────────────

const LLAMA_URL              = process.env.LLAMA_SERVER_URL ?? "http://localhost:11434";  // Ollama default
// DECISION(2026-03-25): Default to qwen3:4b for overnight runs. More capable
// than qwen2.5:1.5b (~3.5 GB RAM) but fine overnight when Will isn't on the
// machine. Qwen 2.5 locks the UI during daytime use; 3.4 runs unencumbered at night.
const LLAMA_MODEL            = process.env.LLAMA_MODEL_NAME ?? "qwen3:4b";
const CONFIDENCE_THRESHOLD   = 0.7;
const BATCH_SIZE             = parseInt(process.env.NIGHTSHIFT_BATCH_SIZE ?? "30");
const CALL_TIMEOUT_MS        = 30_000;
const STALE_PROCESSING_MS    = 5 * 60 * 1000;
const MAX_HAIKU_ESCALATIONS  = parseInt(process.env.NIGHTSHIFT_MAX_ESCALATIONS ?? "20");
const MIN_FREE_RAM_BYTES     = 2 * 1024 * 1024 * 1024;  // 2 GB circuit breaker (overnight = plenty of headroom)

const VALID_INTENTS = [
    "INVOICE",
    "STATEMENT",
    "ADVERTISEMENT",
    "HUMAN_INTERACTION",
    "PAID_INVOICE",
] as const;
type EmailIntent = typeof VALID_INTENTS[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NightshiftResult {
    classification: EmailIntent;
    confidence: number;
    handler: "local" | "claude-haiku";
    reasoning: string;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildClassificationPrompt(
    from: string,
    subject: string,
    snippet: string,
    memoryContext: string,
): string {
    return `AP email classifier. Return JSON only: {"classification":"...","confidence":0.0-1.0,"reasoning":"..."}

From: ${from}
Subject: ${subject}
Snippet: ${snippet}
${memoryContext ? `\nContext:\n${memoryContext}` : ""}

INVOICE - Standard vendor bill (may or may not have a PO).
STATEMENT - Account statement or aging summary.
ADVERTISEMENT - Marketing, spam, or newsletter.
HUMAN_INTERACTION - Payment question, order issue, or anything requiring a human reply.
PAID_INVOICE - Payment confirmation for an invoice that has been paid.`;
}

// ── JSON parse hardening ──────────────────────────────────────────────────────

function parseClassificationResponse(
    text: string,
    handler: "local" | "claude-haiku",
): NightshiftResult | null {
    try {
        const raw = text
            .trim()
            .replace(/^```json\s*/i, "")
            .replace(/```$/, "")
            .trim();
        const parsed = JSON.parse(raw);

        const classification = parsed.classification as string;
        if (!VALID_INTENTS.includes(classification as EmailIntent)) {
            return null;
        }

        const rawConf = parsed.confidence;
        const confidence = (typeof rawConf === "number" && isFinite(rawConf))
            ? rawConf
            : 0.5;

        return {
            classification: classification as EmailIntent,
            confidence,
            handler,
            reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        };
    } catch {
        return null;
    }
}

// ── Local LLM call ────────────────────────────────────────────────────────────

async function callLocalLLM(prompt: string): Promise<NightshiftResult | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

        const resp = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model: LLAMA_MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1,
                max_tokens: 200,
            }),
        });
        clearTimeout(timer);

        if (!resp.ok) return null;
        const data = await resp.json() as any;
        const text: string = data?.choices?.[0]?.message?.content ?? "";
        if (!text) return null;

        return parseClassificationResponse(text, "local");
    } catch {
        return null;
    }
}

// ── Haiku escalation ──────────────────────────────────────────────────────────
// DECISION(2026-03-24): Uses Anthropic SDK directly (not unifiedTextGeneration) to
// guarantee Haiku 4.5 is used — unifiedTextGeneration has no model-override param and
// would route to Gemini first. Direct SDK call ensures cost predictability.

async function callClaudeHaiku(prompt: string): Promise<NightshiftResult | null> {
    try {
        const client = getAnthropicClient();
        const msg = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            temperature: 0.1,
            messages: [{ role: "user", content: prompt }],
        });
        const text = msg.content
            .filter(b => b.type === "text")
            .map(b => (b as any).text)
            .join("");
        if (!text) return null;
        return parseClassificationResponse(text, "claude-haiku");
    } catch {
        return null;
    }
}

// ── llama-server health check ─────────────────────────────────────────────────

async function checkLlamaHealth(): Promise<boolean> {
    try {
        // Ollama: GET / returns plain text "Ollama is running"
        // llama-server: GET /health returns JSON with status field
        const resp = await fetch(`${LLAMA_URL}/`, {
            signal: AbortSignal.timeout(3000),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

// ── Public: enqueue ───────────────────────────────────────────────────────────

/**
 * Enqueue a paid invoice from bill.selee@buildasoil.com for overnight PO reconciliation.
 * These are always already-paid (credit card) invoices — never Bill.com.
 * Includes full body_text so Haiku can extract line items overnight.
 * Never throws.
 */
export async function enqueueDefaultInboxInvoice(
    gmailMessageId: string,
    fromEmail: string,
    subject: string,
    bodyText: string,
): Promise<void> {
    try {
        const supabase = createClient();
        if (!supabase) return;

        await supabase.from("nightshift_queue").upsert(
            {
                gmail_message_id: gmailMessageId,
                task_type: "default_inbox_invoice",
                payload: { from_email: fromEmail, subject, body_text: bodyText, source_inbox: "default" },
                status: "pending",
            },
            { onConflict: "gmail_message_id,task_type", ignoreDuplicates: true },
        );
    } catch (err: any) {
        console.error("[nightshift] enqueue default-inbox error:", err?.message ?? err);
    }
}

/**
 * Insert a gmail message into the nightshift queue for overnight classification.
 * Uses ON CONFLICT DO NOTHING — safe to call multiple times for the same message.
 * Never throws.
 */
export async function enqueueEmailClassification(
    gmailMessageId: string,
    fromEmail: string,
    subject: string,
    bodySnippet: string,
    sourceInbox = "ap",
): Promise<void> {
    try {
        const supabase = createClient();
        if (!supabase) return;

        await supabase.from("nightshift_queue").upsert(
            {
                gmail_message_id: gmailMessageId,
                task_type: "email_classification",
                payload: { from_email: fromEmail, subject, body_snippet: bodySnippet, source_inbox: sourceInbox },
                status: "pending",
            },
            { onConflict: "gmail_message_id,task_type", ignoreDuplicates: true },
        );
    } catch (err: any) {
        console.error("[nightshift] enqueue error:", err?.message ?? err);
    }
}

// ── Public: lookup ────────────────────────────────────────────────────────────

/**
 * Return a completed pre-classification result if one exists with confidence >= threshold.
 * Returns null on any DB error, missing row, or low-confidence result.
 * Never throws.
 */
export async function getPreClassification(
    gmailMessageId: string,
): Promise<NightshiftResult | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("nightshift_queue")
            .select("result, handler")
            .eq("gmail_message_id", gmailMessageId)
            .eq("task_type", "email_classification")
            .eq("status", "completed")
            .gt("expires_at", new Date().toISOString())
            .maybeSingle();

        if (error || !data?.result) return null;

        const r = data.result as NightshiftResult;
        if (typeof r.confidence !== "number" || r.confidence < CONFIDENCE_THRESHOLD) return null;
        if (!VALID_INTENTS.includes(r.classification)) return null;

        return r;
    } catch {
        return null;
    }
}

// ── Public: main loop ─────────────────────────────────────────────────────────

export interface NightshiftLoopOpts {
    dryRun?: boolean;
    onBatchComplete?: (stats: { local: number; haiku: number; failed: number; durationMs: number }) => void;
}

/**
 * Process one batch of pending nightshift tasks.
 * Caller is responsible for looping with delays between cycles.
 */
export async function runNightshiftLoop(opts: NightshiftLoopOpts = {}): Promise<void> {
    const { dryRun = false } = opts;

    // 1. RAM circuit breaker
    const freeMem = os.freemem();
    if (freeMem < MIN_FREE_RAM_BYTES) {
        console.warn(`[nightshift] RAM circuit breaker: only ${(freeMem / 1e9).toFixed(1)} GB free — skipping cycle`);
        return;
    }

    // 2. llama-server health check
    const llamaOk = await checkLlamaHealth();
    if (!llamaOk) {
        console.warn(`[nightshift] llama-server not reachable at ${LLAMA_URL} — skipping cycle`);
        return;
    }

    const supabase = createClient();
    if (!supabase) {
        console.warn("[nightshift] Supabase unavailable — skipping cycle");
        return;
    }

    const cycleStart = Date.now();

    // 3. Reset stale processing rows back to pending (server-side interval to avoid clock skew)
    try {
        await supabase
            .from("nightshift_queue")
            .update({ status: "pending", updated_at: new Date().toISOString() })
            .eq("status", "processing")
            .lt("updated_at", new Date(Date.now() - STALE_PROCESSING_MS).toISOString());
    } catch (e: any) {
        console.warn("[nightshift] stale-reset error (non-fatal):", e?.message);
    }

    // 4. Fetch pending batch (all task types)
    const { data: tasks, error: fetchErr } = await supabase
        .from("nightshift_queue")
        .select("id, gmail_message_id, task_type, payload")
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);

    if (fetchErr) {
        console.error("[nightshift] fetch error:", fetchErr.message);
        return;
    }

    // 5. Empty queue notice
    if (!tasks || tasks.length === 0) {
        console.log("[nightshift] No tasks in queue — is ops-manager running?");
        return;
    }

    let localCount = 0;
    let haikuCount = 0;
    let failedCount = 0;

    let defaultInboxCount = 0;
    let defaultInboxFailed = 0;

    for (const task of tasks) {
        const { id, gmail_message_id: msgId, task_type, payload } = task as any;
        const { from_email: from = "", subject = "", body_snippet: snippet = "", body_text: bodyText = "" } = payload ?? {};

        // 6a. Optimistic lock — returns the row only if it was still 'pending'
        const { data: locked } = await supabase
            .from("nightshift_queue")
            .update({ status: "processing", updated_at: new Date().toISOString() })
            .eq("id", id)
            .eq("status", "pending")
            .select("id");

        if (!locked || locked.length === 0) {
            // Row already locked by another worker
            continue;
        }

        // ── Route: default_inbox_invoice ─────────────────────────────────────
        // DECISION(2026-03-25): Paid invoices from bill.selee@buildasoil.com use
        // a dedicated worker. qwen3 is skipped entirely — Haiku handles extraction.
        // Immediate Telegram alerts fire inside the worker for Guard 1/4 failures.
        if (task_type === "default_inbox_invoice") {
            if (dryRun) {
                console.log(`[nightshift] (dry-run) would process default_inbox_invoice for ${msgId}`);
                await supabase
                    .from("nightshift_queue")
                    .update({ status: "pending", updated_at: new Date().toISOString() })
                    .eq("id", id);
                continue;
            }

            try {
                const { processDefaultInboxInvoice } = await import("./workers/default-inbox-invoice");
                const result = await processDefaultInboxInvoice(msgId, from, subject, bodyText || snippet);

                console.log(`[nightshift] default_inbox gmail_id=${msgId} | outcome=${result.outcome} | ${result.summary}`);

                const succeeded = result.outcome !== "unknown_error" && result.outcome !== "extraction_failed";
                await supabase
                    .from("nightshift_queue")
                    .update({
                        status:       succeeded ? "completed" : "failed",
                        result:       result,
                        handler:      "haiku",
                        error:        result.error || null,
                        updated_at:   new Date().toISOString(),
                        processed_at: new Date().toISOString(),
                    })
                    .eq("id", id);

                if (succeeded) {
                    defaultInboxCount++;
                } else {
                    defaultInboxFailed++;
                }
            } catch (workerErr: any) {
                console.error(`[nightshift] default_inbox worker error for ${msgId}:`, workerErr?.message);
                await supabase
                    .from("nightshift_queue")
                    .update({
                        status:       "failed",
                        error:        workerErr?.message ?? "worker_exception",
                        updated_at:   new Date().toISOString(),
                        processed_at: new Date().toISOString(),
                    })
                    .eq("id", id);
                defaultInboxFailed++;
            }
            continue; // Don't fall into email_classification logic below
        }

        // 6b. Recall vendor context (email_classification path)
        let memoryContext = "";
        try {
            const memories = await recall(`AP email from ${from}: ${subject}`, { topK: 3 });
            if (memories.length > 0) {
                memoryContext = memories.map((m: any) => m.memory).join("\n");
            }
        } catch { /* non-fatal */ }

        const prompt = buildClassificationPrompt(from, subject, snippet, memoryContext);

        // 6c/d. Try local LLM first
        let result: NightshiftResult | null = await callLocalLLM(prompt);
        let escalated = false;

        // 6e. Escalate to Haiku if local fails or low-confidence
        if (!result || result.confidence < CONFIDENCE_THRESHOLD) {
            const localConf = result?.confidence ?? null;
            if (haikuCount >= MAX_HAIKU_ESCALATIONS) {
                const reason = "haiku_budget_exceeded";
                console.log(`[nightshift] gmail_id=${msgId} | FAILED: ${reason}`);
                if (!dryRun) {
                    await supabase
                        .from("nightshift_queue")
                        .update({
                            status: "failed",
                            error: reason,
                            updated_at: new Date().toISOString(),
                            processed_at: new Date().toISOString(),
                        })
                        .eq("id", id);
                }
                failedCount++;
                continue;
            }

            const haikuResult = await callClaudeHaiku(prompt);
            haikuCount++;
            escalated = true;

            if (!haikuResult) {
                const reason = "all_models_failed";
                console.log(`[nightshift] gmail_id=${msgId} | FAILED: ${reason}`);
                if (!dryRun) {
                    await supabase
                        .from("nightshift_queue")
                        .update({
                            status: "failed",
                            error: reason,
                            updated_at: new Date().toISOString(),
                            processed_at: new Date().toISOString(),
                        })
                        .eq("id", id);
                }
                failedCount++;
                continue;
            }

            if (escalated && localConf !== null) {
                console.log(`[nightshift] gmail_id=${msgId} | escalated→haiku (local conf=${localConf.toFixed(2)}) | ${haikuResult.classification} | conf=${haikuResult.confidence.toFixed(2)}`);
            } else {
                console.log(`[nightshift] gmail_id=${msgId} | escalated→haiku (local returned null) | ${haikuResult.classification} | conf=${haikuResult.confidence.toFixed(2)}`);
            }
            result = haikuResult;
        } else {
            console.log(`[nightshift] gmail_id=${msgId} | ${result.classification} | conf=${result.confidence.toFixed(2)} | handler=local`);
            localCount++;
        }

        // 6f/g. Write result (or log-only in dry-run)
        if (dryRun) {
            console.log(`[nightshift] (dry-run) would write: ${JSON.stringify(result)}`);
        } else {
            await supabase
                .from("nightshift_queue")
                .update({
                    status: "completed",
                    result,
                    handler: result.handler,
                    updated_at: new Date().toISOString(),
                    processed_at: new Date().toISOString(),
                })
                .eq("id", id);
        }
    }

    // 7. Haiku budget warning
    if (haikuCount >= MAX_HAIKU_ESCALATIONS) {
        console.warn(`[nightshift] Haiku budget hit (${MAX_HAIKU_ESCALATIONS}) — local model may need attention`);
    }

    // 8. Delete expired rows
    try {
        await supabase
            .from("nightshift_queue")
            .delete()
            .lt("expires_at", new Date().toISOString());
    } catch { /* non-fatal */ }

    const durationMs = Date.now() - cycleStart;
    console.log(
        `[nightshift] Batch done: ${tasks.length} tasks ` +
        `(${localCount} local, ${haikuCount} haiku, ${failedCount} failed` +
        (defaultInboxCount + defaultInboxFailed > 0
            ? `, ${defaultInboxCount} invoices reconciled, ${defaultInboxFailed} invoice failures`
            : "") +
        `) in ${Math.round(durationMs / 1000)}s`
    );

    opts.onBatchComplete?.({ local: localCount, haiku: haikuCount, failed: failedCount, durationMs });
}

// ── Public: Morning Handoff ───────────────────────────────────────────────────

export interface NightshiftHandoff {
    /** Total emails pre-classified overnight */
    totalClassified: number;
    /** Breakdown by handler */
    localCount: number;
    haikuCount: number;
    failedCount: number;
    /** Classification breakdown */
    byClassification: Record<string, number>;
    /** Failed tasks needing daytime LLM attention */
    pendingTasks: Array<{ gmailMessageId: string; from: string; subject: string; error?: string }>;
    /** Low-confidence results that daytime LLM should re-verify */
    lowConfidence: Array<{ gmailMessageId: string; from: string; subject: string; classification: string; confidence: number }>;
    /** Overnight reconciliation results (from cron_runs) */
    reconciliations: Array<{ vendor: string; status: string; durationSec: number; error?: string }>;
    /**
     * Default inbox paid invoice reconciliation results.
     * These are always-paid (credit-card) invoices from bill.selee@buildasoil.com.
     */
    defaultInboxInvoices: Array<{
        vendorName: string;
        poNumber: string | null;
        outcome: string;
        total: number;
        priceUpdates: number;
        summary: string;
    }>;
    /** Formatted Telegram message */
    telegramMessage: string;
}

/**
 * Generate the morning handoff report summarizing overnight nightshift work.
 * Called at 6:55 AM before the nightshift runner shuts down.
 * Produces a structured to-do list for daytime LLM and human review.
 *
 * DECISION(2026-03-25): This is the critical loop closure. Without it,
 * Will has no visibility into what happened overnight. Failed/low-confidence
 * items become action items for the smarter daytime LLM (Gemini/Claude).
 */
export async function generateMorningHandoff(): Promise<NightshiftHandoff | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

        // 1. Fetch all nightshift results from the past 12 hours
        const { data: allTasks } = await supabase
            .from("nightshift_queue")
            .select("gmail_message_id, status, handler, result, error, payload")
            .gte("created_at", twelveHoursAgo);

        const allTasksList = allTasks || [];

        // Split by task type — default inbox invoices are a separate pipeline
        const emailTasks   = allTasksList.filter((t: any) => (t.task_type ?? "email_classification") === "email_classification");
        const invoiceTasks = allTasksList.filter((t: any) => t.task_type === "default_inbox_invoice");

        const completed = emailTasks.filter((t: any) => t.status === "completed");
        const failed    = emailTasks.filter((t: any) => t.status === "failed");
        const pending   = emailTasks.filter((t: any) => t.status === "pending");

        // Count by handler
        const localCount = completed.filter((t: any) => t.handler === "local").length;
        const haikuCount = completed.filter((t: any) => t.handler === "claude-haiku").length;

        // Count by classification
        const byClassification: Record<string, number> = {};
        for (const t of completed) {
            const cls = (t.result as any)?.classification || "UNKNOWN";
            byClassification[cls] = (byClassification[cls] || 0) + 1;
        }

        // Low-confidence results (completed but below 0.85 — flagged for daytime re-verify)
        const LOW_CONF_THRESHOLD = 0.85;
        const lowConfidence = completed
            .filter((t: any) => {
                const conf = (t.result as any)?.confidence;
                return typeof conf === "number" && conf < LOW_CONF_THRESHOLD;
            })
            .map((t: any) => ({
                gmailMessageId: t.gmail_message_id,
                from: (t.payload as any)?.from_email || "",
                subject: (t.payload as any)?.subject || "",
                classification: (t.result as any)?.classification || "UNKNOWN",
                confidence: (t.result as any)?.confidence || 0,
            }));

        // Failed email classification tasks → to-do items for daytime LLM
        const pendingTasks = [
            ...failed.map((t: any) => ({
                gmailMessageId: t.gmail_message_id,
                from: (t.payload as any)?.from_email || "",
                subject: (t.payload as any)?.subject || "",
                error: t.error || "unknown",
            })),
            ...pending.map((t: any) => ({
                gmailMessageId: t.gmail_message_id,
                from: (t.payload as any)?.from_email || "",
                subject: (t.payload as any)?.subject || "",
                error: "still_pending_at_handoff",
            })),
        ];

        // Default inbox invoice reconciliation results
        const defaultInboxInvoices: NightshiftHandoff["defaultInboxInvoices"] = invoiceTasks.map((t: any) => ({
            vendorName:   (t.result as any)?.vendorName   || (t.payload as any)?.from_email || "Unknown",
            poNumber:     (t.result as any)?.poNumber     || null,
            outcome:      (t.result as any)?.outcome      || t.status,
            total:        (t.result as any)?.total        || 0,
            priceUpdates: (t.result as any)?.priceUpdates || 0,
            summary:      (t.result as any)?.summary      || t.error || "",
        }));

        // 2. Fetch overnight reconciliation results from cron_runs
        const reconciliations: NightshiftHandoff["reconciliations"] = [];
        try {
            const { data: cronRuns } = await supabase
                .from("cron_runs")
                .select("task_name, status, duration_ms, error")
                .in("task_name", ["ReconcileAxiom", "ReconcileFedEx", "ReconcileTeraGanix", "ReconcileULINE"])
                .gte("started_at", twelveHoursAgo)
                .order("started_at", { ascending: true });

            for (const r of cronRuns || []) {
                reconciliations.push({
                    vendor: r.task_name.replace("Reconcile", ""),
                    status: r.status || "unknown",
                    durationSec: Math.round((r.duration_ms || 0) / 1000),
                    error: r.error || undefined,
                });
            }
        } catch { /* cron_runs table may not exist */ }

        // 3. Build Telegram message
        const totalClassified = completed.length;
        const lines: string[] = [];
        lines.push("🌙 <b>Night Shift Handoff</b>\n");

        // Classification summary
        if (totalClassified > 0) {
            lines.push(`📧 <b>Email Pre-Classification:</b> ${totalClassified} emails`);
            lines.push(`   🤖 Local (Qwen): ${localCount} | ☁️ Haiku: ${haikuCount}`);
            const clsLine = Object.entries(byClassification)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ");
            lines.push(`   📋 ${clsLine}`);
        } else {
            lines.push("📧 No emails in nightshift queue overnight");
        }

        // Default inbox paid invoice summary
        if (defaultInboxInvoices.length > 0) {
            const okOutcomes = new Set(["reconciled", "reconciled_partial", "already_processed"]);
            const invoiceOk   = defaultInboxInvoices.filter(i => okOutcomes.has(i.outcome));
            const invoiceBad  = defaultInboxInvoices.filter(i => !okOutcomes.has(i.outcome));
            lines.push(`\n💳 <b>Paid Invoice Reconciliation (${defaultInboxInvoices.length}):</b>`);
            for (const inv of invoiceOk) {
                const icon = inv.outcome === "reconciled" ? "✅" : inv.outcome === "reconciled_partial" ? "⚠️" : "♻️";
                lines.push(`   ${icon} ${inv.vendorName}${inv.poNumber ? ` PO #${inv.poNumber}` : ""} — $${inv.total.toFixed(2)}, ${inv.priceUpdates} updates`);
            }
            for (const inv of invoiceBad) {
                lines.push(`   ❌ ${inv.vendorName}: ${inv.outcome}`);
            }
        }

        // Cron-run reconciliation summary (Axiom, FedEx, TeraGanix, ULINE CLI)
        if (reconciliations.length > 0) {
            lines.push("\n🧾 <b>CLI Reconciliations:</b>");
            for (const r of reconciliations) {
                const icon = r.status === "success" ? "✅" : "❌";
                lines.push(`   ${icon} ${r.vendor} (${r.durationSec}s)${r.error ? ` — ${r.error.slice(0, 60)}` : ""}`);
            }
        }

        // To-Do list for daytime
        const todoItems: string[] = [];

        if (pendingTasks.length > 0) {
            todoItems.push(`⚠️ ${pendingTasks.length} email(s) failed nightshift — need daytime LLM classification`);
            for (const t of pendingTasks.slice(0, 5)) {
                todoItems.push(`   • "${t.subject}" from ${t.from} (${t.error})`);
            }
            if (pendingTasks.length > 5) {
                todoItems.push(`   • ...and ${pendingTasks.length - 5} more`);
            }
        }

        if (lowConfidence.length > 0) {
            todoItems.push(`🔍 ${lowConfidence.length} low-confidence classification(s) — consider re-verifying:`);
            for (const lc of lowConfidence.slice(0, 3)) {
                todoItems.push(`   • "${lc.subject}" → ${lc.classification} (${(lc.confidence * 100).toFixed(0)}%)`);
            }
        }

        const failedRecons = reconciliations.filter(r => r.status !== "success");
        if (failedRecons.length > 0) {
            todoItems.push(`🧾 ${failedRecons.length} CLI reconciliation(s) failed — need manual review`);
        }

        // Invoice reconciliation failures that need morning attention
        const needsMorningReview = ["extraction_failed", "reconciled_partial", "no_vendor_party", "unknown_error"];
        const invoiceNeedsReview = defaultInboxInvoices.filter(i => needsMorningReview.includes(i.outcome));
        if (invoiceNeedsReview.length > 0) {
            todoItems.push(`💳 ${invoiceNeedsReview.length} paid invoice(s) need morning review:`);
            for (const inv of invoiceNeedsReview.slice(0, 5)) {
                todoItems.push(`   • ${inv.summary}`);
            }
        }

        if (todoItems.length > 0) {
            lines.push("\n📝 <b>Morning To-Do:</b>");
            lines.push(...todoItems);
        } else {
            lines.push("\n✅ <b>Clean night — nothing needs attention</b>");
        }

        const telegramMessage = lines.join("\n");

        // 4. Store handoff in Supabase for dashboard access
        try {
            await supabase.from("nightshift_queue").upsert(
                {
                    gmail_message_id: `handoff-${new Date().toISOString().slice(0, 10)}`,
                    task_type: "morning_handoff",
                    payload: {
                        totalClassified,
                        localCount,
                        haikuCount,
                        failedCount: failed.length,
                        byClassification,
                        pendingTasks: pendingTasks.length,
                        lowConfidence: lowConfidence.length,
                        reconciliations,
                        defaultInboxInvoices: defaultInboxInvoices.length,
                    },
                    status: "completed",
                    result: { todoItems, telegramMessage },
                    handler: "system",
                    processed_at: new Date().toISOString(),
                },
                { onConflict: "gmail_message_id,task_type", ignoreDuplicates: false },
            );
        } catch { /* non-fatal */ }

        return {
            totalClassified,
            localCount,
            haikuCount,
            failedCount: failed.length,
            byClassification,
            pendingTasks,
            lowConfidence,
            reconciliations,
            defaultInboxInvoices,
            telegramMessage,
        };
    } catch (err: any) {
        console.error("[nightshift] Morning handoff generation failed:", err?.message ?? err);
        return null;
    }
}
