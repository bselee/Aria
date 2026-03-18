/**
 * @file    reconciler.ts
 * @purpose Core invoice → PO reconciliation engine.
 *          Compares parsed invoice data against Finale PO details,
 *          identifies price/fee changes, applies safety guardrails,
 *          and orchestrates Finale writes (or flags for human review).
 * @author  Aria (Antigravity)
 * @created 2026-02-26
 * @updated 2026-03-18
 * @deps    finale/client, pdf/invoice-parser, supabase
 *
 * DECISION(2026-02-26): Price update safety guardrails:
 *   1. ≤3% variance → auto-approve, apply, Telegram notify
 *   2. >3% but <10x → flag for Telegram bot approval before applying
 *   3. >10x magnitude shift → REJECT outright (likely decimal error)
 *   4. Total PO impact >$500 delta → require manual approval regardless
 * 
 * These thresholds prevent catastrophic pricing errors like $2.60 → $26,000
 * which can happen from OCR misreads, decimal slips, or unit-of-measure confusion.
 *
 * DECISION(2026-03-18): Per-fee-type auto-approve caps.
 *   Freight is normal cost of business — auto-approve up to $2,000.
 *   Product pricing is where real discrepancies occur — keep those tight.
 *   See FEE_AUTO_APPROVE_BY_TYPE in RECONCILIATION_CONFIG for full mapping.
 */

import { FinaleClient } from "./client";
import { InvoiceData } from "../pdf/invoice-parser";
import { createClient } from "../supabase";
import { recordFeedback } from "../intelligence/feedback-loop";
import { getVendorPattern, storeVendorPattern } from "../intelligence/vendor-memory";

// ──────────────────────────────────────────────────
// PENDING APPROVAL STORE
// ──────────────────────────────────────────────────

/**
 * In-memory store for reconciliation results awaiting Telegram bot approval.
 * Keyed by a unique approval ID (e.g., "approval_<orderId>_<timestamp>").
 * Entries expire after 24 hours.
 *
 * DECISION(2026-02-26): Using Telegram bot (not Slack) for approvals per Will.
 * In-memory is acceptable because:
 *   - Volume is low (a few invoices per day)
 *   - If process restarts, unapproved items simply re-process next cycle
 *   - No persistent side-effects until explicitly approved
 */
export interface PendingApproval {
    id: string;
    result: ReconciliationResult;
    client: FinaleClient;
    createdAt: number;
    status: "pending" | "approved" | "rejected" | "expired";
}

const pendingApprovals = new Map<string, PendingApproval>();

