/**
 * @file    src/lib/intelligence/ap-health-report.ts
 * @purpose Morning AP pipeline health report. Queries Supabase and produces a
 *          clean Markdown summary for Telegram, covering invoices, match rates,
 *          stuck items, OCR issues, and reconciliation health.
 *
 * @deps    @/lib/db
 *
 * @author  Hermia
 * @created 2026-06-05
 */

import { createClient } from "../db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursAgo(n: number): string {
    return new Date(Date.now() - n * 3600000).toISOString();
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

interface IntentCount {
    intent: string;
    count: number;
}

interface MatchStats {
    matched: number;
    unmatched: number;
    total: number;
}

interface StuckRow {
    message_id: string;
    subject: string;
    status: string;
    ageHours: number;
}

/** Count rows per intent in the last 24 h. */
async function countByIntent(db: any): Promise<IntentCount[]> {
    const cutoff = hoursAgo(24);
    const { data, error } = await db
        .from("ap_activity_log")
        .select("intent")
        .gte("created_at", cutoff);

    if (error || !data) {
        console.warn("[ap-health-report] countByIntent query failed:", error?.message);
        return [];
    }

    const tally = new Map<string, number>();
    for (const row of data as { intent: string }[]) {
        const key = row.intent || "UNKNOWN";
        tally.set(key, (tally.get(key) ?? 0) + 1);
    }

    return Array.from(tally.entries())
        .map(([intent, count]) => ({ intent, count }))
        .sort((a, b) => b.count - a.count);
}

/** Count matched vs unmatched invoices by checking metadata->>'matched'. */
async function getMatchStats(db: any): Promise<MatchStats | null> {
    const cutoff = hoursAgo(24);
    const { data, error } = await db
        .from("ap_activity_log")
        .select("metadata")
        .gte("created_at", cutoff)
        .in("intent", ["INVOICE", "BILL_FORWARD"]);

    if (error || !data) {
        console.warn("[ap-health-report] getMatchStats query failed:", error?.message);
        return null;
    }

    let matched = 0;
    let unmatched = 0;

    for (const row of data as { metadata: Record<string, unknown> | null }[]) {
        if (row.metadata && row.metadata["matched"]) {
            matched++;
        } else {
            unmatched++;
        }
    }

    return { matched, unmatched, total: matched + unmatched };
}

/** Find stuck invoices (ap_inbox_queue) — excludes zombie records. */
async function getStuckInvoices(db: any): Promise<StuckRow[]> {
    const cutoff = hoursAgo(24);
    const { data, error } = await db
        .from("ap_inbox_queue")
        .select("message_id, extracted_json, status, created_at, updated_at")
        .in("status", ["ERROR_FORWARDING", "ERROR_PROCESSING"])
        .lt("updated_at", cutoff)  // older than 24h
        .not("extracted_json", "is", null)
        .limit(20);

    if (error || !data) {
        console.warn("[ap-health-report] getStuckInvoices query failed:", error?.message);
        return [];
    }

    // Double-check extracted_json is not null (zombie guard) and has substance
    return (data as any[])
        .filter(row => {
            const ej = row.extracted_json;
            if (!ej || typeof ej !== "object") return false;
            // Exclude old zombie records with no meaningful content
            return ej.from || ej.vendor_name || ej.subject || ej.invoice_number;
        })
        .map(row => {
            const ej = row.extracted_json || {};
            return {
                message_id: row.message_id || "unknown",
                subject: ej.subject || ej.invoice_number || "(no subject)",
                status: row.status,
                ageHours: Math.round(
                    (Date.now() - new Date(row.created_at).getTime()) / 3600000,
                ),
            };
        });
}

/** Count OCR issues: OCR_RETRY intents and zero-line-item outcomes. */
async function getOCRIssues(db: any): Promise<{ retries: number; zeroLineItems: number }> {
    const cutoff = hoursAgo(24);

    // 1. Count OCR_RETRY intents
    const { data: retryData, error: retryErr } = await db
        .from("ap_activity_log")
        .select("id", { count: "exact", head: true })
        .gte("created_at", cutoff)
        .eq("intent", "OCR_RETRY");

    if (retryErr) {
        console.warn("[ap-health-report] OCR retry count failed:", retryErr?.message);
    }

    // 2. Count zero_line_item outcomes (in metadata or action_taken)
    const { data: zeroData, error: zeroErr } = await db
        .from("ap_activity_log")
        .select("metadata, action_taken")
        .gte("created_at", cutoff);

    if (zeroErr) {
        console.warn("[ap-health-report] zero-line-item query failed:", zeroErr?.message);
    }

    const retries = retryData?.length ?? 0;

    let zeroLineItems = 0;
    if (zeroData) {
        for (const row of zeroData as Array<{ metadata: Record<string, unknown> | null; action_taken: string }>) {
            const action = (row.action_taken || "").toLowerCase();
            if (action.includes("0 line") || action.includes("zero line") || action.includes("no lines")) {
                zeroLineItems++;
                continue;
            }
            if (row.metadata) {
                const lineCount = row.metadata["line_items_count"] ?? row.metadata["lineCount"] ?? row.metadata["ocr_line_count"];
                if (lineCount !== undefined && lineCount !== null && Number(lineCount) === 0) {
                    zeroLineItems++;
                }
            }
        }
    }

    return { retries, zeroLineItems };
}

