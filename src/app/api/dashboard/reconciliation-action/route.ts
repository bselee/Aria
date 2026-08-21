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
import { createClient } from "@/lib/db";
import { FinaleClient } from "@/lib/finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    buildAuditMetadata,
    ReconciliationResult,
} from "@/lib/finale/reconciler";
import * as apIssue from "@/lib/intelligence/ap-issue";
import {
    resolvePendingReconciliationOutcomeBySource,
    writeReconciliationOutcome,
} from "@/lib/runtime/observability/reconciliation-outcomes";
import {
    runAutoMatchUnmatched,
    applyPOCandidate as libApplyPOCandidate,
    approveCloseMatchUnreconciled,
} from "@/lib/purchasing/auto-match-unmatched";

const supabase = createClient();

type ActionRequest = {
    action: "approve" | "pause" | "dismiss" | "rematch" | "disregard" | "approve_unreconciled" | "disregard_unreconciled" | "run_auto_match" | "apply_po_candidate" | "approve_matched_unreconciled_bulk";
    activityLogId?: string;
    dismissReason?: "already_handled" | "duplicate" | "credit_memo" | "statement" | "not_ours";
    rematchPoNumber?: string;
    /** Keyed on vendor_invoices.id (UUID), NOT activityLogId, because unmatched
     *  invoices have no activity log row. The existing dismiss path is unusable
     *  for these — disregard is a separate action for the same reason. */
    invoiceId?: string;
    /** PO number for matched_unreconciled action — required when approving/disregarding
     *  a matched_unreconciled invoice so the confirmed_po_matches entry is recorded. */
    poNumber?: string;
    reason?: string;
    markedBy?: string;
};