/** Store a reconciliation result for bot approval */
export async function storePendingApproval(result: ReconciliationResult, client: FinaleClient): Promise<string> {
    const id = `recon_${result.orderId}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Cache the FinaleClient instance (not serializable to JSONB).
    // On reload after restart, we re-instantiate from env vars (stateless).
    // We omit ID for now since we'll get it from Supabase.

    // Persist to Supabase — this is the durable source of truth.
    let dbId = id; // Fallback or placeholder until SB returns it
    try {
        const supabase = createClient();
        if (supabase) {
            const { data, error } = await supabase.from("ap_pending_approvals").insert({
                invoice_number: result.invoiceNumber,
                vendor_name: result.vendorName,
                order_id: result.orderId,
                reconciliation_result: result as unknown as Record<string, unknown>,
                verdict_type: result.overallVerdict,
                telegram_chat_id: process.env.TELEGRAM_CHAT_ID ?? null,
                expires_at: expiresAt.toISOString(),
                status: "pending",
            }).select("id").single();
            
            if (error) throw error;
            if (data?.id) dbId = data.id;
        }
    } catch (err: any) {
        console.warn(`[reconciler] Failed to persist approval to Supabase: ${err.message}`);
        // Non-fatal — will fallback to in-memory ID but won't survive restart
    }

    pendingApprovals.set(dbId, {
        id: dbId,
        result,
        client,
        createdAt: Date.now(),
        status: "pending",
    });

    return dbId;
}

/**
 * After the Telegram message is sent, back-fill the message_id so that on
 * reload the bot can associate the button tap with the right approval row.
 * Called from ap-agent.ts sendApprovalRequest() after sendMessage() resolves.
 */
export async function updatePendingApprovalMessageId(approvalId: string, telegramMessageId: number): Promise<void> {
    try {
        const supabase = createClient();
        if (supabase) {
            await supabase.from("ap_pending_approvals")
                .update({ telegram_message_id: telegramMessageId.toString() })
                .eq("id", approvalId);
        }
    } catch { /* non-blocking */ }
}

/**
 * Re-hydrate in-memory pendingApprovals from Supabase after a bot restart.
 * Returns the list of entries so start-bot.ts can re-send Telegram approval prompts.
 *
 * DECISION(2026-03-10): The FinaleClient instance cannot be serialised to JSONB, so
 * restored entries get a fresh FinaleClient. Since FinaleClient is stateless (every
 * call re-authenticates via API key), this is safe.
 */
export async function loadPendingApprovalsFromSupabase(): Promise<Array<{
    approvalId: string;
    result: ReconciliationResult;
    telegramChatId: string;
    expiresAt: Date;
}>> {
    try {
        const supabase = createClient();
        if (!supabase) return [];

        // Filter by status='pending' and expires_at > now()
        const { data, error } = await supabase
            .from("ap_pending_approvals")
            .select("id, reconciliation_result, telegram_chat_id, expires_at")
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString());

        if (error || !data) {
            console.warn("[reconciler] loadPendingApprovalsFromSupabase query error:", error?.message);
            return [];
        }

        const restored: Array<{
            approvalId: string;
            result: ReconciliationResult;
            telegramChatId: string;
            expiresAt: Date;
        }> = [];

        for (const row of data) {
            try {
                const result = row.reconciliation_result as ReconciliationResult;
                const expiresAt = new Date(row.expires_at);
                const approvalId: string = row.id;

                // Skip if already in memory (process didn't actually restart — just a race)
                if (pendingApprovals.has(approvalId)) continue;

                // Re-hydrate into in-memory cache with a fresh FinaleClient
                const freshClient = new FinaleClient();
                pendingApprovals.set(approvalId, {
                    id: approvalId,
                    result,
                    client: freshClient,
                    createdAt: expiresAt.getTime() - 24 * 60 * 60 * 1000,
                    status: "pending",
                });

                // C3 FIX: No more setTimeout — expiry is column-based.
                // getPendingApproval() checks expires_at > now() on every read.

                restored.push({
                    approvalId,
                    result,
                    telegramChatId: row.telegram_chat_id ?? process.env.TELEGRAM_CHAT_ID ?? "",
                    expiresAt,
                });
            } catch (rowErr: any) {
                console.warn(`[reconciler] Skipping malformed ap_pending_approvals row: ${rowErr.message}`);
            }
        }

        return restored;
    } catch (err: any) {
        console.warn("[reconciler] loadPendingApprovalsFromSupabase failed:", err.message);
        return [];
    }
}

/**
 * Retrieve a pending approval by ID.
 * C3 FIX: Now async — reads from Supabase first, falls back to in-memory cache.
 * On restart, in-memory cache is empty but Supabase has the row.
 */
export async function getPendingApproval(id: string): Promise<PendingApproval | undefined> {
    // Fast path: check in-memory cache first (same-session)
    const cached = pendingApprovals.get(id);
    if (cached && cached.status === "pending") return cached;

    // Slow path: read from Supabase (survives restart)
    try {
        const supabase = createClient();
        if (!supabase) return undefined;

        const { data } = await supabase.from("ap_pending_approvals")
            .select("*")
            .eq("id", id)
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString())
            .single();

        if (!data) return undefined;

        // Re-instantiate FinaleClient (stateless — reads creds from env)
        const client = new FinaleClient();
        const entry: PendingApproval = {
            id: data.id,
            result: data.reconciliation_result as ReconciliationResult,
            client,
            createdAt: new Date(data.created_at).getTime(),
            status: "pending",
        };
        // Populate the in-memory cache for subsequent reads
        pendingApprovals.set(id, entry);
        return entry;
    } catch {
        return undefined;
    }
}

/** Mark a pending approval as approved and apply changes */
export async function approvePendingReconciliation(id: string): Promise<{
    success: boolean;
    applied: string[];
    errors: string[];
    message: string;
}> {
    // C3 FIX: Use async getPendingApproval (reads from Supabase if not in memory)
    const entry = await getPendingApproval(id);
    if (!entry) {
        return { success: false, applied: [], errors: [], message: "Approval not found or expired." };
    }
    if (entry.status !== "pending") {
        return { success: false, applied: [], errors: [], message: `Already ${entry.status}.` };
    }

    // Approve ALL needs_approval price items
    const approvedPriceItems = entry.result.priceChanges
        .filter(pc => pc.verdict === "needs_approval")
        .map(pc => pc.productId);

    // Approve ALL needs_approval fee items
    const approvedFeeTypes = entry.result.feeChanges
        .filter(fc => fc.verdict === "needs_approval")
        .map(fc => fc.feeType);

    // C1 FIX (approve path): Write "pending" audit entry BEFORE Finale writes.
    let pendingLogId: string | null = null;
    try {
        const sbPre = createClient();
        if (sbPre) {
            const { data: pendingLog } = await sbPre.from("ap_activity_log").insert({
                email_from: entry.result.vendorName,
                email_subject: `Invoice ${entry.result.invoiceNumber} → PO ${entry.result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: "Pending — applying approved changes to Finale...",
                metadata: { invoiceNumber: entry.result.invoiceNumber, orderId: entry.result.orderId, status: "pending", approvalId: id },
            }).select("id").single();
            pendingLogId = pendingLog?.id ?? null;
        }
    } catch { /* proceed — Finale write is still safe */ }

    const applyResult = await applyReconciliation(
        entry.result, entry.client, approvedPriceItems, approvedFeeTypes
    );
    entry.status = "approved";
    pendingApprovals.delete(id);

    // Update Supabase status to "approved"
    try {
        const sbStatus = createClient();
        if (sbStatus) {
            await sbStatus.from("ap_pending_approvals")
                .update({ status: "approved", updated_at: new Date().toISOString() })
                .eq("id", id);
        }
    } catch { /* non-blocking */ }

    // Optional: We can keep it in DB for audit trail, so omitting the delete!

    // Write RECONCILIATION entry to ap_activity_log for duplicate detection.
    // Future re-processes of this invoice+PO combo will hit checkDuplicateReconciliation().
    try {
        const supabase = createClient();
        if (supabase) {
            // Build a final report with approval updated to reflect Will's manual approval
            const approvedReport: ReconciliationReport | undefined = entry.result.report
                ? {
                    ...entry.result.report,
                    approval: {
                        method: "manual",
                        approved_by: "Will",
                        approved_at: new Date().toISOString(),
                    },
                }
                : undefined;

            await supabase.from("ap_activity_log").insert({
                email_from: entry.result.vendorName,
                email_subject: `Invoice ${entry.result.invoiceNumber} → PO ${entry.result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: `Approved via Telegram: ${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped, ${applyResult.errors.length} errors`,
                metadata: {
                    ...buildAuditMetadata(entry.result, applyResult, "telegram"),
                    approvalId: id,
                },
                reconciliation_report: approvedReport ?? null,
            });

            // LEARNING: Write vendor_name back to the purchase_orders row so that
            // future exact PO# matches (Strategy 1 in matcher) have vendor data.
            // Also helps watchdog product catalog builds that rely on this table.
            if (entry.result.vendorName && entry.result.orderId) {
                await supabase.from("purchase_orders").upsert({
                    po_number: entry.result.orderId,
                    vendor_name: entry.result.vendorName,
                    status: "open",
                }, { onConflict: "po_number", ignoreDuplicates: false });
            }

            // Update structured invoice state
            await supabase.from("invoices").update({
                status: "reconciled"
            })
                .eq("invoice_number", entry.result.invoiceNumber)
                .ilike("vendor_name", `%${entry.result.vendorName}%`);
        }
    } catch (logErr: any) {
        console.warn(`⚠️ Failed to log approval to activity log: ${logErr.message}`);
        // Fix 2: Alert Will — Finale was already updated but the audit log write failed.
        // Without this log entry, checkDuplicateReconciliation() will find nothing on the
        // next invoice poll and may attempt to reconcile the same invoice again.
        try {
            const { Telegraf } = await import("telegraf");
            const alertBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
            await alertBot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID!,
                `🚨 AUDIT LOG FAILURE — approval for PO \`${entry.result.orderId}\` was applied to Finale but NOT logged to Supabase.\n⚠️ Risk of double-reconciliation on next invoice poll.\nManually verify PO in Finale and mark invoice as processed.`
            );
        } catch { /* non-blocking */ }
    }

    // Pinecone: remember this approval outcome with full cost detail (non-blocking)
    setImmediate(async () => {
        try {
            const { remember } = await import("../intelligence/memory");
            const vendorSlug = entry.result.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");

            // Build enriched content with price changes and fee breakdowns
            const priceDetail = entry.result.priceChanges
                .filter(pc => pc.verdict !== "no_match")
                .map(pc => `${pc.description}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)}`)
                .join(", ");
            const feeDetail = entry.result.feeChanges
                .map(fc => `${fc.feeType}: $${fc.amount.toFixed(2)}`)
                .join(", ");
            const carrier = entry.result.trackingUpdate?.carrierName ?? "unknown carrier";
            const tracking = entry.result.trackingUpdate?.trackingNumbers?.join(", ") ?? "no tracking";

            await remember({
                category: "decision",
                content: `PO ${entry.result.orderId} reconciliation approved by Will. Vendor: ${entry.result.vendorName}. Invoice: ${entry.result.invoiceNumber}. ` +
                    `Price changes: ${priceDetail || "none"}. ` +
                    `Fees: ${feeDetail || "none"}. ` +
                    `Carrier: ${carrier}. Tracking: ${tracking}. ` +
                    `Total impact: $${(entry.result.totalDollarImpact ?? 0).toFixed(2)}. ${applyResult.applied.length} applied, ${applyResult.errors.length} errors.`,
                tags: ["reconciliation", "approved", "price_change", entry.result.orderId, vendorSlug],
                source: "email",
                relatedTo: entry.result.vendorName,
                priority: "normal",
            });
        } catch { /* non-blocking — never fail the approval flow */ }
    });

    // Kaizen: record correction feedback (Pillar 1 — Correction Capture)
    recordFeedback({
        category: "correction",
        eventType: "reconciliation_approved",
        agentSource: "reconciler",
        subjectType: "po",
        subjectId: entry.result.orderId,
        prediction: {
            overallVerdict: entry.result.overallVerdict,
            totalDollarImpact: entry.result.totalDollarImpact,
            priceChangeCount: entry.result.priceChanges.length,
        },
        actualOutcome: { applied: applyResult.applied.length, errors: applyResult.errors.length },
        accuracyScore: 1.0,
        userAction: "approved",
        contextData: { invoiceNumber: entry.result.invoiceNumber, vendor: entry.result.vendorName },
    }).catch(() => { /* non-blocking */ });

    return {
        success: true,
        applied: applyResult.applied,
        errors: applyResult.errors,
        message: `✅ Applied ${applyResult.applied.length} change(s) to PO ${entry.result.orderId}.`,
    };
}

/** Reject a pending reconciliation */
export async function rejectPendingReconciliation(id: string): Promise<string> {
    // C3 FIX: Use async getPendingApproval (reads from Supabase if not in memory)
    const entry = await getPendingApproval(id);
    if (!entry) return "Approval not found or expired.";
    if (entry.status !== "pending") return `Already ${entry.status}.`;

    entry.status = "rejected";
    pendingApprovals.delete(id);

    // Update Supabase status to "rejected"
    try {
        const sb = createClient();
        if (sb) await sb.from("ap_pending_approvals").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", id);
    } catch { /* non-blocking */ }

    // Write to ap_activity_log so checkDuplicateReconciliation() catches future
    // re-processing of the same invoice — rejections must be "sticky".
    try {
        const supabase = createClient();
        if (supabase) {
            // Build a final report reflecting Will's rejection decision
            const rejectedReport: ReconciliationReport | undefined = entry.result.report
                ? {
                    ...entry.result.report,
                    approval: {
                        method: "rejected",
                        approved_by: "Will",
                        approved_at: new Date().toISOString(),
                    },
                }
                : undefined;

            await supabase.from("ap_activity_log").insert({
                email_from: entry.result.vendorName,
                email_subject: `Invoice ${entry.result.invoiceNumber} → PO ${entry.result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: "Rejected via Telegram — no changes applied",
                metadata: {
                    invoiceNumber: entry.result.invoiceNumber,
                    orderId: entry.result.orderId,
                    approvalId: id,
                    verdict: "rejected",
                },
                reconciliation_report: rejectedReport ?? null,
            });

            // Update structured invoice state
            await supabase.from("invoices").update({
                status: "matched_review"
            })
                .eq("invoice_number", entry.result.invoiceNumber)
                .ilike("vendor_name", `%${entry.result.vendorName}%`);
        }
    } catch (logErr: any) {
        console.warn(`⚠️ Failed to log rejection to activity log: ${logErr.message}`);
        // Fix 8: Alert Will — rejection was actioned but the audit log write failed.
        // Without this log entry, checkDuplicateReconciliation() will find nothing on the
        // next invoice poll and may attempt to reconcile the same invoice again.
        try {
            const { Telegraf } = await import("telegraf");
            const alertBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
            await alertBot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID!,
                `🚨 AUDIT LOG FAILURE — rejection for PO \`${entry.result.orderId}\` was actioned but NOT logged to Supabase.\n⚠️ Risk of duplicate reconciliation attempt on next invoice poll.\nNo Finale changes were made, but manually verify the invoice is not re-processed.`
            );
        } catch { /* non-blocking */ }
    }

    // Pinecone: remember this rejection with full cost detail for future context (non-blocking)
    setImmediate(async () => {
        try {
            const { remember } = await import("../intelligence/memory");
            const vendorSlug = entry.result.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");

            const priceDetail = entry.result.priceChanges
                .filter(pc => pc.verdict !== "no_match")
                .map(pc => `${pc.description}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)}`)
                .join(", ");
            const feeDetail = entry.result.feeChanges
                .map(fc => `${fc.feeType}: $${fc.amount.toFixed(2)}`)
                .join(", ");

            await remember({
                category: "decision",
                content: `PO ${entry.result.orderId} reconciliation REJECTED by Will. No changes applied. Vendor: ${entry.result.vendorName}. Invoice: ${entry.result.invoiceNumber}. ` +
                    `Would-have-been price changes: ${priceDetail || "none"}. ` +
                    `Would-have-been fees: ${feeDetail || "none"}. ` +
                    `Impact would have been: $${(entry.result.totalDollarImpact ?? 0).toFixed(2)}.`,
                tags: ["reconciliation", "rejected", "price_change", entry.result.orderId, vendorSlug],
                source: "email",
                relatedTo: entry.result.vendorName,
                priority: "high",
            });
        } catch { /* non-blocking */ }
    });

    // Kaizen: record correction feedback (Pillar 1 — Correction Capture)
    recordFeedback({
        category: "correction",
        eventType: "reconciliation_rejected",
        agentSource: "reconciler",
        subjectType: "po",
        subjectId: entry.result.orderId,
        prediction: {
            overallVerdict: entry.result.overallVerdict,
            totalDollarImpact: entry.result.totalDollarImpact,
            priceChangeCount: entry.result.priceChanges.length,
        },
        actualOutcome: { rejected: true, reason: "manual_rejection" },
        accuracyScore: 0.0,
        userAction: "rejected",
        contextData: { invoiceNumber: entry.result.invoiceNumber, vendor: entry.result.vendorName },
    }).catch(() => { /* non-blocking */ });

    return `❌ Rejected changes to PO ${entry.result.orderId}. No updates applied.`;
}

// ──────────────────────────────────────────────────
// DUPLICATE DETECTION
// ──────────────────────────────────────────────────

/**
 * Check whether this invoice+PO combination has already been reconciled.
 * Queries ap_activity_log for a prior RECONCILIATION entry with matching
 * invoiceNumber and orderId in the metadata JSONB column.
 *
 * DECISION(2026-02-26): Fail-open on Supabase errors — if the check itself
 * fails we proceed rather than blocking a legitimate first-time reconciliation.
 * The trade-off: occasional double-process is safer than permanent blockage.
 *
 * NOTE: Approvals via Telegram (approvePendingReconciliation) also write here
 * so that they are caught on any subsequent re-processing of the same email.
 */
async function checkDuplicateReconciliation(
    invoice: InvoiceData,
    orderId: string
): Promise<{ isDuplicate: boolean; processedAt?: string; actionTaken?: string }> {
    try {
        const supabase = createClient();
        if (!supabase) return { isDuplicate: false };

        const invoiceDate = invoice.date ? new Date(invoice.date) : new Date();

        // 1. Fuzzy Vendor Name, Exact Invoice Number
        const vendorPattern = `%${invoice.vendorName.trim()}%`;
        const { data: exactMatch, error: exactErr } = await supabase
            .from("ap_activity_log")
            .select("created_at, action_taken, metadata")
            .eq("intent", "RECONCILIATION")
            .filter("metadata->>invoiceNumber", "eq", invoice.invoiceNumber)
            .ilike("metadata->>vendorName", vendorPattern)
            .order("created_at", { ascending: false })
            .limit(1);

        if (!exactErr && exactMatch && exactMatch.length > 0) {
            const entry = exactMatch[0];
            const metaTotal = entry.metadata?.total !== undefined ? Number(entry.metadata.total) : null;
            
            // Fuzzy $1 tolerance if there's a difference
            if (metaTotal !== null && invoice.total !== null) {
                 if (Math.abs(metaTotal - invoice.total) <= 1.0) {
                     const processedAt = new Date(entry.created_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
                     return { isDuplicate: true, processedAt, actionTaken: entry.action_taken };
                 }
            } else {
                 const processedAt = new Date(entry.created_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
                 return { isDuplicate: true, processedAt, actionTaken: entry.action_taken };
            }
        }

        return { isDuplicate: false };


    } catch (err: any) {
        console.warn(`⚠️ Duplicate check failed, proceeding anyway: ${err.message}`);
        return { isDuplicate: false };
    }
}

// ──────────────────────────────────────────────────
// CONFIGURATION — Safety thresholds
// ──────────────────────────────────────────────────

/**
 * DECISION(2026-02-26): Safety thresholds for price changes.
 * These are intentionally conservative — better to ask than to auto-apply
 * a catastrophic price change to Finale.
 */
const RECONCILIATION_CONFIG = {
    /** ≤3% price change → auto-approve without human review */
    AUTO_APPROVE_PERCENT: 0.03,

    /**
     * Maximum multiplier before outright rejection.
     * If new_price / old_price > 10 or < 0.1, the price change is
     * assumed to be a decimal error (e.g., $2.60 → $26,000).
     * These are NEVER auto-applied — they require explicit correction.
     */
    MAGNITUDE_CEILING: 10,

    /**
     * If total PO dollar impact exceeds this, require manual approval
     * regardless of per-line percentage.
     * Example: 100 units × $0.50 price increase = $50 (auto-OK)
     *          100 units × $10.00 price increase = $1000 (needs approval)
     */
    TOTAL_IMPACT_CAP_DOLLARS: 500,

    /**
     * Maximum individual line item price we'll ever auto-approve a change for.
     * Anything above this unit price gets manual review no matter the % change.
     * Prevents silent updates on high-value items.
     */
    HIGH_VALUE_THRESHOLD: 5000,

    /**
     * DECISION(2026-03-18): Per-fee-type auto-approve caps.
     * Freight is normal cost of business ($200–$1,500 for most LTL).
     * Product pricing is where real discrepancies occur — keep those tight.
     * The delta (invoice fee − existing PO fee) is what's measured.
     */
    FEE_AUTO_APPROVE_BY_TYPE: {
        FREIGHT:      2000,   // LTL/parcel is routine. Flag only full-truckload territory.
        SHIPPING:     500,    // Fuel surcharge — proportional to freight, smaller.
        TAX:          1000,   // Sales tax is formulaic. Either correct or wildly off.
        TARIFF:       250,    // Duties/tariffs are unpredictable — keep tight.
        LABOR:        250,    // Unusual charges — always review.
        DISCOUNT_20:  500,    // Discounts reduce the total — lower risk.
    } as Record<string, number>,

    /** Fallback cap for fee types not listed above. */
    FEE_AUTO_APPROVE_DEFAULT: 250,

    /**
     * M2 FIX: Balance check gating thresholds.
     * Small gaps (>$1 / >2%) are non-blocking warnings.
     * Large gaps (>$5 / >5%) force needs_approval — extraction is untrustworthy.
     */
    BALANCE_WARN_DOLLARS: 1.00,
    BALANCE_WARN_PCT: 0.02,
    BALANCE_GATE_DOLLARS: 5.00,
    BALANCE_GATE_PCT: 0.05,

    /**
     * Jaccard word-overlap threshold for fuzzy vendor name matching.
     * 0.5 = at least half the unique words appear in both names.
     * Below this, correlation falls back to PO# reference and SKU overlap.
     */
    VENDOR_FUZZY_THRESHOLD: 0.5,
} as const;

// ──────────────────────────────────────────────────
// FEE AUTO-APPROVE HELPERS
// ──────────────────────────────────────────────────

/**
 * Look up the auto-approve dollar cap for a given fee type.
 * Returns the type-specific cap if configured, otherwise the default.
 *
 * @param feeType - One of FREIGHT, SHIPPING, TAX, TARIFF, LABOR, DISCOUNT_20
 * @returns Dollar amount above which the fee delta requires manual approval
 */
function getFeeAutoApproveCap(feeType: string): number {
    return RECONCILIATION_CONFIG.FEE_AUTO_APPROVE_BY_TYPE[feeType]
        ?? RECONCILIATION_CONFIG.FEE_AUTO_APPROVE_DEFAULT;
}

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type ReconciliationVerdict =
    | "auto_approve"      // ≤3% change, safe to apply automatically
    | "needs_approval"    // >3% change, send to Telegram for approval
    | "rejected"          // Magnitude error detected, do NOT apply
    | "duplicate"         // Invoice already reconciled — do not re-apply
    | "no_change"         // Prices match, nothing to do
    | "no_match";         // Could not find matching line item

export interface PriceChange {
    productId: string;
    description: string;
    poPrice: number;
    invoicePrice: number;
    quantity: number;
    percentChange: number;
    dollarImpact: number;       // (invoicePrice - poPrice) × quantity
    verdict: ReconciliationVerdict;
    reason: string;
}

export interface FeeChange {
    feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES;
    amount: number;
    description: string;
    existingAmount: number;     // 0 if new fee
    isNew: boolean;
    verdict: "auto_approve" | "needs_approval";
    reason: string;
}

export interface TrackingUpdate {
    trackingNumbers: string[];
    shipDate?: string;
    carrierName?: string;
}

// ──────────────────────────────────────────────────
// RECONCILIATION REPORT — accounting audit trail
// ──────────────────────────────────────────────────

/**
 * Structured audit report produced at the end of every reconcileInvoiceToPO() call.
 * Written into ap_activity_log.reconciliation_report (JSONB) for accounting compliance.
 * All fields map 1:1 to data already computed during reconciliation — no extra API calls.
 */
export interface ReconciliationReport {
    generated_at: string;           // ISO timestamp
    invoice: {
        number: string | null;
        vendor: string | null;
        total: number | null;
        date: string | null;
        po_number: string | null;
        line_count: number;
        freight: number | null;
        tax: number | null;
        tariff: number | null;
        labor: number | null;
        discount: number | null;
    };
    finale_po: {
        order_id: string;
        vendor: string | null;
        total: number | null;
        line_count: number;
    } | null;
    changes: Array<{
        sku: string;
        description: string;
        field: string;
        invoice_value: number | string | null;
        po_value: number | string | null;
        disposition: string;    // auto_approve | needs_approval | no_change | rejected | no_match
        note?: string;
    }>;
    fees_applied: {
        freight: number | null;
        tax: number | null;
        tariff: number | null;
        labor: number | null;
        discount: number | null;
    };
    approval: {
        method: "auto" | "manual" | "pending" | "rejected";
        approved_by?: string;   // "system" | "Will"
        approved_at?: string;
    };
    balance_check: {
        valid: boolean;
        gap?: number;
        message?: string;
    };
    warnings: string[];
    match_strategy?: string;    // M4: Which PO matching strategy found the match
}

export interface ReconciliationResult {
    orderId: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceTotal: number | null;
    priceChanges: PriceChange[];
    feeChanges: FeeChange[];
    trackingUpdate: TrackingUpdate | null;
    overallVerdict: ReconciliationVerdict;
    summary: string;
    totalDollarImpact: number;
    autoApplicable: boolean;    // True only if ALL changes are auto_approve or no_change
    warnings: string[];         // Non-blocking issues (vendor fuzzy match, low-confidence match, etc.)
    vendorNote?: string;        // Set when vendor correlation used non-name signal to confirm
    notes?: string;             // Non-blocking informational notes (e.g., balance validation warning)
    report?: ReconciliationReport;  // Structured audit report — populated at end of reconcileInvoiceToPO()
}

// ──────────────────────────────────────────────────
// INVOICE BALANCE VALIDATION
// ──────────────────────────────────────────────────

/**
 * Validates that the extracted line items + fees sum to the invoice total.
 * A significant gap (>2% of total AND >$1.00) is a signal that OCR or LLM
 * extraction dropped a line item, misread a fee, or garbled the total.
 *
 * This is a NON-BLOCKING check — it returns a warning but never aborts
 * reconciliation. The intent is to surface extraction unreliability early
 * so the reconciliation result can carry that context in `notes`.
 *
 * @param invoice  Parsed invoice data
 * @returns        { valid, gap, message } — valid=false means the balance gap
 *                 is material and the extraction may not be trustworthy.
 */
export function validateInvoiceBalance(
    invoice: InvoiceData
): { valid: boolean; gap: number; message: string } {
    if (!invoice.total || invoice.total <= 0) {
        return { valid: true, gap: 0, message: "Invoice total is zero — balance check skipped" };
    }

    // Sum only product lines (skip adjustment lines with qty=0 or unitPrice=0)
    const lineTotal = invoice.lineItems
        .filter(li => (li.qty ?? 0) > 0 && (li.unitPrice ?? 0) > 0)
        .reduce((sum, li) => sum + (li.qty ?? 0) * (li.unitPrice ?? 0), 0);

    const fees =
        (invoice.freight ?? 0) +
        (invoice.tax ?? 0) +
        (invoice.tariff ?? 0) +
        (invoice.labor ?? 0) +
        (invoice.fuelSurcharge ?? 0);

    const discountOffset = invoice.discount ?? 0;  // already a positive number per schema

    const computed = lineTotal + fees - discountOffset;
    const gap = Math.abs(computed - invoice.total);
    const gapPct = gap / invoice.total;

    // M2 FIX: Two-tier gating — small gaps warn, large gaps block
    if (gapPct > RECONCILIATION_CONFIG.BALANCE_GATE_PCT && gap > RECONCILIATION_CONFIG.BALANCE_GATE_DOLLARS) {
        return {
            valid: false,
            gap,
            severity: "gate" as const,
            message: `⛔ Large balance gap — extraction unreliable (computed $${computed.toFixed(2)} vs stated $${invoice.total.toFixed(2)}, gap $${gap.toFixed(2)} / ${(gapPct * 100).toFixed(1)}%). Forcing manual approval.`,
        };
    }
    if (gapPct > RECONCILIATION_CONFIG.BALANCE_WARN_PCT && gap > RECONCILIATION_CONFIG.BALANCE_WARN_DOLLARS) {
        return {
            valid: false,
            gap,
            severity: "warn" as const,
            message: `⚠️ Extraction may be unreliable — line items + fees don't balance to invoice total (computed $${computed.toFixed(2)} vs stated $${invoice.total.toFixed(2)}, gap $${gap.toFixed(2)} / ${(gapPct * 100).toFixed(1)}%)`,
        };
    }

    return { valid: true, gap, severity: "ok" as const, message: "Invoice balance checks out" };
}

// ──────────────────────────────────────────────────
// CORE RECONCILIATION
// ──────────────────────────────────────────────────

/**
 * Compare an invoice against a Finale PO and determine what needs updating.
 * Does NOT mutate Finale — only produces a reconciliation plan.
 *
 * Guard sequence (fast-fail order):
 *   0. Duplicate detection   — already reconciled? Stop immediately.
 *   1. Vendor correlation    — does this invoice belong to this PO?
 *   2. Quantity overbill     — per-line check inside reconcileLineItems()
 *   3. Fee threshold         — per-fee check inside reconcileFees()
 *   4. Price % + magnitude   — existing guardrails in evaluatePriceChange()
 *   5. Total impact cap      — aggregate dollar check
 *
 * @param invoice   - Parsed invoice data from the LLM extractor
 * @param orderId   - The Finale PO orderId to reconcile against
 * @param client    - FinaleClient instance for reading PO data
 * @returns ReconciliationResult with detailed change plan and safety verdicts
 */
export async function reconcileInvoiceToPO(
    invoice: InvoiceData,
    orderId: string,
    client: FinaleClient,
    matchStrategy?: string       // M4: Which strategy matched this invoice to PO
): Promise<ReconciliationResult> {
    const warnings: string[] = [];

    // ── Balance validation ─────────────────────────────────────────────────────
    // M2 FIX: Two tiers — "warn" is non-blocking, "gate" forces needs_approval.
    // A large balance gap means OCR extraction is untrustworthy.
    const balanceCheck = validateInvoiceBalance(invoice);
    if (!balanceCheck.valid) {
        console.warn(`[reconciler] ⚠️ Balance validation: ${balanceCheck.message}`);
    }
    const balanceNote = balanceCheck.valid ? undefined : balanceCheck.message;
    // M2 FIX: If the gap is large enough to be unreliable, force manual review.
    const balanceGatesApproval = balanceCheck.severity === "gate";

    // ── H2: Vendor memory fee label consult ────────────────────────────────────
    // Fetch any vendor-specific fee label → Finale fee type mappings from Pinecone.
    // Non-fatal: if vendor memory is unavailable, fall back to hardcoded defaults.
    let vendorFeeLabelMap: Record<string, string> = {};
    try {
        const vendorPattern = await getVendorPattern(invoice.vendorName);
        if (vendorPattern?.feeLabelMap) {
            vendorFeeLabelMap = vendorPattern.feeLabelMap;
            console.log(`[reconciler] H2: Loaded ${Object.keys(vendorFeeLabelMap).length} vendor fee label mappings for ${invoice.vendorName}`);
        }
    } catch {
        // Non-fatal — vendor memory is advisory only
    }

    // ── Guard 0: Duplicate detection ──────────────────────────────────────────
    // Fast-fail before any Finale reads. If this invoice+PO combo was already
    // reconciled, stop cold and alert loudly — do not re-apply anything.
    const dupeCheck = await checkDuplicateReconciliation(invoice, orderId);
    if (dupeCheck.isDuplicate) {
        const dupeSummary =
            `🔁 DUPLICATE INVOICE: Invoice #${invoice.invoiceNumber} was already ` +
            `reconciled against PO ${orderId} on ${dupeCheck.processedAt}. ` +
            `No changes applied.\nPrior action: ${dupeCheck.actionTaken}`;
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "duplicate",
            summary: dupeSummary,
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: [],
            report: buildReconciliationReport(invoice, null, [], [], balanceCheck, "duplicate", []),
        };
    }

    // ── Fetch PO ───────────────────────────────────────────────────────────────
    const poSummary = await client.getOrderSummary(orderId);
    if (!poSummary) {
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "no_match",
            summary: `⚠️ Could not fetch PO ${orderId} from Finale`,
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: [],
            report: buildReconciliationReport(invoice, null, [], [], balanceCheck, "no_match", []),
        };
    }

    // ── Guard 0.5: Empty PO line items ─────────────────────────────────────────
    // Fix 6: A PO with 0 line items is a template, data issue, or wrong PO.
    // Silently returning no_change would mark the invoice as processed with nothing done.
    // Surface it as needs_approval so Will sees it and can investigate.
    if (!poSummary.items || poSummary.items.length === 0) {
        const emptyPoWarnings = ["PO has 0 line items in Finale — possible data issue or template PO. Manual review required."];
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "needs_approval",
            summary: `⚠️ PO ${orderId} has no line items in Finale — possible data issue or template PO. Invoice not reconciled.`,
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: emptyPoWarnings,
            report: buildReconciliationReport(invoice, poSummary, [], [], balanceCheck, "needs_approval", emptyPoWarnings),
        };
    }

    // ── Guard 1: Vendor correlation ────────────────────────────────────────────
    // Verify the invoice vendor plausibly matches this PO's supplier.
    // Falls back to PO# reference and SKU overlap when names diverge.
    const vendorCorrelation = validateVendorCorrelation(invoice, poSummary, orderId);
    let vendorNote: string | undefined;

    if (!vendorCorrelation.pass) {
        // Low confidence — no name, PO#, or SKU evidence. Escalate for human review.
        const vendorMismatchWarnings = [vendorCorrelation.note];
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "needs_approval",
            summary: buildReconciliationSummary(
                orderId, invoice, [], [], null, 0, "needs_approval",
                vendorMismatchWarnings
            ),
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: vendorMismatchWarnings,
            vendorNote: vendorCorrelation.note,
            report: buildReconciliationReport(invoice, poSummary, [], [], balanceCheck, "needs_approval", vendorMismatchWarnings),
        };
    } else if (vendorCorrelation.confidence !== "high") {
        // Medium confidence — proceed but surface the mismatch in the summary.
        // Dollar-impact escalation for medium confidence is applied after totalDollarImpact
        // is calculated (see step 5.5 below).
        warnings.push(vendorCorrelation.note);
        vendorNote = vendorCorrelation.note;
    }

    // 1. Compare line item prices (includes Guard 2: overbill check)
    const priceChanges = reconcileLineItems(invoice, poSummary);

    // 2. Compare fees (includes Guard 3: fee dollar threshold)
    const feeChanges = reconcileFees(invoice, poSummary, vendorFeeLabelMap);

    // 3. Check for tracking info
    const trackingUpdate = reconcileTracking(invoice);

    // 4. Calculate total dollar impact
    const totalDollarImpact =
        priceChanges.reduce((sum, pc) => sum + Math.abs(pc.dollarImpact), 0) +
        feeChanges.reduce((sum, fc) => sum + Math.abs(fc.amount - fc.existingAmount), 0);

    // 5. Apply total-impact safety check
    //    Even if individual lines are ≤3%, if aggregate PO impact > $500, escalate
    if (totalDollarImpact > RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS) {
        for (const pc of priceChanges) {
            if (pc.verdict === "auto_approve") {
                pc.verdict = "needs_approval";
                pc.reason += ` | Total PO impact $${totalDollarImpact.toFixed(2)} exceeds $${RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS} cap`;
            }
        }
        // Fix 1: Also escalate fee changes — freight/tariff/tax must not auto-apply
        // when the total PO impact is high, even if each fee delta is individually small.
        for (const fc of feeChanges) {
            if (fc.verdict === "auto_approve") {
                fc.verdict = "needs_approval";
                fc.reason += " | Total PO impact exceeds $500 threshold — manual approval required";
            }
        }
    }

    // 5.5 Fix 3: Medium vendor confidence + non-trivial dollar impact → require approval.
    // Vendor was matched via brand-word or PO# signal (not Jaccard ≥ 0.5), meaning there
    // is real risk of a name-variant mismatch. If the dollar impact is material (≥$100),
    // don't silently auto-apply — surface it for Will to confirm.
    if (vendorCorrelation.confidence !== "high" && totalDollarImpact >= 100) {
        for (const pc of priceChanges) {
            if (pc.verdict === "auto_approve") {
                pc.verdict = "needs_approval";
                pc.reason += " | Medium vendor confidence — manual confirmation required";
            }
        }
        for (const fc of feeChanges) {
            if (fc.verdict === "auto_approve") {
                fc.verdict = "needs_approval";
                fc.reason += " | Medium vendor confidence — manual confirmation required";
            }
        }
    }

    // 6. Determine overall verdict — fee verdicts now count alongside price verdicts
    const priceVerdicts = priceChanges.map(pc => pc.verdict);
    const feeVerdicts = feeChanges.map(fc => fc.verdict);
    let overallVerdict: ReconciliationVerdict = "no_change";

    if (priceVerdicts.includes("rejected")) {
        overallVerdict = "rejected";
    } else if (priceVerdicts.includes("needs_approval") || feeVerdicts.includes("needs_approval")) {
        overallVerdict = "needs_approval";
    } else if (priceVerdicts.includes("auto_approve") || feeChanges.length > 0 || trackingUpdate) {
        overallVerdict = "auto_approve";
    }

    // M2 FIX: If balance gap is large, override auto_approve → needs_approval.
    // Large gap = OCR extraction is unreliable, don't apply changes silently.
    if (balanceGatesApproval && overallVerdict === "auto_approve") {
        overallVerdict = "needs_approval";
        warnings.push(balanceCheck.message);
    }

    const autoApplicable = overallVerdict === "auto_approve" || overallVerdict === "no_change";

    // 7. Build summary
    const summary = buildReconciliationSummary(
        orderId, invoice, priceChanges, feeChanges, trackingUpdate,
        totalDollarImpact, overallVerdict, warnings
    );

    // M3: Learn fee label → Finale fee type mappings after successful reconciliation.
    // Fire-and-forget: don't block the return. Only learn from auto_approve or no_change
    // verdicts — these are high-confidence and safe to learn from.
    if (overallVerdict === "auto_approve" || overallVerdict === "no_change") {
        setImmediate(async () => {
            try {
                // Build a map of invoice charge labels → Finale fee types from this reconciliation
                const learnedMap: Record<string, string> = { ...vendorFeeLabelMap };
                for (const fc of feeChanges) {
                    if (fc.description && fc.feeType) {
                        learnedMap[fc.description.toLowerCase()] = fc.feeType;
                    }
                }
                // Only update vendor memory if we learned something new
                if (Object.keys(learnedMap).length > Object.keys(vendorFeeLabelMap).length) {
                    const existingPattern = await getVendorPattern(invoice.vendorName);
                    await storeVendorPattern({
                        vendorName: invoice.vendorName,
                        documentType: 'INVOICE',
                        pattern: existingPattern?.pattern || `Invoice from ${invoice.vendorName}`,
                        handlingRule: existingPattern?.handlingRule || 'Forward to bill.com, reconcile with Finale',
                        invoiceBehavior: existingPattern?.invoiceBehavior || 'single_page',
                        learnedFrom: 'reconciliation',
                        confidence: existingPattern?.confidence || 0.8,
                        feeLabelMap: learnedMap,
                    });
                    console.log(`[reconciler] M3: Learned ${Object.keys(learnedMap).length} fee label mappings for ${invoice.vendorName}`);
                }
            } catch {
                // Non-fatal — learning is advisory only
            }
        });
    }

    return {
        orderId,
        invoiceNumber: invoice.invoiceNumber,
        vendorName: invoice.vendorName,
        invoiceTotal: invoice.total,
        priceChanges,
        feeChanges,
        trackingUpdate,
        overallVerdict,
        summary,
        totalDollarImpact,
        autoApplicable,
        warnings,
        vendorNote,
        notes: balanceNote,
        report: buildReconciliationReport(invoice, poSummary, priceChanges, feeChanges, balanceCheck, overallVerdict, warnings, matchStrategy),
    };
}

