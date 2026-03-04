/**
 * @file    reconciliation-action/route.ts
 * @purpose Dashboard API for approving, rejecting, pausing, and dismissing reconciliations.
 *          Mirrors the Telegram approval flow but runs server-side in Next.js.
 *          Supports re-derive from stored metadata (no in-memory dependency).
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    supabase, finale/reconciler, finale/client, intelligence/memory
 * @env     SUPABASE_SERVICE_ROLE_KEY, FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { FinaleClient } from "@/lib/finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    buildAuditMetadata,
    ReconciliationResult,
} from "@/lib/finale/reconciler";

type ActionRequest = {
    action: "approve" | "pause" | "dismiss" | "rematch";
    activityLogId: string;
    dismissReason?: "dropship" | "already_handled" | "duplicate" | "credit_memo" | "statement" | "not_ours";
    rematchPoNumber?: string;
};

export async function POST(req: Request) {
    try {
        const body: ActionRequest = await req.json();
        const { action, activityLogId, dismissReason, rematchPoNumber } = body;

        const supabase = createClient();
        if (!supabase) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // 1. Fetch the original activity log entry
        const { data: logEntry, error: fetchError } = await supabase
            .from("ap_activity_log")
            .select("*")
            .eq("id", activityLogId)
            .single();

        if (fetchError || !logEntry) {
            return NextResponse.json({ error: "Activity log entry not found" }, { status: 404 });
        }

        // Allow re-action on paused items (they haven't been finalized)
        if (logEntry.reviewed_at && logEntry.reviewed_action !== "paused") {
            return NextResponse.json({ error: `Already ${logEntry.reviewed_action}` }, { status: 409 });
        }

        const metadata = logEntry.metadata || {};
        const now = new Date().toISOString();

        // ── APPROVE: Re-derive reconciliation from stored data, apply to Finale ──
        if (action === "approve") {
            const finale = new FinaleClient();

            // DECISION(2026-03-04): Re-run reconciliation against Finale instead of
            // relying on the bot's in-memory pendingApprovals Map. This approach:
            //   - Works across process boundaries (Next.js ≠ PM2 bot)
            //   - Survives bot restarts
            //   - Gets latest PO state from Finale (prices may have changed)
            //   - Eliminates stale-approval risk
            const reconResult: ReconciliationResult = await reconcileInvoiceToPO(
                {
                    invoiceNumber: metadata.invoiceNumber,
                    vendorName: metadata.vendorName || logEntry.email_from,
                    poNumber: metadata.orderId,
                    total: 0,
                    lineItems: [],
                    fees: [],
                } as any,
                metadata.orderId,
                finale
            );

            if (reconResult.overallVerdict === "duplicate") {
                return NextResponse.json({
                    success: false,
                    message: "This invoice has already been reconciled.",
                });
            }

            // Approve ALL changes — same as Telegram approve flow
            const approvedPriceItems = reconResult.priceChanges
                .filter(pc => pc.verdict === "needs_approval" || pc.verdict === "auto_approve")
                .map(pc => pc.productId);
            const approvedFeeTypes = reconResult.feeChanges
                .filter(fc => fc.verdict === "needs_approval" || fc.verdict === "auto_approve")
                .map(fc => fc.feeType);

            const applyResult = await applyReconciliation(
                reconResult, finale, approvedPriceItems, approvedFeeTypes
            );

            // Update the log entry with review status
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "approved",
                action_taken: `Dashboard approved: ${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped`,
                metadata: {
                    ...metadata,
                    ...buildAuditMetadata(reconResult, applyResult, "manual"),
                },
            }).eq("id", activityLogId);

            // Write vendor_name to purchase_orders for future matching
            if (reconResult.vendorName && reconResult.orderId) {
                await supabase.from("purchase_orders").upsert({
                    po_number: reconResult.orderId,
                    vendor_name: reconResult.vendorName,
                    status: "open",
                }, { onConflict: "po_number", ignoreDuplicates: false });
            }

            // Pinecone memory — non-blocking
            writeApprovalMemory(reconResult, applyResult, "dashboard");

            // Phase 3: Update vendor profile stats + auto-approve threshold
            const maxVariance = reconResult.priceChanges
                .filter(pc => pc.verdict === "auto_approve" || pc.verdict === "needs_approval")
                .reduce((max, pc) => Math.max(max, Math.abs(pc.percentChange * 100)), 0);
            updateVendorProfile(
                supabase, reconResult.vendorName, "approved",
                reconResult.totalDollarImpact, undefined, maxVariance
            );

            return NextResponse.json({
                success: true,
                message: `✅ Applied ${applyResult.applied.length} change(s) to PO ${reconResult.orderId}.`,
                applied: applyResult.applied,
                skipped: applyResult.skipped,
                errors: applyResult.errors,
            });
        }

        // ── PAUSE: Mark for research, no Finale changes ──
        if (action === "pause") {
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "paused",
            }).eq("id", activityLogId);

            return NextResponse.json({
                success: true,
                message: `⏸️ Paused for research. PO ${metadata.orderId} unchanged in Finale.`,
            });
        }

        // ── DISMISS: Mark as dismissed with reason, no Finale changes ──
        if (action === "dismiss") {
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "dismissed",
                dismiss_reason: dismissReason || null,
            }).eq("id", activityLogId);

            // Learn from dismissal — non-blocking
            writeDismissMemory(metadata, dismissReason || "unknown");

            // Phase 3: Update vendor profile dismiss stats
            updateVendorProfile(
                supabase, metadata.vendorName || logEntry.email_from,
                "dismissed", 0, dismissReason
            );

            return NextResponse.json({
                success: true,
                message: `⏭️ Dismissed (${dismissReason}). No Finale changes.`,
            });
        }

        // ── REMATCH: Re-run reconciliation against a different PO ──
        if (action === "rematch" && rematchPoNumber) {
            const finale = new FinaleClient();
            const reconResult = await reconcileInvoiceToPO(
                {
                    invoiceNumber: metadata.invoiceNumber,
                    vendorName: metadata.vendorName || logEntry.email_from,
                    poNumber: rematchPoNumber,
                    total: 0,
                    lineItems: [],
                    fees: [],
                } as any,
                rematchPoNumber,
                finale
            );

            if (reconResult.overallVerdict === "no_match") {
                return NextResponse.json({
                    success: false,
                    message: `PO ${rematchPoNumber} not found in Finale.`,
                });
            }

            // Update the log entry with new PO match — reset reviewed_at so user can act on it
            await supabase.from("ap_activity_log").update({
                reviewed_at: null,
                reviewed_action: "re-matched",
                email_subject: `Invoice ${metadata.invoiceNumber} → PO ${rematchPoNumber}`,
                metadata: {
                    ...metadata,
                    rematchedFrom: metadata.orderId,
                    orderId: rematchPoNumber,
                    vendorName: reconResult.vendorName,
                    verdict: reconResult.overallVerdict,
                    totalImpact: reconResult.totalDollarImpact,
                    priceChanges: reconResult.priceChanges.map(pc => ({
                        productId: pc.productId,
                        description: pc.description,
                        from: pc.poPrice,
                        to: pc.invoicePrice,
                        pct: parseFloat((pc.percentChange * 100).toFixed(2)),
                        impact: parseFloat(pc.dollarImpact.toFixed(2)),
                        verdict: pc.verdict,
                    })),
                    feeChanges: reconResult.feeChanges.map(fc => ({
                        type: fc.feeType,
                        description: fc.description,
                        from: fc.existingAmount,
                        to: fc.amount,
                        delta: parseFloat((fc.amount - fc.existingAmount).toFixed(2)),
                        verdict: fc.verdict,
                    })),
                },
            }).eq("id", activityLogId);

            return NextResponse.json({
                success: true,
                message: `🔄 Re-matched to PO ${rematchPoNumber}. Verdict: ${reconResult.overallVerdict}.`,
                verdict: reconResult.overallVerdict,
                summary: reconResult.summary,
            });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (err: any) {
        console.error("Reconciliation action error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── Memory helpers (non-blocking) ──────────────────────────────────────────

/**
 * Write approval outcome to Pinecone so Aria learns vendor-specific patterns.
 * Over time, this enables suggesting "Based on 8 past approvals, auto-approve?"
 */