export async function POST(req: Request) {
    try {
        const body: ActionRequest = await req.json();
        const { action, activityLogId, dismissReason, rematchPoNumber } = body;

        const db = createClient();
        if (!db) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // 1. Fetch the original activity log entry (skipped for disregard and unreconciled actions — those invoices have no activity log)
        let logEntry: any = null;
        let fetchError: any = null;

        if (action !== "disregard" && action !== "approve_unreconciled" && action !== "disregard_unreconciled" && action !== "disregard_vendor" && action !== "apply_po_candidate" && action !== "run_auto_match" && action !== "approve_matched_unreconciled_bulk") {
            const result = await supabase
                .from("ap_activity_log")
                .select("*")
                .eq("id", activityLogId)
                .single();
            logEntry = result.data;
            fetchError = result.error;

            if (fetchError || !logEntry) {
                return NextResponse.json({ error: "Activity log entry not found" }, { status: 404 });
            }

            // Allow re-action on paused items (they haven't been finalized)
            if (logEntry.reviewed_at && logEntry.reviewed_action !== "paused") {
                return NextResponse.json({ error: `Already ${logEntry.reviewed_action}` }, { status: 409 });
            }
        }

        const metadata = logEntry?.metadata || {};
        const now = new Date().toISOString();

        // ── APPROVE: Re-derive reconciliation from stored data, apply to Finale ──
        if (action === "approve") {
            const finale = new FinaleClient();

            let reconResult: ReconciliationResult;

            if (logEntry.intent === "RECONCILIATION" && logEntry.action_taken === "Dashboard review required - awaiting approval" && metadata.priceChanges) {
                // Use stored reconciliation result from dashboard review entry
                reconResult = {
                    orderId: metadata.orderId,
                    invoiceNumber: metadata.invoiceNumber,
                    vendorName: metadata.vendorName || logEntry.email_from,
                    invoiceTotal: 0, // Not stored, set to 0
                    priceChanges: metadata.priceChanges,
                    feeChanges: metadata.feeChanges,
                    trackingUpdate: null,
                    overallVerdict: metadata.overallVerdict,
                    summary: `Dashboard approved: ${metadata.totalDollarImpact || 0} impact`,
                    totalDollarImpact: metadata.totalDollarImpact || 0,
                    autoApplicable: false,
                    warnings: metadata.balanceCheck?.message ? [metadata.balanceCheck.message] : [],
                    report: metadata.reconciliation_report,
                };
            } else {
                // DECISION(2026-03-04): Re-run reconciliation against Finale instead of
                // relying on the bot's in-memory pendingApprovals Map. This approach:
                //   - Works across process boundaries (Next.js ≠ PM2 bot)
                //   - Survives bot restarts
                //   - Gets latest PO state from Finale (prices may have changed)
                //   - Eliminates stale-approval risk
                reconResult = await reconcileInvoiceToPO(
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
            }

            // Approve ALL changes — same as Telegram approve flow
            const approvedPriceItems = reconResult.priceChanges
                .filter(pc => pc.verdict === "needs_approval" || pc.verdict === "auto_approve" || pc.verdict === "short_shipment_hold")
                .map(pc => pc.productId);
            const approvedFeeTypes = reconResult.feeChanges
                .filter(fc => fc.verdict === "needs_approval" || fc.verdict === "auto_approve")
                .map(fc => fc.feeType);

            // Phase 2 (path-forward plan): audit context flows through so the
            // dashboard approve path also writes per-call Finale-write audit
            // rows. Use ap-reconciler agent identity to keep audit consistent
            // across Telegram + dashboard surfaces.
            const dashboardIssueId = await apIssue.findApIssue({
                vendorName: reconResult.vendorName,
                invoiceNumber: reconResult.invoiceNumber,
                poNumber: reconResult.orderId,
                orderId: reconResult.orderId,
            });
            const applyResult = await applyReconciliation(
                reconResult,
                finale,
                approvedPriceItems,
                approvedFeeTypes,
                { agent: "ap-reconciler", issueId: dashboardIssueId },
            );

            // Update the log entry with review status
            await db.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "approved",
                action_taken: `Dashboard approved: ${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped`,
                metadata: {
                    ...metadata,
                    ...buildAuditMetadata(reconResult, applyResult, "manual"),
                },
            }).eq("id", activityLogId);

            await resolvePendingReconciliationOutcomeBySource({
                sourceActivityLogId: activityLogId,
                resolution: "approved_by_user",
                resolvedAt: new Date(now),
            });
            await writeReconciliationOutcome({
                runId: crypto.randomUUID(),
                outcome: "approved_by_user",
                invoiceId: reconResult.invoiceNumber ?? undefined,
                poId: reconResult.orderId ?? undefined,
                vendorName: reconResult.vendorName ?? undefined,
                outcomeMeta: {
                    source_activity_log_id: activityLogId,
                    applied_count: applyResult.applied.length,
                    skipped_count: applyResult.skipped.length,
                    error_count: applyResult.errors.length,
                    total_dollar_impact: reconResult.totalDollarImpact,
                },
                resolvedAt: new Date(now),
            });

            // Write vendor_name to purchase_orders for future matching
            if (reconResult.vendorName && reconResult.orderId) {
                await db.from("purchase_orders").upsert({
                    po_number: reconResult.orderId,
                    vendor_name: reconResult.vendorName,
                    status: "open",
                }, { onConflict: "po_number", ignoreDuplicates: false });
            }

            // Pinecone memory — non-blocking
            writeApprovalMemory(reconResult, applyResult, "dashboard");

            // Phase 3: Update vendor profile stats + auto-approve threshold
            const maxVariance = reconResult.priceChanges
                .filter(pc => pc.verdict === "auto_approve" || pc.verdict === "needs_approval" || pc.verdict === "short_shipment_hold")
                .reduce((max, pc) => Math.max(max, Math.abs(pc.percentChange * 100)), 0);
            updateVendorProfile(
                supabase, reconResult.vendorName, "approved",
                reconResult.totalDollarImpact, undefined, maxVariance
            );

            // Phase 2 issue ledger: clear the human_approval_required blocker
            // and mark the issue complete. Best-effort — same contract as the
            // Telegram path. Activity logs predating Phase 2 won't have a
            // matching issue and that's fine.
            const approvedIssueId = await apIssue.findApIssue({
                vendorName: reconResult.vendorName,
                invoiceNumber: reconResult.invoiceNumber,
                poNumber: reconResult.orderId,
                orderId: reconResult.orderId,
            });
            if (approvedIssueId) {
                await apIssue.unblockApIssue(approvedIssueId, "working");
                await apIssue.completeApIssue(approvedIssueId, {
                    resolution: "approved",
                    approved_by: "Will",
                    approved_via: "dashboard",
                    applied: applyResult.applied.length,
                    skipped: applyResult.skipped.length,
                    errors: applyResult.errors.length,
                });
            }

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
            await db.from("ap_activity_log").update({
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
            await db.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "dismissed",
                dismiss_reason: dismissReason || null,
            }).eq("id", activityLogId);

            await resolvePendingReconciliationOutcomeBySource({
                sourceActivityLogId: activityLogId,
                resolution: "rejected_by_user",
                resolvedAt: new Date(now),
            });
            await writeReconciliationOutcome({
                runId: crypto.randomUUID(),
                outcome: "rejected_by_user",
                invoiceId: metadata.invoiceNumber ?? undefined,
                poId: metadata.orderId ?? undefined,
                vendorName: metadata.vendorName ?? logEntry.email_from ?? undefined,
                outcomeMeta: {
                    source_activity_log_id: activityLogId,
                    dismiss_reason: dismissReason ?? null,
                },
                resolvedAt: new Date(now),
            });

            // Learn from dismissal — non-blocking
            writeDismissMemory(metadata, dismissReason || "unknown");

            // Phase 3: Update vendor profile dismiss stats
            updateVendorProfile(
                supabase, metadata.vendorName || logEntry.email_from,
                "dismissed", 0, dismissReason
            );

            // Phase 2 issue ledger: a dismissal IS a resolution (Will decided no
            // action needed). Unblock + complete with the dismiss reason so the
            // issue timeline records why.
            const dismissedIssueId = await apIssue.findApIssue({
                vendorName: metadata.vendorName || logEntry.email_from,
                invoiceNumber: metadata.invoiceNumber,
                poNumber: metadata.orderId,
                orderId: metadata.orderId,
            });
            if (dismissedIssueId) {
                await apIssue.unblockApIssue(dismissedIssueId, "working");
                await apIssue.completeApIssue(dismissedIssueId, {
                    resolution: "dismissed",
                    dismissed_by: "Will",
                    dismiss_reason: dismissReason ?? "unknown",
                });
            }

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
            await db.from("ap_activity_log").update({
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

            // Phase 2 issue ledger: rematch changes the businessFlowKey (the PO
            // is part of the key). The OLD issue is resolved by Will's decision
            // to rematch; a NEW issue will be created on the next reconcile
            // against the new PO via ensureApIssue's normal path. Complete the
            // old one here with resolution=rematched so the timeline reflects
            // the human decision.
            const oldIssueId = await apIssue.findApIssue({
                vendorName: metadata.vendorName || logEntry.email_from,
                invoiceNumber: metadata.invoiceNumber,
                poNumber: metadata.orderId,
                orderId: metadata.orderId,
            });
            if (oldIssueId) {
                await apIssue.unblockApIssue(oldIssueId, "working");
                await apIssue.completeApIssue(oldIssueId, {
                    resolution: "rematched",
                    rematched_by: "Will",
                    rematched_from_po: metadata.orderId,
                    rematched_to_po: rematchPoNumber,
                });
            }

            return NextResponse.json({
                success: true,
                message: `🔄 Re-matched to PO ${rematchPoNumber}. Verdict: ${reconResult.overallVerdict}.`,
                verdict: reconResult.overallVerdict,
                summary: reconResult.summary,
            });
        }

        // ── DISREGARD: Mark an unmatched invoice as "not a PO purchase" — no activity log needed ──
        // Unlike dismiss (which records on ap_activity_log), disregard writes directly to
        // vendor_invoices because unmatched invoices have no activity log entry. The action
        // is keyed on invoiceId (vendor_invoices.id UUID), not activityLogId.
        // DECISION(2026-08-02): Keeping disregard separate from dismiss prevents the subtle
        // bug of trying to write reviewed_action on a non-existent activity log row, and
        // makes it explicit in the codebase that these are different lifecycle paths.
        if (action === "disregard") {
            if (!body.invoiceId || typeof body.invoiceId !== "string" || body.invoiceId.trim() === "") {
                return NextResponse.json(
                    { error: "invoiceId is required" },
                    { status: 400 }
                );
            }

            // Verify the invoice exists
            const { data: invoice, error: fetchError } = await db
                .from("vendor_invoices")
                .select("id, invoice_number, vendor_name")
                .eq("id", body.invoiceId)
                .single();

            if (fetchError || !invoice) {
                return NextResponse.json(
                    { error: "Invoice not found" },
                    { status: 404 }
                );
            }

            // Set disregard columns — idempotent (setting again is not an error)
            // action_required = true signifies this is a DELIBERATE human decision,
            // not a systemic dropship classification. The owning team uses this to
            // distinguish invoices needing periodic review from systemic no-PO items.
            await db
                .from("vendor_invoices")
                .update({
                    no_po_required: true,
                    no_po_reason: body.reason || null,
                    no_po_marked_by: body.markedBy || null,
                    no_po_marked_at: new Date().toISOString(),
                    action_required: true,
                })
                .eq("id", body.invoiceId);

            // Phase 2 issue ledger: if this invoice has an open issue, close it
            try {
                const issueId = await apIssue.findApIssue({
                    vendorName: invoice.vendor_name || "Unknown",
                    invoiceNumber: invoice.invoice_number || "",
                    poNumber: "",
                    orderId: "",
                });
                if (issueId) {
                    await apIssue.unblockApIssue(issueId, "working");
                    await apIssue.completeApIssue(issueId, {
                        resolution: "disregarded",
                        dismissed_by: body.markedBy || "dashboard",
                        dismiss_reason: body.reason || "not_a_po_purchase",
                    });
                }
            } catch { /* non-blocking — issue ledger is best-effort */ }

            return NextResponse.json({
                success: true,
                message: `🚫 Invoice ${invoice.invoice_number || ''} marked as not a PO purchase.`,
            });
        }

        // ── DISREGARD VENDOR: Bulk-disregard ALL unmatched invoices from a vendor ──
        // Sets no_po_required=true on every unmatched vendor_invoice from this vendor
        // at once. Optionally sets requires_po=false on vendor_profiles so future
        // invoices never surface.
        if (action === "disregard_vendor") {
            const vendorName = body.vendorName;
            if (!vendorName || typeof vendorName !== "string" || vendorName.trim() === "") {
                return NextResponse.json(
                    { error: "vendorName is required" },
                    { status: 400 }
                );
            }

            const now = new Date().toISOString();
            const reason = body.reason || "vendor_no_po_required";
            const markedBy = body.markedBy || "dashboard";

            // Step 1: Find all unmatched vendor_invoices for this vendor
            const { data: vendorInvoices, error: viFetchErr } = await db
                .from("vendor_invoices")
                .select("id, invoice_number")
                .eq("vendor_name", vendorName)
                .or("no_po_required.is.null,no_po_required.eq.false");

            if (viFetchErr) {
                return NextResponse.json(
                    { error: `Failed to fetch vendor invoices: ${viFetchErr.message}` },
                    { status: 500 }
                );
            }

            const invoiceIds = (vendorInvoices ?? []).map((vi: any) => vi.id);
            const invoiceNumbers = (vendorInvoices ?? []).map((vi: any) => vi.invoice_number).filter(Boolean);

            // Step 2: Aggregate total disregard value if we can
            const { data: totals } = await db
                .from("vendor_invoices")
                .select("total")
                .in("id", invoiceIds.length > 0 ? invoiceIds : ["00000000-0000-0000-0000-000000000000"]);

            const totalValue = (totals ?? []).reduce((sum: number, r: any) => sum + Number(r.total ?? 0), 0);

            // Step 3: Update vendor_invoices — bulk disregard
            if (invoiceIds.length > 0) {
                await db
                    .from("vendor_invoices")
                    .update({
                        no_po_required: true,
                        no_po_reason: reason,
                        no_po_marked_by: markedBy,
                        no_po_marked_at: now,
                        action_required: true,
                    })
                    .in("id", invoiceIds);
                // (Legacy `invoices` is now a read-only view over vendor_invoices —
                // the Step 3 write is what the queue sees; no separate legacy update.)
            }

            // Step 5: Optionally mark vendor profile as requires_po=false
            if (body.alsoMarkVendor) {
                await db.from("vendor_profiles").upsert({
                    vendor_name: vendorName,
                    requires_po: false,
                    updated_at: now,
                    last_reconciliation_at: now,
                }, { onConflict: "vendor_name", ignoreDuplicates: false });
            }

            // Step 6: Close any open issues for these invoices (best-effort)
            for (const invNum of invoiceNumbers) {
                try {
                    const issueId = await apIssue.findApIssue({
                        vendorName: vendorName,
                        invoiceNumber: invNum,
                        poNumber: "",
                        orderId: "",
                    });
                    if (issueId) {
                        await apIssue.unblockApIssue(issueId, "working");
                        await apIssue.completeApIssue(issueId, {
                            resolution: "disregarded",
                            dismissed_by: markedBy,
                            dismiss_reason: reason,
                        });
                    }
                } catch { /* non-blocking */ }
            }

            const count = invoiceIds.length;
            const dollarFmt = totalValue !== 0
                ? ` ($${Math.abs(totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total)`
                : "";

            const vendorNote = body.alsoMarkVendor
                ? " Vendor profile updated — future invoices will not appear."
                : "";

            return NextResponse.json({
                success: true,
                message: `🚫 ${count} invoice${count !== 1 ? "s" : ""} from ${vendorName} disregarded.${dollarFmt}${vendorNote}`,
                count,
                vendorName,
                totalDisregardedValue: totalValue,
                alsoMarkedVendor: !!body.alsoMarkVendor,
            });
        }

        // ── APPROVE UNRECONCILED: Confirm a PO match for a matched_unreconciled invoice ──
        // matched_unreconciled invoices have a poNumber set but no activity log entry.
        // This action writes a confirmed_po_matches row so the matcher learns, and inserts
        // an ap_activity_log stub so the invoice leaves the queue permanently.
        if (action === "approve_unreconciled") {
            if (!body.invoiceId || typeof body.invoiceId !== "string" || body.invoiceId.trim() === "") {
                return NextResponse.json(
                    { error: "invoiceId is required" },
                    { status: 400 }
                );
            }
            if (!body.poNumber || typeof body.poNumber !== "string" || body.poNumber.trim() === "") {
                return NextResponse.json(
                    { error: "poNumber is required" },
                    { status: 400 }
                );
            }

            // Verify the invoice exists
            const { data: invoice, error: fetchError } = await db
                .from("vendor_invoices")
                .select("id, invoice_number, vendor_name")
                .eq("id", body.invoiceId)
                .single();

            if (fetchError || !invoice) {
                return NextResponse.json(
                    { error: "Invoice not found" },
                    { status: 404 }
                );
            }

            // Write confirmed_po_matches entry — the matcher reads this to boost scores
            await db.from("confirmed_po_matches").upsert({
                vendor_name: invoice.vendor_name || "Unknown",
                po_number: body.poNumber.trim(),
                invoice_id: invoice.id,
                invoice_number: invoice.invoice_number || "",
                confirmed_by: body.markedBy || "dashboard",
                confirmed_at: now,
            }, { onConflict: "vendor_name, po_number", ignoreDuplicates: false });

            // Insert an ap_activity_log stub so the queue filters this invoice out
            // (reviewed_action='approved' causes the queue to skip it)
            await db.from("ap_activity_log").insert({
                email_from: invoice.vendor_name || "Unknown",
                email_subject: `Approved matched_unreconciled: Invoice ${invoice.invoice_number || ''} → PO ${body.poNumber.trim()}`,
                intent: "RECONCILIATION",
                action_taken: "Matched unreconciled approved by user",
                reviewed_at: now,
                reviewed_action: "approved",
                metadata: {
                    invoiceNumber: invoice.invoice_number || "",
                    vendorName: invoice.vendor_name || "",
                    orderId: body.poNumber.trim(),
                    source: "dashboard_approve_unreconciled",
                },
            });

            // Learn: update vendor_profiles approval stats
            updateVendorProfile(
                supabase, invoice.vendor_name || "Unknown",
                "approved", 0
            );

            return NextResponse.json({
                success: true,
                message: `✅ Confirmed PO ${body.poNumber.trim()} for ${invoice.vendor_name || 'vendor'} (invoice ${invoice.invoice_number || ''}). Learned for future matches.`,
            });
        }

        // ── DISREGARD UNRECONCILED: Mark a matched_unreconciled invoice as not a PO purchase ──
        // Same basic approach as the unmatched disregard, but also updates vendor_profiles
        // disregard_count so after N dismissals the system suggests auto-dismiss for this vendor.
        if (action === "disregard_unreconciled") {
            if (!body.invoiceId || typeof body.invoiceId !== "string" || body.invoiceId.trim() === "") {
                return NextResponse.json(
                    { error: "invoiceId is required" },
                    { status: 400 }
                );
            }

            // Verify the invoice exists
            const { data: invoice, error: fetchError } = await db
                .from("vendor_invoices")
                .select("id, invoice_number, vendor_name")
                .eq("id", body.invoiceId)
                .single();

            if (fetchError || !invoice) {
                return NextResponse.json(
                    { error: "Invoice not found" },
                    { status: 404 }
                );
            }

            // Set disregard columns on vendor_invoices — same as unmatched disregard
            await db
                .from("vendor_invoices")
                .update({
                    no_po_required: true,
                    no_po_reason: body.reason || null,
                    no_po_marked_by: body.markedBy || null,
                    no_po_marked_at: now,
                    action_required: true,
                })
                .eq("id", body.invoiceId);

            // Learn: increment disregard_count on vendor_profiles for this vendor
            // When disregard_count >= 3, auto_suggest_no_po is set to true to
            // suggest future invoices from this vendor auto-dismiss.
            try {
                const vendorName = invoice.vendor_name || "Unknown";
                const { data: existingProfile } = await supabase
                    .from("vendor_profiles")
                    .select("disregard_count, auto_suggest_no_po")
                    .eq("vendor_name", vendorName)
                    .single();

                const currentDisregardCount = (existingProfile?.disregard_count ?? 0) + 1;
                const shouldSuggest = currentDisregardCount >= 3;

                await supabase.from("vendor_profiles").upsert({
                    vendor_name: vendorName,
                    disregard_count: currentDisregardCount,
                    auto_suggest_no_po: shouldSuggest,
                    dismiss_count: currentDisregardCount, // Also sync dismiss_count for consistency
                    updated_at: now,
                    last_reconciliation_at: now,
                }, { onConflict: "vendor_name", ignoreDuplicates: false });
            } catch { /* non-blocking — vendor profile update must never fail the action */ }

            // Phase 2 issue ledger: best-effort close any open issue
            try {
                const issueId = await apIssue.findApIssue({
                    vendorName: invoice.vendor_name || "Unknown",
                    invoiceNumber: invoice.invoice_number || "",
                    poNumber: "",
                    orderId: "",
                });
                if (issueId) {
                    await apIssue.unblockApIssue(issueId, "working");
                    await apIssue.completeApIssue(issueId, {
                        resolution: "disregarded",
                        dismissed_by: body.markedBy || "dashboard",
                        dismiss_reason: body.reason || "not_a_po_purchase",
                    });
                }
            } catch { /* non-blocking */ }

            return NextResponse.json({
                success: true,
                message: `🚫 Invoice ${invoice.invoice_number || ''} (${invoice.vendor_name || 'vendor'}) marked as not a PO purchase. Vendor disregard count updated.`,
            });
        }

        // ── APPLY PO CANDIDATE: Assign a PO to an unmatched invoice via chip click ──
        // Unmatched invoices have no activity log entry. This action assigns the selected
        // PO to the invoice, making it matched_unreconciled so the user can confirm or
        // dismiss it from the matched section.
        if (action === "apply_po_candidate") {
            if (!body.invoiceId || typeof body.invoiceId !== "string" || body.invoiceId.trim() === "") {
                return NextResponse.json(
                    { error: "invoiceId is required" },
                    { status: 400 }
                );
            }
            if (!body.poNumber || typeof body.poNumber !== "string" || body.poNumber.trim() === "") {
                return NextResponse.json(
                    { error: "poNumber is required" },
                    { status: 400 }
                );
            }

            // Verify the invoice exists
            const { data: invoice, error: fetchError } = await db
                .from("vendor_invoices")
                .select("id, invoice_number, vendor_name, po_number")
                .eq("id", body.invoiceId)
                .single();

            if (fetchError || !invoice) {
                return NextResponse.json(
                    { error: "Invoice not found" },
                    { status: 404 }
                );
            }

            // Skip if already has a PO
            if (invoice.po_number) {
                return NextResponse.json({
                    success: true,
                    message: `Invoice ${invoice.invoice_number || ''} already has PO ${invoice.po_number}.`,
                });
            }

            const poNumber = body.poNumber.trim();
            const now = new Date().toISOString();

            // Update vendor_invoices with the selected PO
            await db
                .from("vendor_invoices")
                .update({
                    po_number: poNumber,
                    reconciled_at: now,
                    updated_at: now,
                })
                .eq("id", body.invoiceId);
            // (Legacy `invoices` is now a read-only view over vendor_invoices — the
            // vendor_invoices write above is what the queue sees.)

            // Insert an ap_activity_log stub so the queue re-classifies this
            // invoice as matched_unreconciled (no review yet — user will confirm
            // or dismiss from the matched section)
            await db.from("ap_activity_log").insert({
                email_from: invoice.vendor_name || "Unknown",
                email_subject: `PO candidate applied: Invoice ${invoice.invoice_number || ''} → PO ${poNumber}`,
                intent: "RECONCILIATION",
                action_taken: "PO candidate applied from dashboard — awaiting confirmation",
                reviewed_at: null,
                reviewed_action: null,
                metadata: {
                    invoiceNumber: invoice.invoice_number || "",
                    vendorName: invoice.vendor_name || "",
                    orderId: poNumber,
                    source: "dashboard_apply_po_candidate",
                },
            });

            return NextResponse.json({
                success: true,
                message: `✅ PO ${poNumber} applied to invoice ${invoice.invoice_number || ''} (${invoice.vendor_name || 'vendor'}). Confirm match in the Matched section.`,
            });
        }

        // ── RUN AUTO MATCH: Batch auto-match unmatched invoices ──────────────
        // Admin/dashboard trigger: runs the batch auto-match runner and returns
        // a summary. Does not require activityLogId.
        if (action === "run_auto_match") {
            const result = await runAutoMatchUnmatched(100);

            return NextResponse.json({
                success: true,
                message: `🤖 Auto-match complete: examined ${result.examined}, auto-matched ${result.autoApplied.length}, skipped ${result.skipped.length}, errors ${result.errors}.`,
                result,
            });
        }

        // ── APPROVE CLOSE-MATCH UNRECONCILED: Auto-approve matched_unreconciled
        //    invoices within 2% of PO total ────────────────────────────────────
        // Scans all matched_unreconciled invoices, checks amount proximity to
        // PO total, and auto-approves those within 2% variance.
        if (action === "approve_matched_unreconciled_bulk") {
            const { approved, errors } = await approveCloseMatchUnreconciled();

            return NextResponse.json({
                success: true,
                message: `✅ Auto-approved ${approved} matched_unreconciled invoice(s) within 2% of PO total. ${errors} error(s).`,
                approved,
                errors,
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
            content: `Invoice ${metadata.invoiceNumber} dismissed as "${reason}". Vendor: ${metadata.vendorName}. PO: ${metadata.orderId}. Learning: ${reason === "statement" ? "Email classifier misidentified statement as invoice — retrain classifier" : reason === "credit_memo" ? "Credit memo from vendor — not a payable invoice" : "Manual override"}.`,
            tags: ["reconciliation", "dismissed", reason, vendorSlug],
            source: "dashboard",
            relatedTo: metadata.vendorName,
            priority: "normal",
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