// ──────────────────────────────────────────────────
// UOM NORMALIZATION
// ──────────────────────────────────────────────────

/**
 * UOM → multiplier to convert invoice qty to base countable units (EA).
 * Used for case/pack reconciliation where vendors bill per-case but
 * Finale tracks per-unit (or vice versa).
 *
 * DECISION: "case" defaults to 12 units; "bag" is weight-based → see UOM_TO_LB.
 * Vendor-specific overrides (e.g., "case/24") are handled via explicit keys.
 */
const UOM_TO_EA: Record<string, number> = {
    each: 1, ea: 1, pc: 1, pcs: 1, piece: 1, unit: 1, units: 1,
    "case": 12, "cs": 12, "cse": 12,
    "case/12": 12, "case/24": 24, "cs/24": 24,
};

/**
 * UOM → multiplier to convert invoice qty to base weight units (LB).
 * Used for bulk material lines where weight-per-bag varies by product.
 *
 * DECISION: "bag" defaults to 50 lb; override with explicit "bag/40" etc.
 * "pallet" treated as ~2000 lb (approximate — always needs_approval via
 * the existing magnitude guardrail anyway if the price swing is large).
 */
const UOM_TO_LB: Record<string, number> = {
    lb: 1, lbs: 1, pound: 1, pounds: 1,
    kg: 2.20462, kilo: 2.20462, kilogram: 2.20462,
    g: 0.00220462, gram: 0.00220462, grams: 0.00220462,
    oz: 0.0625, ounce: 0.0625, ounces: 0.0625,
    bag: 50, bg: 50,
    "bag/40": 40, "bag/50": 50,
    "pallet": 2000,
};