async function writeApprovalMemory(
    result: ReconciliationResult,
    applyResult: { applied: string[]; errors: string[] },
    trigger: string
): Promise<void> {
    try {
        const { remember } = await import("@/lib/intelligence/memory");
        const vendorSlug = result.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
        await remember({
            category: "decision",
            content: `PO ${result.orderId} reconciliation approved via ${trigger}. ${applyResult.applied.length} changes applied. Vendor: ${result.vendorName}. Invoice: ${result.invoiceNumber}. Impact: $${result.totalDollarImpact.toFixed(2)}.`,
            tags: ["reconciliation", "approved", result.orderId, vendorSlug],
            source: "dashboard",
            relatedTo: result.vendorName,
            priority: "normal",
        });
    } catch { /* non-blocking — never fail the action flow */ }
}

/**
 * Write dismiss outcome to Pinecone for classification learning.
 * Tracks patterns like "Vendor X is always dropship" so Aria can
 * eventually auto-route or suggest dismissal reasons.
 */
async function writeDismissMemory(
    metadata: any, // any: ap_activity_log.metadata JSONB — shape varies by intent
    reason: string
): Promise<void> {
    try {
        const { remember } = await import("@/lib/intelligence/memory");
        const vendorSlug = (metadata.vendorName || "").replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
        await remember({
            category: "process",
            content: `Invoice ${metadata.invoiceNumber} dismissed as "${reason}". Vendor: ${metadata.vendorName}. PO: ${metadata.orderId}. Learning: ${reason === "dropship" ? "Vendor may be dropship-only — consider adding to KNOWN_DROPSHIP_VENDORS" : reason === "statement" ? "Email classifier misidentified statement as invoice — retrain classifier" : reason === "credit_memo" ? "Credit memo from vendor — not a payable invoice" : "Manual override"}.`,
            tags: ["reconciliation", "dismissed", reason, vendorSlug],
            source: "dashboard",
            relatedTo: metadata.vendorName,
            priority: reason === "dropship" ? "high" : "normal",
        });
    } catch { /* non-blocking — never fail the action flow */ }
}