/** Find recent RECONCILIATION intents with issues. */
async function getReconciliationIssues(db: any): Promise<{ count: number; lines: string[] }> {
    const cutoff = hoursAgo(72); // look back 72h to catch weekend reconcile issues

    const { data, error } = await db
        .from("ap_activity_log")
        .select("email_from, email_subject, action_taken, created_at, metadata")
        .gte("created_at", cutoff)
        .eq("intent", "RECONCILIATION")
        .order("created_at", { ascending: false })
        .limit(20);

    if (error || !data) {
        console.warn("[ap-health-report] reconciliation query failed:", error?.message);
        return { count: 0, lines: [] };
    }

    const issues: string[] = [];
    for (const row of data as {
        email_from: string | null;
        email_subject: string | null;
        action_taken: string;
        created_at: string;
        metadata: Record<string, unknown> | null;
    }[]) {
        const action = (row.action_taken || "").toLowerCase();
        const hasError = action.includes("error") || action.includes("fail") || action.includes("reject");
        const hasWarning = action.includes("warn") || action.includes("skip");

        if (hasError || hasWarning) {
            const vendor = row.email_from || "unknown";
            const subject = row.email_subject || "(no subject)";
            const ts = new Date(row.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            });
            issues.push(`• ${vendor} — ${subject.slice(0, 50)} (${ts})`);
        }

        // Also check metadata for reconciliation issues
        if (row.metadata) {
            const verdict = row.metadata["verdict"];
            if (verdict === "rejected" || verdict === "needs_approval") {
                const vendor = row.email_from || "unknown";
                const ts = new Date(row.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                });
                issues.push(`• ${vendor} — verdict: ${verdict} (${ts})`);
            }
        }
    }

    return { count: issues.length, lines: Array.from(new Set(issues)).slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate the morning AP health report as Markdown (suitable for Telegram).
 *
 * Queries Supabase for the last 24 h of AP activity and returns a concise
 * summary covering six areas:
 *   1. Invoices processed (by intent)
 *   2. Match rate (matched vs unmatched)
 *   3. Stuck invoices
 *   4. OCR issues
 *   5. Reconciliation issues
 *   6. Overall status emoji + message
 */
/**
 * Read the last 24h of the LOCAL ap_local_forwards ledger for the morning
 * health report: how many forwarded, how many are missing an invoice#, OCR-gate
 * flags that were not a clean pass, and suspect (dispute/dunning/remittance)
 * subjects that were forwarded with a flag.
 *
 * Exported separately from generateAPHealthReport() so it can be unit-tested
 * against a mocked local DB — 2026-09-17 plan 4.2.
 *
 * @returns {{forwarded: number, nullInv: number, gateFlags: Array<{email_subject: string, note: string}>, suspects: Array<{email_subject: string, note: string}>}}
 *          Zeroed/empty result if the local ledger is unavailable.
 */
export async function getLocalForwardStats24h(): Promise<{
    /** False when the local ledger could not be read — callers MUST NOT render this as "clean". */
    available: boolean;
    forwarded: number;
    nullInv: number;
    /** Total non-pass gate flags in 24h (unaffected by the display LIMIT). */
    gateFlagCount: number;
    /** Total suspect-flagged forwards in 24h (unaffected by the display LIMIT). */
    suspectCount: number;
    gateFlags: Array<{ email_subject: string; note: string }>;
    suspects: Array<{ email_subject: string; note: string }>;
}> {
    const unavailable = {
        available: false,
        forwarded: 0,
        nullInv: 0,
        gateFlagCount: 0,
        suspectCount: 0,
        gateFlags: [],
        suspects: [],
    } as {
        available: boolean;
        forwarded: number;
        nullInv: number;
        gateFlagCount: number;
        suspectCount: number;
        gateFlags: Array<{ email_subject: string; note: string }>;
        suspects: Array<{ email_subject: string; note: string }>;
    };
    try {
        const { getLocalDb } = await import("@/lib/storage/local-db");
        const ldb = getLocalDb();
        const fw = ldb.prepare(
            `SELECT COUNT(*) AS forwarded,
                    SUM(CASE WHEN ocr_invoice_number IS NULL OR ocr_invoice_number = '' THEN 1 ELSE 0 END) AS nullInv
             FROM ap_local_forwards
             WHERE status = 'FORWARDED' AND forwarded_at >= datetime('now', '-1 day')`,
        ).get() as { forwarded: number; nullInv: number | null } | undefined;
        const gateFlags = ldb.prepare(
            `SELECT email_subject, substr(reconciliation_notes, 1, 80) AS note
             FROM ap_local_forwards
             WHERE reconciliation_notes LIKE '%ocr-gate:%'
               AND reconciliation_notes NOT LIKE '%ocr-gate:pass%'
               AND forwarded_at >= datetime('now', '-1 day')
             ORDER BY id DESC LIMIT 5`,
        ).all() as Array<{ email_subject: string; note: string }>;
        const suspects = ldb.prepare(
            `SELECT email_subject, substr(reconciliation_notes, 1, 60) AS note
             FROM ap_local_forwards
             WHERE reconciliation_notes LIKE '%suspect:%'
               AND forwarded_at >= datetime('now', '-1 day')
             ORDER BY id DESC LIMIT 5`,
        ).all() as Array<{ email_subject: string; note: string }>;
        // True totals — the arrays above are a DISPLAY sample capped at 5, so
        // reporting their length understated the real count (9 flags showed as 5).
        const gateTotal = ldb.prepare(
            `SELECT COUNT(*) AS n FROM ap_local_forwards
             WHERE reconciliation_notes LIKE '%ocr-gate:%'
               AND reconciliation_notes NOT LIKE '%ocr-gate:pass%'
               AND forwarded_at >= datetime('now', '-1 day')`,
        ).get() as { n: number } | undefined;
        const suspectTotal = ldb.prepare(
            `SELECT COUNT(*) AS n FROM ap_local_forwards
             WHERE reconciliation_notes LIKE '%suspect:%'
               AND forwarded_at >= datetime('now', '-1 day')`,
        ).get() as { n: number } | undefined;

        return {
            available: true,
            forwarded: Number(fw?.forwarded ?? 0),
            nullInv: Number(fw?.nullInv ?? 0),
            gateFlagCount: Number(gateTotal?.n ?? gateFlags?.length ?? 0),
            suspectCount: Number(suspectTotal?.n ?? suspects?.length ?? 0),
            gateFlags: gateFlags ?? [],
            suspects: suspects ?? [],
        };
    } catch {
        return unavailable;
    }
}

export async function generateAPHealthReport(): Promise<string> {
    const db = createClient();
    if (!db) {
        return "⚠️ *AP Health Report* — Supabase client unavailable (check env vars)";
    }

    const lines: string[] = [];
    let needsAttention = false;
    let actionRequired = false;

    // ── Header ──────────────────────────────────────────────────────────
    const today = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    });
    lines.push(`📋 *AP Pipeline Health — ${today}*`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── 1. Invoices Processed ───────────────────────────────────────────
    const byIntent = await countByIntent(db);
    const totalInvoices = byIntent.reduce((sum, i) => sum + i.count, 0);
    lines.push(`\n*📄 Invoices Processed (24h)*`);
    lines.push(`Total: **${totalInvoices}**`);

    if (byIntent.length === 0) {
        lines.push("_No activity in the last 24 hours._");
        needsAttention = true;
    } else {
        for (const { intent, count } of byIntent) {
            const emoji = intent === "INVOICE" ? "📩" :
                intent === "BILL_FORWARD" ? "➡️" :
                intent === "DROPSHIP" ? "📦" :
                intent === "OCR_RETRY" ? "🔍" :
                intent === "RECONCILIATION" ? "✅" :
                intent === "RECEIPT_PROMPT" ? "💬" :
                intent === "PO_ARRIVAL_AT_RISK" ? "⚠️" : "•";
            lines.push(`${emoji} **${intent}**: ${count}`);
        }
    }

    // ── 2. Match Rate ───────────────────────────────────────────────────
    const matchStats = await getMatchStats(db);
    if (matchStats && matchStats.total > 0) {
        const pct = Math.round((matchStats.matched / matchStats.total) * 100);
        lines.push(`\n*🔗 Match Rate (24h)*`);
        lines.push(`✅ Matched: **${matchStats.matched}**`);
        lines.push(`❌ Unmatched: **${matchStats.unmatched}**`);
        lines.push(`📊 Rate: **${pct}%**`);

        if (pct < 50 && matchStats.total >= 3) {
            lines.push(`⚠️ Low match rate — worth a look.`);
            actionRequired = true;
        } else if (pct < 75 && matchStats.total >= 3) {
            lines.push(`📋 Below target (>75% expected).`);
            needsAttention = true;
        }
    } else if (matchStats && matchStats.total === 0) {
        // No invoice activity — not necessarily a problem
    }

    // ── 3. Stuck Invoices ───────────────────────────────────────────────
    const stuck = await getStuckInvoices(db);
    lines.push(`\n*🛑 Stuck Invoices*`);
    if (stuck.length === 0) {
        lines.push("✅ No invoices stuck in ERROR_FORWARDING or ERROR_PROCESSING.");
    } else {
        lines.push(`⚠️ **${stuck.length}** invoice(s) stuck >24h:`);
        for (const s of stuck.slice(0, 5)) {
            const emoji = s.status === "ERROR_FORWARDING" ? "🚫" : "⚠️";
            lines.push(`${emoji} ${s.subject.slice(0, 50)} — ${s.status} (${s.ageHours}h)`);
        }
        if (stuck.length > 5) {
            lines.push(`_...and ${stuck.length - 5} more._`);
        }
        actionRequired = true;
    }

    // ── 4. OCR Issues ───────────────────────────────────────────────────
    const ocr = await getOCRIssues(db);
    lines.push(`\n*🔍 OCR Issues (24h)*`);
    if (ocr.retries === 0 && ocr.zeroLineItems === 0) {
        lines.push("✅ No OCR issues detected.");
    } else {
        if (ocr.retries > 0) {
            lines.push(`🔄 OCR Retries: **${ocr.retries}**`);
            needsAttention = true;
        }
        if (ocr.zeroLineItems > 0) {
            lines.push(`📄 Zero-line-item outcomes: **${ocr.zeroLineItems}**`);
            needsAttention = true;
        }
        if (ocr.retries > 5 || ocr.zeroLineItems > 3) {
            actionRequired = true;
        }
    }

    // ── 5. Reconciliation Issues ──────────────────────────────────────────
    const recon = await getReconciliationIssues(db);
    lines.push(`\n*⚖️ Reconciliation Issues (72h)*`);
    if (recon.count === 0) {
        lines.push("✅ No recent reconciliation issues.");
    } else {
        lines.push(`⚠️ **${recon.count}** issue(s) found:`);
        for (const l of recon.lines) {
            lines.push(l);
        }
        needsAttention = true;
    }

    // ── 5.5 Local forwards (24h) — the Gmail→Bill.com ledger (2026-09-17 plan 4.2).
    // Reads the LOCAL SQLite ap_local_forwards: what actually forwarded, gate
    // verdicts that were not clean, suspect subjects, and missing invoice#s.
    try {
        const { available, forwarded, nullInv, gateFlagCount, suspectCount, gateFlags, suspects } =
            await getLocalForwardStats24h();

        lines.push(`\n*📤 Forwarded to Bill.com (24h)*`);
        // A read failure is NOT a clean bill of health — say so explicitly.
        if (!available) {
            lines.push("_⚠️ Local ledger unavailable — forwarded count is UNKNOWN, not zero._");
            needsAttention = true;
        } else {
            lines.push(`Total: **${forwarded}**`);
            if (forwarded === 0) {
                lines.push("_No forwards in the last 24 hours._");
            }
            if ((nullInv || 0) > 0) {
                lines.push(`🔢 Missing invoice# in ledger: **${nullInv}**`);
                needsAttention = true;
            }
            if (gateFlagCount > 0) {
                lines.push(`🚧 OCR-gate flags: **${gateFlagCount}**${gateFlags.length < gateFlagCount ? ` (showing ${gateFlags.length})` : ""}`);
                for (const g of gateFlags) lines.push(`   ${g.email_subject.slice(0, 55)} — ${g.note}`);
                needsAttention = true;
            }
            if (suspectCount > 0) {
                lines.push(`🚩 Suspect subjects (forwarded+flagged): **${suspectCount}**${suspects.length < suspectCount ? ` (showing ${suspects.length})` : ""}`);
                for (const s of suspects) lines.push(`   ${s.email_subject.slice(0, 55)} — ${s.note}`);
                actionRequired = true;
            }
            if (forwarded === 0 && gateFlagCount === 0 && suspectCount === 0 && (nullInv || 0) === 0) {
                lines.push("✅ Clean.");
            }
        }
    } catch {
        lines.push(`\n*📤 Forwarded to Bill.com (24h)*\n_⚠️ Local ledger unavailable._`);
        needsAttention = true;
    }

    // ── 6. Overall Status ───────────────────────────────────────────────
    lines.push("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    if (actionRequired) {
        lines.push("⚠️ *Needs Attention* — check the items above.");
    } else if (needsAttention) {
        lines.push("📋 *Heads Up* — minor items flagged.");
    } else {
        lines.push("✅ *All Clear* — pipeline is healthy.");
    }

    return lines.join("\n");
}