/**
 * Normalize a line item to a common base unit for apples-to-apples comparison.
 *
 * Returns `{ baseQty, normalizedPrice, normalized }` where:
 *   - baseQty       = qty × uom multiplier (e.g., 10 cases × 12 = 120 EA)
 *   - normalizedPrice = total / baseQty  (per base-unit price)
 *   - normalized    = true if a UOM conversion was applied
 *
 * If the UOM is not recognized or is EA-equivalent, returns inputs unchanged.
 *
 * @param qty        Quantity on the line
 * @param unitPrice  Unit price on the line (per stated UOM)
 * @param uom        Unit of measure string (e.g., "CASE/12", "bag", "LB")
 */
export function normalizeLineTotal(
    qty: number,
    unitPrice: number,
    uom?: string | null
): { baseQty: number; normalizedPrice: number; normalized: boolean } {
    if (!uom) return { baseQty: qty, normalizedPrice: unitPrice, normalized: false };

    const key = uom.trim().toLowerCase();

    const eaMult = UOM_TO_EA[key];
    if (eaMult !== undefined && eaMult !== 1) {
        const baseQty = qty * eaMult;
        const normalizedPrice = baseQty > 0 ? (qty * unitPrice) / baseQty : unitPrice;
        return { baseQty, normalizedPrice, normalized: true };
    }

    const lbMult = UOM_TO_LB[key];
    if (lbMult !== undefined && lbMult !== 1) {
        const baseQty = qty * lbMult;
        const normalizedPrice = baseQty > 0 ? (qty * unitPrice) / baseQty : unitPrice;
        return { baseQty, normalizedPrice, normalized: true };
    }

    // EA=1 or LB=1 keys — already in base unit, no conversion needed
    return { baseQty: qty, normalizedPrice: unitPrice, normalized: false };
}