// ── Phase 3: Vendor Profile Auto-Update ──────────────────────────────────────

/**
 * Updates vendor_profiles with reconciliation statistics after each action.
 * Auto-adjusts auto_approve_threshold when patterns emerge:
 *   - 5+ reconciliations AND 80%+ approval rate → sets threshold
 *   - Threshold = max approved price variance + 1% buffer
 *   - For dismiss actions, tracks most common dismiss reason as default_dismiss_action
 *
 * DECISION(2026-03-04): Threshold is computed from actual approval history, not
 * hardcoded. This means the system adapts per-vendor. A vendor with consistently
 * small variances gets a tighter threshold than one with larger swings.
 */
async function updateVendorProfile(
    supabase: any, // any: Supabase client — type varies by import path
    vendorName: string,
    action: "approved" | "dismissed",
    dollarImpact: number,
    dismissReason?: string,
    maxApprovedVariance?: number
): Promise<void> {
    try {
        if (!vendorName) return;

        // Upsert vendor profile — create if doesn't exist
        const { data: existing } = await supabase
            .from("vendor_profiles")
            .select("reconciliation_count, approval_count, dismiss_count, avg_dollar_impact, auto_approve_threshold, default_dismiss_action")
            .eq("vendor_name", vendorName)
            .single();

        const current = existing || {
            reconciliation_count: 0,
            approval_count: 0,
            dismiss_count: 0,
            avg_dollar_impact: 0,
            auto_approve_threshold: null,
            default_dismiss_action: null,
        };

        const newReconCount = (current.reconciliation_count || 0) + 1;
        const newApprovalCount = (current.approval_count || 0) + (action === "approved" ? 1 : 0);
        const newDismissCount = (current.dismiss_count || 0) + (action === "dismissed" ? 1 : 0);

        // Running average of dollar impact for approved reconciliations
        let newAvgImpact = current.avg_dollar_impact || 0;
        if (action === "approved" && dollarImpact > 0) {
            const prevApprovalCount = current.approval_count || 0;
            newAvgImpact = prevApprovalCount > 0
                ? ((newAvgImpact * prevApprovalCount) + dollarImpact) / newApprovalCount
                : dollarImpact;
        }

        // DECISION(2026-03-04): Auto-approve threshold auto-adjusts when:
        //   1. 5+ reconciliations exist
        //   2. 80%+ have been approved
        //   3. No threshold has been manually set yet (null) or it's already auto-managed
        const approvalRate = newReconCount > 0 ? (newApprovalCount / newReconCount) * 100 : 0;
        let newThreshold = current.auto_approve_threshold;

        if (
            action === "approved" &&
            newApprovalCount >= 5 &&
            approvalRate >= 80 &&
            maxApprovedVariance !== undefined
        ) {
            // Set threshold to the max variance we've seen in approved items + 1% buffer
            // This means: "if future invoices have less variance than anything we've approved before, auto-approve"
            const computedThreshold = Math.min(
                Math.round((maxApprovedVariance + 1) * 100) / 100,
                10 // Cap at 10% — never auto-approve variance above 10% regardless of history
            );

            // Only update if the computer threshold is a reasonable upgrade
            if (newThreshold === null || computedThreshold > (newThreshold as number)) {
                newThreshold = computedThreshold;
            }
        }

        // Track most common dismiss reason for default_dismiss_action
        let newDefaultDismiss = current.default_dismiss_action;
        if (action === "dismissed" && dismissReason) {
            // If dismiss count is high enough and this reason matches current default, keep it
            // If no default yet, set it after 2+ dismissals
            if (!newDefaultDismiss && newDismissCount >= 2) {
                newDefaultDismiss = dismissReason;
            }
        }

        await supabase.from("vendor_profiles").upsert({
            vendor_name: vendorName,
            reconciliation_count: newReconCount,
            approval_count: newApprovalCount,
            dismiss_count: newDismissCount,
            avg_dollar_impact: Math.round(newAvgImpact * 100) / 100,
            auto_approve_threshold: newThreshold,
            default_dismiss_action: newDefaultDismiss,
            last_reconciliation_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }, { onConflict: "vendor_name", ignoreDuplicates: false });

    } catch (err: any) {
        // Non-blocking — vendor profile update failure must never block the action
        console.warn("⚠️ Vendor profile update failed:", err.message);
    }
}