// ──────────────────────────────────────────────────
// VENDOR CORRELATION
// ──────────────────────────────────────────────────

/**
 * Jaccard word-overlap similarity between two strings (0.0–1.0).
 * Normalizes to lowercase, strips punctuation, splits on whitespace.
 * "BuildASoil Organics" vs "BuildASoil Organics LLC" → ~0.67
 */
function wordOverlapSimilarity(a: string, b: string): number {
    // Fix 7: Collapse dotted initials before stripping punctuation so that
    // "A.B.C. Corp" tokenizes as ["abc", "corp"] not ["a", "b", "c", "corp"],
    // giving correct Jaccard overlap against "ABC Corp".
    const normalize = (s: string) => {
        const collapsed = s.replace(/\b([A-Za-z])\.([A-Za-z]\.)+/g, (m) => m.replace(/\./g, ""));
        return collapsed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    };

    const wordsA = new Set(normalize(a));
    const wordsB = new Set(normalize(b));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const w of wordsA) { if (wordsB.has(w)) overlap++; }

    const union = new Set([...wordsA, ...wordsB]).size;
    return overlap / union;
}

/**
 * Validate that the invoice vendor plausibly belongs to this Finale PO.
 * Uses a three-signal waterfall:
 *   1. Vendor name similarity ≥ VENDOR_FUZZY_THRESHOLD  →  HIGH confidence
 *   2. Invoice PO# matches orderId                       →  MEDIUM confidence
 *   3. ≥50% of invoice SKUs found on PO lines           →  MEDIUM confidence
 *   None match                                           →  LOW → block auto-apply
 *
 * Returning pass:false means the reconciliation becomes "needs_approval" so
 * Will sees the mismatch before anything touches Finale.
 */
function validateVendorCorrelation(
    invoice: InvoiceData,
    poSummary: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>,
    orderId: string
): { pass: boolean; confidence: "high" | "medium" | "low"; note: string } {
    // Signal 1: Name similarity
    const similarity = wordOverlapSimilarity(invoice.vendorName, poSummary.supplier);
    if (similarity >= RECONCILIATION_CONFIG.VENDOR_FUZZY_THRESHOLD) {
        return {
            pass: true,
            confidence: "high",
            note: `Vendor matched: "${invoice.vendorName}" ↔ "${poSummary.supplier}" (${(similarity * 100).toFixed(0)}% word overlap)`,
        };
    }

    // Signal 1b: Brand word match — any significant shared word (>4 chars) is a brand indicator.
    // Catches "Riceland Foods, Inc." ↔ "Riceland USA" where Jaccard is only 0.25
    // but the distinctive brand name "Riceland" is shared.
    // Fix 4: Blocklist common generic words that appear across unrelated vendors and
    // would otherwise produce false-positive medium-confidence matches.
    const GENERIC_WORDS = new Set([
        "united", "national", "international", "supply", "supplies",
        "organics", "organic", "company", "corporation", "industries",
        "holdings", "products", "services", "group", "trading",
        "enterprise", "enterprises", "solutions", "global", "systems",
    ]);
    // Fix 7: Also collapse dotted initials here for consistent tokenization.
    const normalize = (s: string) => {
        const collapsed = s.replace(/\b([A-Za-z])\.([A-Za-z]\.)+/g, (m) => m.replace(/\./g, ""));
        return collapsed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    };
    const wordsA = normalize(invoice.vendorName);
    const wordsB = new Set(normalize(poSummary.supplier));
    const sharedBrandWord = wordsA.find(w => w.length > 4 && wordsB.has(w) && !GENERIC_WORDS.has(w));
    if (sharedBrandWord) {
        return {
            pass: true,
            confidence: "medium",
            note: `⚠️ Vendor name mismatch ("${invoice.vendorName}" vs PO supplier "${poSummary.supplier}") — confirmed via shared brand word "${sharedBrandWord}".`,
        };
    }

    // Signal 2: PO number on invoice explicitly references this order
    const invoicePORef = (invoice.poNumber ?? "").trim().toLowerCase();
    const orderIdNorm = orderId.trim().toLowerCase();
    if (
        invoicePORef &&
        (invoicePORef === orderIdNorm ||
            invoicePORef.includes(orderIdNorm) ||
            orderIdNorm.includes(invoicePORef))
    ) {
        return {
            pass: true,
            confidence: "medium",
            note: `⚠️ Vendor name mismatch ("${invoice.vendorName}" vs PO supplier "${poSummary.supplier}") — confirmed via PO# reference on invoice (${invoice.poNumber}).`,
        };
    }

    // Signal 3: SKU overlap — at least half the invoice SKUs appear on this PO
    const poSkus = new Set(poSummary.items.map(i => i.productId.toLowerCase()));
    const invoiceSkus = invoice.lineItems
        .map(l => l.sku?.toLowerCase())
        .filter((s): s is string => Boolean(s));

    if (invoiceSkus.length > 0) {
        const matched = invoiceSkus.filter(s => poSkus.has(s)).length;
        if (matched / invoiceSkus.length >= 0.5) {
            return {
                pass: true,
                confidence: "medium",
                note: `⚠️ Vendor name mismatch ("${invoice.vendorName}" vs PO supplier "${poSummary.supplier}") — confirmed by ${matched}/${invoiceSkus.length} SKU matches.`,
            };
        }
    }

    // No signals matched — block and require manual review
    return {
        pass: false,
        confidence: "low",
        note: `🚨 VENDOR MISMATCH: Invoice vendor "${invoice.vendorName}" does not correlate with PO supplier "${poSummary.supplier}". No PO# or SKU evidence to confirm. Manual review required.`,
    };
}

// ──────────────────────────────────────────────────
// LINE ITEM PRICE COMPARISON
// ──────────────────────────────────────────────────

function reconcileLineItems(
    invoice: InvoiceData,
    po: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>
): PriceChange[] {
    const changes: PriceChange[] = [];
    const matchedPoProductIds = new Set<string>(); // prevent double-matching the same PO product

    for (const invLine of invoice.lineItems) {
        // Skip adjustment/credit lines — these have $0 unit price or 0 qty and are
        // invoice metadata (e.g., "Pts Pr Adj", freight credits), not product lines.
        if (invLine.unitPrice === 0 || invLine.qty === 0) {
            console.log(`     [reconciler] Skipping adjustment line: "${invLine.description}" (qty=${invLine.qty}, unitPrice=${invLine.unitPrice})`);
            continue;
        }

        // Try to match by SKU first, then by fuzzy description
        const poLine = findMatchingPOLine({ ...invLine, sku: invLine.sku ?? undefined }, po.items);

        // Skip if this PO product was already matched by a previous invoice line.
        // This prevents split description lines (OCR artifact) from double-matching the same product.
        if (poLine && matchedPoProductIds.has(poLine.productId)) {
            console.log(`     [reconciler] Skipping duplicate match: invoice line "${invLine.description}" already matched to ${poLine.productId}`);
            continue;
        }
        if (poLine) matchedPoProductIds.add(poLine.productId);

        if (!poLine) {
            // Invoice has a line item not found in PO — info only, don't block
            changes.push({
                productId: invLine.sku || "UNKNOWN",
                description: invLine.description,
                poPrice: 0,
                invoicePrice: invLine.unitPrice,
                quantity: invLine.qty,
                percentChange: 100,
                dollarImpact: invLine.total,
                verdict: "no_match",
                reason: "Invoice line item not found in PO — may be a new item or SKU mismatch",
            });
            continue;
        }

        // UOM normalization: convert invoice and PO lines to a common per-base-unit
        // price before comparison. This prevents a false "price change" when the
        // invoice bills per-case (e.g., $120/case of 12) but Finale tracks per-EA
        // ($10/EA). Finale PO lines carry no UOM field so we always pass null there.
        const invoiceNorm = normalizeLineTotal(invLine.qty, invLine.unitPrice, invLine.unit ?? null);
        const poNorm = normalizeLineTotal(poLine.quantity, poLine.unitPrice, null);

        // Effective prices to compare (per base unit after normalization)
        const effectiveInvPrice = invoiceNorm.normalizedPrice;
        const effectivePoPrice = poNorm.normalizedPrice;

        const priceDelta = effectiveInvPrice - effectivePoPrice;
        const percentChange = effectivePoPrice > 0
            ? Math.abs(priceDelta) / effectivePoPrice
            : (effectiveInvPrice > 0 ? 1 : 0);

        const dollarImpact = priceDelta * (invoiceNorm.normalized ? invoiceNorm.baseQty : invLine.qty);

        // Run through price safety checks using normalized prices
        let { verdict: pVerdict, reason: pReason } = evaluatePriceChange(
            effectivePoPrice,
            effectiveInvPrice,
            percentChange,
            dollarImpact
        );

        // Append UOM normalization context to the reason when a conversion was applied
        if (invoiceNorm.normalized) {
            const uomKey = (invLine.unit ?? "").trim().toLowerCase();
            const eaMult = UOM_TO_EA[uomKey];
            const lbMult = UOM_TO_LB[uomKey];
            const mult = eaMult ?? lbMult ?? 1;
            const baseUnit = eaMult !== undefined ? "EA" : "LB";
            pReason += ` | UOM normalized: ${(invLine.unit ?? "").toUpperCase()} →${baseUnit !== "EA" ? " per " : " "}${baseUnit} (×${mult})`;

            // Ambiguous case/bag keys: the multiplier was assumed, not stated explicitly
            // in the UOM string. Force needs_approval so Will can verify the pack size.
            const AMBIGUOUS_CASE_KEYS = new Set(["case", "cs", "cse"]);
            const AMBIGUOUS_BAG_KEYS = new Set(["bag", "bg"]);

            if (AMBIGUOUS_CASE_KEYS.has(uomKey)) {
                pVerdict = "needs_approval";
                pReason += " | case size assumed 12 — verify";
            } else if (AMBIGUOUS_BAG_KEYS.has(uomKey)) {
                pVerdict = "needs_approval";
                pReason += " | bag weight assumed 50 lb — verify";
            }
        }

        // Guard 2: Quantity overbill — never auto-approve if invoice qty > PO qty.
        // Even a tiny price change is suspicious when the vendor is billing for
        // more units than were ordered.
        if (invLine.qty > poLine.quantity && pVerdict === "auto_approve") {
            pVerdict = "needs_approval";
            pReason += ` | ⚠️ OVERBILL: Invoice qty ${invLine.qty} > PO qty ${poLine.quantity} — may be billed for more units than ordered.`;
        }

        changes.push({
            productId: poLine.productId,
            description: invLine.description,
            poPrice: poLine.unitPrice,
            invoicePrice: invLine.unitPrice,
            quantity: invLine.qty,
            percentChange,
            dollarImpact,
            verdict: pVerdict,
            reason: pReason,
        });
    }

    return changes;
}

/**
 * Core safety evaluation for a single price change.
 * 
 * DECISION(2026-02-26): Multi-layer guardrail approach per Will's requirement:
 *   "We can't have $2.60 turn into $26,000.00"
 * 
 * Layer 1: Magnitude check (catches decimal shifts, OCR errors)
 * Layer 2: High-value item check (extra caution on expensive items)
 * Layer 3: Percentage threshold (3% auto / >3% manual)
 * Layer 4: Total impact cap (applied at the PO level, not here)
 */
function evaluatePriceChange(
    poPrice: number,
    invoicePrice: number,
    percentChange: number,
    dollarImpact: number
): { verdict: ReconciliationVerdict; reason: string } {
    // No change — nothing to do
    if (Math.abs(poPrice - invoicePrice) < 0.01) {
        return { verdict: "no_change", reason: "Prices match" };
    }

    // Layer 1: Magnitude check — catch decimal errors
    // $2.60 → $26.00 is a 10x shift, $2.60 → $260.00 is a 100x shift
    if (poPrice > 0 && invoicePrice > 0) {
        const ratio = invoicePrice / poPrice;
        if (ratio > RECONCILIATION_CONFIG.MAGNITUDE_CEILING || ratio < (1 / RECONCILIATION_CONFIG.MAGNITUDE_CEILING)) {
            return {
                verdict: "rejected",
                reason: `🚨 MAGNITUDE ERROR: Price changed from $${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)} (${ratio.toFixed(1)}x). This looks like a decimal error. NOT applied — requires manual correction.`,
            };
        }
    }

    // Layer 1b: Zero to non-zero (PO had $0, invoice has a real price)
    if (poPrice === 0 && invoicePrice > 0) {
        return {
            verdict: "needs_approval",
            reason: `PO had $0.00 price, invoice shows $${invoicePrice.toFixed(2)}. May be a placeholder PO line.`,
        };
    }

    // Layer 2: High-value items always need manual review
    if (invoicePrice > RECONCILIATION_CONFIG.HIGH_VALUE_THRESHOLD) {
        return {
            verdict: "needs_approval",
            reason: `High-value item ($${invoicePrice.toFixed(2)}/unit) — requires manual review regardless of % change.`,
        };
    }

    // Layer 3: Percentage threshold
    if (percentChange <= RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT) {
        const direction = dollarImpact > 0 ? "increase" : "decrease";
        return {
            verdict: "auto_approve",
            reason: `${(percentChange * 100).toFixed(1)}% price ${direction} ($${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)}) — within ${RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT * 100}% auto-threshold.`,
        };
    }

    // >3% but within magnitude limits — needs human approval
    const direction = dollarImpact > 0 ? "increase" : "decrease";
    return {
        verdict: "needs_approval",
        reason: `${(percentChange * 100).toFixed(1)}% price ${direction} ($${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)}, impact: $${Math.abs(dollarImpact).toFixed(2)}) — exceeds ${RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT * 100}% auto-threshold.`,
    };
}

/**
 * Find the matching PO line item for an invoice line.
 * Tries exact SKU match first, then fuzzy description match.
 */
function findMatchingPOLine(
    invLine: { sku?: string; description: string; unitPrice: number },
    poItems: Array<{ productId: string; unitPrice: number; quantity: number; description: string }>
): { productId: string; unitPrice: number; quantity: number } | null {
    // Strategy 1: Exact SKU match (case-insensitive)
    if (invLine.sku) {
        const skuLower = invLine.sku.toLowerCase();
        const match = poItems.find(item => item.productId.toLowerCase() === skuLower);
        if (match) return match;

        // Strategy 1b: SKU as substring (vendor may add prefixes/suffixes)
        const substringMatch = poItems.find(item =>
            item.productId.toLowerCase().includes(skuLower) ||
            skuLower.includes(item.productId.toLowerCase())
        );
        if (substringMatch) return substringMatch;
    }

    // Strategy 2: Description similarity (first 20 chars, case-insensitive)
    if (invLine.description) {
        const descLower = invLine.description.toLowerCase().slice(0, 30);
        const descMatch = poItems.find(item =>
            item.description.toLowerCase().includes(descLower) ||
            descLower.includes(item.description.toLowerCase().slice(0, 30))
        );
        if (descMatch) return descMatch;
    }

    // Strategy 3: Price match (if only 1 item matches the price exactly)
    const priceMatches = poItems.filter(item =>
        Math.abs(item.unitPrice - invLine.unitPrice) < 0.01
    );
    if (priceMatches.length === 1) return priceMatches[0];

    return null;
}

// ──────────────────────────────────────────────────
// FEE COMPARISON
// ──────────────────────────────────────────────────

export function reconcileFees(
    invoice: InvoiceData,
    po: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>,
    vendorFeeLabelMap: Record<string, string> = {}   // H2: vendor-specific fee label→type mappings
): FeeChange[] {
    const changes: FeeChange[] = [];

    // Map invoice charges to Finale fee types
    const feeMapping: Array<{
        invoiceField: keyof InvoiceData;
        feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES;
        label: string;
    }> = [
            { invoiceField: "freight", feeType: "FREIGHT", label: "Freight" },
            { invoiceField: "tax", feeType: "TAX", label: "Tax" },
            { invoiceField: "tariff", feeType: "TARIFF", label: "Duties/Tariff" },
            { invoiceField: "labor", feeType: "LABOR", label: "Labor" },
            { invoiceField: "fuelSurcharge", feeType: "SHIPPING", label: "Fuel Surcharge" },
        ];

    for (const mapping of feeMapping) {
        const invoiceAmount = invoice[mapping.invoiceField] as number | undefined;
        if (!invoiceAmount || invoiceAmount <= 0) continue;

        // H2: Use vendor-learned fee label map to find PO adjustments
        // that use non-standard labels (e.g., "frt chg" instead of "freight").
        // Falls back to the hardcoded mapping.label if no vendor label match.
        const vendorLabelsForType = Object.entries(vendorFeeLabelMap)
            .filter(([, feeType]) => feeType === mapping.feeType)
            .map(([label]) => label.toLowerCase());

        const existingFee = po.adjustments.find(adj => {
            const adjLower = adj.description.toLowerCase();
            // Check hardcoded label first
            if (adjLower.includes(mapping.label.toLowerCase())) return true;
            // Check vendor-learned labels
            return vendorLabelsForType.some(vl => adjLower.includes(vl));
        });

        const existingAmount = existingFee?.amount || 0;

        // Only add if it's new or materially different
        if (Math.abs(invoiceAmount - existingAmount) > 0.01) {
            // Guard 3: Fee threshold — delta above per-type cap requires Telegram approval.
            // The delta (not the full fee amount) is what matters: a $300 freight
            // charge on a PO that already has $280 freight is only a $20 change.
            const feeDelta = Math.abs(invoiceAmount - existingAmount);
            const cap = getFeeAutoApproveCap(mapping.feeType);
            const verdict: "auto_approve" | "needs_approval" =
                feeDelta > cap
                    ? "needs_approval"
                    : "auto_approve";
            const reason = verdict === "needs_approval"
                ? `Fee delta $${feeDelta.toFixed(2)} exceeds $${cap} ${mapping.feeType} auto-approve cap — requires approval`
                : `Fee delta $${feeDelta.toFixed(2)} within $${cap} ${mapping.feeType} auto-approve cap`;

            changes.push({
                feeType: mapping.feeType,
                amount: invoiceAmount,
                description: mapping.label,
                existingAmount,
                isNew: !existingFee,
                verdict,
                reason,
            });
        }
    }

    // C5 FIX: Discount negation — invoice parser extracts discount as a positive number.
    // Must write to Finale as NEGATIVE to subtract from PO total.
    // Uses DISCOUNT_20 fee type (id 10011) as the vehicle for flat-dollar discounts.
    const discountAmount = invoice.discount ?? 0;
    if (discountAmount > 0) {
        const existingDiscount = po.adjustments.find(adj =>
            adj.description.toLowerCase().includes("discount")
        );
        const existingAmount = existingDiscount?.amount || 0;
        const negatedAmount = -Math.abs(discountAmount);

        if (Math.abs(negatedAmount - existingAmount) > 0.01) {
            const feeDelta = Math.abs(negatedAmount - existingAmount);
            const discountCap = getFeeAutoApproveCap('DISCOUNT_20');
            const verdict: "auto_approve" | "needs_approval" =
                feeDelta > discountCap
                    ? "needs_approval" : "auto_approve";
            const reason = verdict === "needs_approval"
                ? `Discount delta $${feeDelta.toFixed(2)} exceeds $${discountCap} DISCOUNT auto-approve cap — requires approval`
                : `Discount $${discountAmount.toFixed(2)} applied as -$${discountAmount.toFixed(2)}`;
            changes.push({
                feeType: "DISCOUNT_20",
                amount: negatedAmount,  // NEGATIVE — subtracts from PO total
                description: "Discount",
                existingAmount,
                isNew: !existingDiscount,
                verdict,
                reason,
            });
        }
    }

    // Derived freight fallback: if no explicit freight was extracted but
    // invoice.total > product subtotal, the gap is likely freight/shipping.
    // Catches invoices where the freight label ("Alan to BAS", "Frt Chg", etc.)
    // isn't recognized as a standard freight keyword by the LLM extractor.
    //
    // Use computed line-item subtotal when invoice.subtotal is 0 (OCR missed it).
    // Filter to non-adjustment lines (unitPrice > 0 AND qty > 0).
    const hasExplicitFreight = (invoice.freight ?? 0) > 0;
    if (!hasExplicitFreight && invoice.total > 0) {
        const computedSubtotal = invoice.lineItems
            .filter(li => (li.unitPrice ?? 0) > 0 && (li.qty ?? 0) > 0)
            .reduce((sum, li) => sum + (li.qty ?? 0) * (li.unitPrice ?? 0), 0);
        const productSubtotal = computedSubtotal > 0 ? computedSubtotal
            : (invoice.subtotal > 0 ? invoice.subtotal : 0);

        if (productSubtotal > 0) {
            const knownCharges = (invoice.tax ?? 0) + (invoice.tariff ?? 0) +
                (invoice.labor ?? 0) + (invoice.fuelSurcharge ?? 0);
            const discountOffset = Math.abs(invoice.discount ?? 0);
            const derivedFreight = invoice.total - productSubtotal - knownCharges + discountOffset;

            if (derivedFreight > 1) {
                const existingFee = po.adjustments.find(adj => {
                    const d = adj.description.toLowerCase();
                    return d.includes("freight") || d.includes("shipping") || d.includes("frt");
                });
                const existingAmount = existingFee?.amount || 0;

                if (Math.abs(derivedFreight - existingAmount) > 0.01) {
                    const feeDelta = Math.abs(derivedFreight - existingAmount);
                    const freightCap = getFeeAutoApproveCap('FREIGHT');
                    const verdict: "auto_approve" | "needs_approval" =
                        feeDelta > freightCap
                            ? "needs_approval"
                            : "auto_approve";
                    changes.push({
                        feeType: "FREIGHT",
                        amount: derivedFreight,
                        description: existingFee?.description || "Freight",
                        existingAmount,
                        isNew: !existingFee,
                        verdict,
                        reason: `Derived freight: $${invoice.total.toFixed(2)} total − $${productSubtotal.toFixed(2)} product subtotal = $${derivedFreight.toFixed(2)}`,
                    });
                }
            }
        }
    }

    return changes;
}

// ──────────────────────────────────────────────────
// TRACKING
// ──────────────────────────────────────────────────

function reconcileTracking(invoice: InvoiceData): TrackingUpdate | null {
    const trackingNumbers = invoice.trackingNumbers?.filter(t => t.trim()) || [];
    if (trackingNumbers.length === 0 && !invoice.shipDate) return null;

    return {
        trackingNumbers,
        shipDate: invoice.shipDate ?? undefined,
        carrierName: invoice.carrierName ?? undefined,
    };
}

// ──────────────────────────────────────────────────
// APPLY CHANGES TO FINALE
// ──────────────────────────────────────────────────

/**
 * Apply auto-approved changes to Finale.
 * Only applies changes with verdict "auto_approve" or fee additions.
 * Returns a log of what was applied and what was skipped.
 * 
 * IMPORTANT: This should only be called after reconcileInvoiceToPO()
 * and verifying that autoApplicable is true OR after receiving
 * manual Slack approval for needs_approval items.
 */
export async function applyReconciliation(
    result: ReconciliationResult,
    client: FinaleClient,
    approvedItems?: string[],  // productIds that were manually approved
    approvedFeeTypes?: string[] // feeTypes that were manually approved
): Promise<{
    applied: string[];
    skipped: string[];
    errors: string[];
}> {
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // 1. Apply price changes
    for (const pc of result.priceChanges) {
        const isApproved = pc.verdict === "auto_approve" ||
            (pc.verdict === "needs_approval" && approvedItems?.includes(pc.productId));

        if (!isApproved) {
            skipped.push(`${pc.productId}: ${pc.reason}`);
            continue;
        }

        try {
            await client.updateOrderItemPrice(result.orderId, pc.productId, pc.invoicePrice);
            applied.push(`${pc.productId}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)}`);
        } catch (err: any) {
            errors.push(`${pc.productId}: Failed — ${err.message}`);
        }
    }

    // 2. Apply fee changes — gated on per-fee verdict
    // auto_approve fees apply immediately; needs_approval fees only apply
    // if the user explicitly approved them via Telegram button.
    for (const fc of result.feeChanges) {
        const feeApproved = fc.verdict === "auto_approve" ||
            (fc.verdict === "needs_approval" && approvedFeeTypes?.includes(fc.feeType));

        if (!feeApproved) {
            skipped.push(`Fee: ${fc.description} $${fc.amount.toFixed(2)} — ${fc.reason}`);
            continue;
        }

        try {
            if (fc.isNew) {
                await client.addOrderAdjustment(
                    result.orderId,
                    fc.feeType,
                    fc.amount,
                    fc.description
                );
                applied.push(`Fee added: ${fc.description} $${fc.amount.toFixed(2)}`);
            } else {
                // Update existing fee (e.g. Freight sitting at $0 → actual amount)
                await client.updateOrderAdjustmentAmount(
                    result.orderId,
                    fc.feeType,
                    fc.amount,
                    fc.description
                );
                applied.push(`Fee updated: ${fc.description} $${fc.existingAmount.toFixed(2)} → $${fc.amount.toFixed(2)}`);
            }
        } catch (err: any) {
            errors.push(`Fee ${fc.description}: Failed — ${err.message}`);
        }
    }

    // 3. Apply tracking updates (with deduplication)
    if (result.trackingUpdate) {
        try {
            // Phase 4: Dedup tracking numbers against Supabase before writing
            const newTrackingNumbers = await deduplicateTrackingNumbers(
                result.trackingUpdate.trackingNumbers,
                result.invoiceNumber
            );

            if (newTrackingNumbers.length === 0 && !result.trackingUpdate.shipDate) {
                skipped.push("Tracking: All tracking numbers already recorded in Supabase");
            } else {
                const poDetails = await client.getOrderDetails(result.orderId);
                const shipUrls = poDetails.shipmentUrlList || [];

                if (shipUrls.length > 0) {
                    const firstShipment = shipUrls[0];
                    const updates: any = {};

                    if (newTrackingNumbers.length > 0) {
                        updates.trackingCode = newTrackingNumbers[0];
                    }
                    if (result.trackingUpdate.shipDate) {
                        updates.shipDate = result.trackingUpdate.shipDate;
                    }
                    if (result.trackingUpdate.carrierName) {
                        updates.privateNotes = `Carrier: ${result.trackingUpdate.carrierName}`;
                    }

                    await client.updateShipmentTracking(firstShipment, updates);
                    applied.push(`Tracking: ${newTrackingNumbers.join(", ") || "ship date updated"}`);

                    // Save tracking numbers to invoices table for future dedup
                    await saveTrackingNumbers(newTrackingNumbers, result.invoiceNumber);

                    // Also persist to purchase_orders.tracking_numbers so calendar sync + dashboard show it
                    if (newTrackingNumbers.length > 0) {
                        try {
                            const supabase = createClient();
                            if (supabase) {
                                const { data: existingPO } = await supabase
                                    .from("purchase_orders")
                                    .select("tracking_numbers")
                                    .eq("po_number", result.orderId)
                                    .maybeSingle();
                                const merged = [...new Set([...(existingPO?.tracking_numbers ?? []), ...newTrackingNumbers])];
                                await supabase.from("purchase_orders").upsert({
                                    po_number: result.orderId,
                                    tracking_numbers: merged,
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: "po_number" });
                            }
                        } catch (e: any) {
                            console.warn(`⚠️ [reconciler] Failed to persist tracking to purchase_orders: ${e.message}`);
                        }
                    }
                } else {
                    skipped.push("Tracking: No shipment found on PO to attach tracking to");
                }
            }
        } catch (err: any) {
            errors.push(`Tracking update failed: ${err.message}`);
        }
    }

    // 4. Log all changes to price_change_audit (flat, queryable table)
    // Fire-and-forget: don't block the return. The JSONB reconciliation_report
    // in ap_activity_log is the durable record; this is the queryable view.
    const approvedBy = approvedItems?.length ? "Will" : "system";
    setImmediate(() => {
        logPriceChangeAudit(result, approvedBy).catch((err: any) => {
            console.warn(`⚠️ [reconciler] price_change_audit failed (non-fatal): ${err.message}`);
        });
    });

    return { applied, skipped, errors };
}

// ──────────────────────────────────────────────────
// TRACKING NUMBER DEDUPLICATION
// ──────────────────────────────────────────────────

/**
 * Check which tracking numbers are new (not yet stored in Supabase).
 * Prevents writing duplicate tracking info to Finale shipments.
 *
 * DECISION(2026-02-26): Dedup at the Supabase level because:
 *   - Multiple invoices may reference the same tracking number
 *   - Finale doesn't have a clean way to check existing tracking
 *   - We need an audit trail of which invoice provided which tracking#
 */
async function deduplicateTrackingNumbers(
    trackingNumbers: string[],
    _invoiceNumber: string   // passed for call-site clarity; dedup uses the numbers only
): Promise<string[]> {
    if (trackingNumbers.length === 0) return [];

    try {
        const supabase = createClient();
        if (!supabase) return trackingNumbers; // No Supabase → skip dedup, write all

        // Check which tracking numbers already exist in any invoice record
        const { data: existingInvoices } = await supabase
            .from("invoices")
            .select("tracking_numbers")
            .overlaps("tracking_numbers", trackingNumbers);

        if (!existingInvoices || existingInvoices.length === 0) {
            return trackingNumbers; // All are new
        }

        // Flatten existing tracking numbers into a Set
        const existingSet = new Set<string>();
        for (const inv of existingInvoices) {
            for (const tn of inv.tracking_numbers || []) {
                existingSet.add(tn.trim().toUpperCase());
            }
        }

        // Filter to only new tracking numbers
        const newNumbers = trackingNumbers.filter(
            tn => !existingSet.has(tn.trim().toUpperCase())
        );

        if (newNumbers.length < trackingNumbers.length) {
            const dupeCount = trackingNumbers.length - newNumbers.length;
            console.log(`   📋 Tracking dedup: ${dupeCount} duplicate(s) filtered, ${newNumbers.length} new`);
        }

        return newNumbers;
    } catch (err: any) {
        console.warn(`⚠️ Tracking dedup failed, writing all: ${err.message}`);
        return trackingNumbers;
    }
}

/**
 * Save tracking numbers to the invoice record in Supabase.
 * Uses array append so multiple invoices can contribute tracking info.
 */
async function saveTrackingNumbers(
    trackingNumbers: string[],
    invoiceNumber: string
): Promise<void> {
    if (trackingNumbers.length === 0) return;

    try {
        const supabase = createClient();
        if (!supabase) return;

        // Update the invoice record with tracking numbers
        await supabase
            .from("invoices")
            .update({ tracking_numbers: trackingNumbers })
            .eq("invoice_number", invoiceNumber);
    } catch (err: any) {
        console.warn(`⚠️ Failed to save tracking numbers: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// AUDIT METADATA
// ──────────────────────────────────────────────────

/**
 * Build a structured audit record for ap_activity_log.metadata.
 * Captures every price change, fee change, and invoice amount for full recall.
 */
export function buildAuditMetadata(
    result: ReconciliationResult,
    applyResult: { applied: string[]; skipped: string[]; errors: string[] },
    trigger: "auto" | "telegram" | "manual"
) {
    return {
        trigger,
        invoiceNumber: result.invoiceNumber,
        orderId: result.orderId,
        vendorName: result.vendorName,
        total: result.invoiceTotal,
        verdict: result.overallVerdict,
        totalDollarImpact: result.totalDollarImpact,
        priceChanges: result.priceChanges.map(pc => ({
            productId: pc.productId,
            description: pc.description,
            from: pc.poPrice,
            to: pc.invoicePrice,
            pct: parseFloat((pc.percentChange * 100).toFixed(2)),
            impact: parseFloat(pc.dollarImpact.toFixed(2)),
            verdict: pc.verdict,
        })),
        feeChanges: result.feeChanges.map(fc => ({
            type: fc.feeType,
            description: fc.description,
            from: fc.existingAmount,
            to: fc.amount,
            delta: parseFloat((fc.amount - fc.existingAmount).toFixed(2)),
            verdict: fc.verdict,
        })),
        tracking: result.trackingUpdate ? {
            trackingNumbers: result.trackingUpdate.trackingNumbers,
            shipDate: result.trackingUpdate.shipDate,
            carrier: result.trackingUpdate.carrierName,
        } : null,
        applied: applyResult.applied,
        skipped: applyResult.skipped,
        errors: applyResult.errors,
    };
}

// ──────────────────────────────────────────────────
// RECONCILIATION REPORT BUILDER
// ──────────────────────────────────────────────────

/**
 * Build a structured ReconciliationReport from data already computed in reconcileInvoiceToPO().
 * No extra API calls — all inputs are already in-scope at the call site.
 *
 * The report is written into ap_activity_log.reconciliation_report (JSONB) so that
 * accounting can query, filter, and export a full audit trail per invoice.
 */
export function buildReconciliationReport(
    invoice: InvoiceData,
    poSummary: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>> | null,
    priceChanges: PriceChange[],
    feeChanges: FeeChange[],
    balanceCheck: { valid: boolean; gap: number; message: string },
    overallVerdict: ReconciliationVerdict,
    warnings: string[],
    matchStrategy?: string       // M4: Which matching strategy found the PO
): ReconciliationReport {
    const now = new Date().toISOString();

    // Derive approval method from the verdict at report-build time.
    // Telegram approvals update this after the fact via their own log writes.
    let approvalMethod: ReconciliationReport["approval"]["method"];
    if (overallVerdict === "auto_approve" || overallVerdict === "no_change") {
        approvalMethod = "auto";
    } else if (overallVerdict === "rejected") {
        approvalMethod = "rejected";
    } else if (overallVerdict === "duplicate") {
        approvalMethod = "auto";
    } else {
        // needs_approval, no_match — awaiting Will's Telegram decision
        approvalMethod = "pending";
    }

    const isAutoOrNoChange = approvalMethod === "auto";

    // Flatten price + fee changes into a unified changes array
    const changes: ReconciliationReport["changes"] = [
        ...priceChanges.map(pc => ({
            sku: pc.productId,
            description: pc.description,
            field: "unit_price",
            invoice_value: pc.invoicePrice,
            po_value: pc.poPrice,
            disposition: pc.verdict as string,
            note: pc.reason,
        })),
        ...feeChanges.map(fc => ({
            sku: fc.feeType,
            description: fc.description,
            field: "fee",
            invoice_value: fc.amount,
            po_value: fc.existingAmount,
            disposition: fc.verdict as string,
            note: fc.reason,
        })),
    ];

    // Resolve fees_applied from feeChanges (keyed by feeType)
    const feeByType = (type: string) => feeChanges.find(fc => fc.feeType === type)?.amount ?? null;

    return {
        generated_at: now,
        invoice: {
            number: invoice.invoiceNumber ?? null,
            vendor: invoice.vendorName ?? null,
            total: invoice.total ?? null,
            date: invoice.invoiceDate ?? null,
            po_number: invoice.poNumber ?? null,
            line_count: invoice.lineItems?.length ?? 0,
            freight: invoice.freight ?? null,
            tax: invoice.tax ?? null,
            tariff: invoice.tariff ?? null,
            labor: invoice.labor ?? null,
            discount: invoice.discount ?? null,
        },
        finale_po: poSummary
            ? {
                order_id: poSummary.orderId,
                vendor: poSummary.supplier ?? null,
                total: poSummary.total ?? null,
                line_count: poSummary.items?.length ?? 0,
            }
            : null,
        changes,
        fees_applied: {
            freight: feeByType("FREIGHT"),
            tax: feeByType("TAX"),
            tariff: feeByType("TARIFF"),
            labor: feeByType("LABOR"),
            discount: invoice.discount ?? null,
        },
        approval: {
            method: approvalMethod,
            approved_by: isAutoOrNoChange ? "system" : undefined,
            approved_at: isAutoOrNoChange ? now : undefined,
        },
        balance_check: {
            valid: balanceCheck.valid,
            gap: balanceCheck.gap > 0 ? balanceCheck.gap : undefined,
            message: balanceCheck.message || undefined,
        },
        warnings,
        match_strategy: matchStrategy,
    };
}

// ──────────────────────────────────────────────────
// PRICE CHANGE AUDIT LOG — flat, queryable table
// ──────────────────────────────────────────────────

/**
 * Write every price change and fee change to `price_change_audit` as flat rows.
 * This is the primary audit table for answering questions like:
 *   - "What did we pay vendor X for freight?"
 *   - "Show all price changes for SKU BLM209"
 *   - "Total tariffs this quarter"
 *
 * Non-blocking: logs and continues on failure so the reconciliation flow
 * is never interrupted by an audit-write error.
 *
 * DECISION(2026-03-13): Separate from ap_activity_log.reconciliation_report
 * (JSONB) because flat columns enable simple SQL aggregates and joins
 * without JSONB path queries. Both stores are maintained for redundancy.
 *
 * @param result       The reconciliation result (prices, fees, tracking)
 * @param approvedBy   'system' for auto-approve, 'Will' for manual
 * @param source       'pdf_invoice' | 'inline_invoice' | 'manual'
 */
export async function logPriceChangeAudit(
    result: ReconciliationResult,
    approvedBy: string = "system",
    source: string = "pdf_invoice"
): Promise<void> {
    try {
        const supabase = createClient();
        if (!supabase) return;

        const rows: Array<Record<string, unknown>> = [];

        // Item price changes
        for (const pc of result.priceChanges) {
            if (pc.verdict === "no_match") continue; // unmatched lines aren't actionable
            rows.push({
                po_number: result.orderId,
                vendor_name: result.vendorName,
                invoice_number: result.invoiceNumber,
                change_type: "item_price",
                sku: pc.productId,
                description: pc.description,
                old_value: pc.poPrice,
                new_value: pc.invoicePrice,
                quantity: pc.quantity,
                dollar_impact: pc.dollarImpact,
                percent_change: pc.percentChange,
                verdict: pc.verdict,
                approved_by: approvedBy,
                carrier_name: result.trackingUpdate?.carrierName ?? null,
                tracking_numbers: result.trackingUpdate?.trackingNumbers ?? null,
                source,
            });
        }

        // Fee changes (freight, tax, tariff, labor, discount)
        for (const fc of result.feeChanges) {
            rows.push({
                po_number: result.orderId,
                vendor_name: result.vendorName,
                invoice_number: result.invoiceNumber,
                change_type: fc.feeType.toLowerCase(),
                sku: null,
                description: fc.description,
                old_value: fc.existingAmount,
                new_value: fc.amount,
                quantity: null,
                dollar_impact: fc.amount - fc.existingAmount,
                percent_change: fc.existingAmount > 0
                    ? (fc.amount - fc.existingAmount) / fc.existingAmount
                    : null,
                verdict: fc.verdict,
                approved_by: approvedBy,
                carrier_name: result.trackingUpdate?.carrierName ?? null,
                tracking_numbers: result.trackingUpdate?.trackingNumbers ?? null,
                source,
            });
        }

        if (rows.length > 0) {
            const { error } = await supabase.from("price_change_audit").insert(rows);
            if (error) {
                console.warn(`⚠️ [reconciler] price_change_audit insert failed: ${error.message}`);
            } else {
                console.log(`📊 [reconciler] Logged ${rows.length} row(s) to price_change_audit`);
            }
        }
    } catch (err: any) {
        // Non-blocking — never interrupt the reconciliation flow
        console.warn(`⚠️ [reconciler] logPriceChangeAudit failed (non-fatal): ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// SUMMARY FORMATTING
// ──────────────────────────────────────────────────

function buildReconciliationSummary(
    orderId: string,
    invoice: InvoiceData,
    priceChanges: PriceChange[],
    feeChanges: FeeChange[],
    trackingUpdate: TrackingUpdate | null,
    totalDollarImpact: number,
    overallVerdict: ReconciliationVerdict,
    warnings: string[] = []
): string {
    const lines: string[] = [];

    // Header
    const emoji = overallVerdict === "auto_approve" ? "✅"
        : overallVerdict === "rejected" ? "🚨"
            : overallVerdict === "duplicate" ? "🔁"
                : overallVerdict === "needs_approval" ? "⚠️"
                    : "ℹ️";

    lines.push(`${emoji} **Invoice Reconciliation: ${invoice.invoiceNumber} → PO ${orderId}**`);
    lines.push(`Vendor: ${invoice.vendorName} | Invoice Total: $${invoice.total.toFixed(2)}`);
    lines.push("");

    // Warnings (vendor mismatch, overbill, etc.)
    if (warnings.length > 0) {
        lines.push("**⚠️ Warnings:**");
        for (const w of warnings) {
            lines.push(`  ${w}`);
        }
        lines.push("");
    }

    // Duplicate — short-circuit the rest
    if (overallVerdict === "duplicate") {
        lines.push("🔁 **DUPLICATE:** This invoice+PO combination has already been reconciled. No changes applied.");
        return lines.join("\n");
    }

    // Price changes
    const meaningful = priceChanges.filter(pc => pc.verdict !== "no_change" && pc.verdict !== "no_match");
    if (meaningful.length > 0) {
        lines.push("**Price Changes:**");
        for (const pc of meaningful) {
            const icon = pc.verdict === "auto_approve" ? "✅"
                : pc.verdict === "rejected" ? "🚨"
                    : "⚠️";
            lines.push(`${icon} ${pc.productId}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)} (${(pc.percentChange * 100).toFixed(1)}%, $${Math.abs(pc.dollarImpact).toFixed(2)} impact)`);
            // Surface overbill / reason details in summary
            if (pc.reason.includes("OVERBILL")) {
                lines.push(`  ⚠️ ${pc.reason.split("|").pop()?.trim()}`);
            }
        }
        lines.push("");
    }

    // Unmatched invoice lines
    const unmatched = priceChanges.filter(pc => pc.verdict === "no_match");
    if (unmatched.length > 0) {
        lines.push("**Unmatched Invoice Lines:**");
        for (const pc of unmatched) {
            lines.push(`❓ ${pc.productId || pc.description.slice(0, 40)}: $${pc.invoicePrice.toFixed(2)} × ${pc.quantity}`);
        }
        lines.push("");
    }

    // Fee changes — now showing per-fee verdict
    if (feeChanges.length > 0) {
        lines.push("**Fee/Charge Updates:**");
        for (const fc of feeChanges) {
            const feeIcon = fc.verdict === "auto_approve" ? "✅" : "⚠️";
            const label = fc.isNew ? "NEW" : `was $${fc.existingAmount.toFixed(2)}`;
            lines.push(`${feeIcon} ${fc.description}: $${fc.amount.toFixed(2)} (${label})`);
            if (fc.verdict === "needs_approval") {
                lines.push(`  ⚠️ ${fc.reason}`);
            }
        }
        lines.push("");
    }

    // Tracking
    if (trackingUpdate) {
        lines.push("**Tracking:**");
        if (trackingUpdate.trackingNumbers.length > 0) {
            lines.push(`🚚 ${trackingUpdate.trackingNumbers.join(", ")}`);
        }
        if (trackingUpdate.shipDate) {
            lines.push(`📅 Ship date: ${trackingUpdate.shipDate}`);
        }
        lines.push("");
    }

    // Total impact
    lines.push(`**Total Dollar Impact:** $${totalDollarImpact.toFixed(2)}`);

    // Verdict
    if (overallVerdict === "auto_approve") {
        lines.push("✅ All changes within auto-approval thresholds. Applying automatically.");
    } else if (overallVerdict === "rejected") {
        lines.push("🚨 **BLOCKED:** Magnitude error detected. Manual correction required.");
    } else if (overallVerdict === "needs_approval") {
        lines.push("⚠️ **Awaiting approval.** Some changes exceed auto-approval thresholds.");
    }

    return lines.join("\n");
}
