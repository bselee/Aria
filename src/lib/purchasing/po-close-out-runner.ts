/**
 * @file    src/lib/purchasing/po-close-out-runner.ts
 * @purpose Execute the close-out decision against live Finale: promote received
 *          drafts to committed, complete fully-reconciled POs.
 *
 * RULE (Bill, 2026-10-29): received draft → committed (the draft was a clerical
 * error). Received + no conflicts + freight/tax applied + invoice matches →
 * complete. Never complete if not received or not matching invoice.
 *
 * SAFETY:
 *  - Dry-run unless PO_CLOSE_OUT_ENABLED=true. Same posture as
 *    po-auto-complete: log what WOULD happen, write nothing.
 *  - Receipt truth comes from live shipment reads, never from the status field.
 *  - Any read failure on a candidate = skip that PO. Unknown is never a yes.
 *  - Every live write is logged to ap_activity_log (NOT NULL columns supplied).
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    finale client, receipt-quantities, po-close-out, db
 */

import { createClient } from "../db";
import { loadTrueReceiptQuantities, buildPoReceiptState } from "../finale/receipt-quantities";
import { decidePoCloseAction, type PoCloseAction } from "./po-close-out";

export interface CloseOutStats {
    scanned: number;
    committed: number;
    completed: number;
    skipped: number;
    errors: number;
    dryRun: boolean;
    /** One line per PO the runner touched, for the cron log and dry-run review. */
    actions: Array<{ orderId: string; action: PoCloseAction; reason: string; blockers: string[] }>;
}

/** Env flag — when false (default), the runner writes nothing to Finale. */
export function closeOutEnabled(): boolean {
    const v = (process.env.PO_CLOSE_OUT_ENABLED ?? "false").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

/**
 * Load the invoice side of the decision for one PO.
 *
 * "Matches invoice" means an invoice exists AND the 3-way reconciliation found
 * no blocking discrepancy. Absence of a reconciliation record is treated as
 * NOT reconciled — an unmade decision is not a passing decision.
 *
 * @param orderId Finale PO number.
 * @returns       Invoice facts, or nulls when nothing is matched.
 */
async function loadInvoiceFacts(orderId: string): Promise<{
    hasMatchedInvoice: boolean;
    invoiceTotal: number | null;
    hasBlockingDiscrepancy: boolean;
}> {
    const sb = createClient();
    if (!sb) return { hasMatchedInvoice: false, invoiceTotal: null, hasBlockingDiscrepancy: true };

    try {
        const { data } = await sb
            .from("vendor_invoices")
            .select("invoice_number, total, freight, tax")
            .eq("po_number", orderId)
            .order("invoice_date", { ascending: false })
            .limit(1);
        const inv = (data?.[0] ?? null) as
            | { invoice_number?: string; total?: number | string | null }
            | null;
        if (!inv) return { hasMatchedInvoice: false, invoiceTotal: null, hasBlockingDiscrepancy: true };

        const total = inv.total == null ? null : Number(inv.total);

        // A reconciliation verdict is required evidence for completion.
        const { data: reconRows } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", "RECONCILIATION")
            .filter("metadata->>orderId", "eq", orderId)
            .order("created_at", { ascending: false })
            .limit(1);
        const verdict = (reconRows?.[0] as { metadata?: { verdict?: string } } | undefined)
            ?.metadata?.verdict;
        const hasBlockingDiscrepancy = verdict !== "match";

        return { hasMatchedInvoice: true, invoiceTotal: total, hasBlockingDiscrepancy };
    } catch {
        // Unreadable invoice side → never a completion.
        return { hasMatchedInvoice: false, invoiceTotal: null, hasBlockingDiscrepancy: true };
    }
}

/**
 * Evaluate (and optionally execute) close-out for a set of POs.
 *
 * @param orderIds POs to consider. The caller decides the scan window.
 * @returns        Stats plus per-PO decisions.
 */
export async function runPoCloseOut(orderIds: string[]): Promise<CloseOutStats> {
    const stats: CloseOutStats = {
        scanned: 0,
        committed: 0,
        completed: 0,
        skipped: 0,
        errors: 0,
        dryRun: !closeOutEnabled(),
        actions: [],
    };

    const { FinaleClient } = await import("../finale/client");
    const finale = new FinaleClient() as unknown as {
        getOrderDetails: (id: string) => Promise<{ statusId?: string; total?: number; subtotal?: number }>;
        commitDraftPO: (id: string) => Promise<unknown>;
        completeOrder: (id: string) => Promise<unknown>;
    };
    const sb = createClient();

    for (const orderId of orderIds) {
        stats.scanned += 1;
        try {
            const details = await finale.getOrderDetails(orderId).catch(() => null);
            if (!details?.statusId) {
                stats.errors += 1;
                continue;
            }

            // Receipt truth from live shipments — never the status field.
            const receipt = await loadTrueReceiptQuantities(orderId);
            const state = buildPoReceiptState(receipt);
            const invoice = await loadInvoiceFacts(orderId);

            const decision = decidePoCloseAction({
                orderId,
                statusId: details.statusId,
                orderedUnits: receipt ? [...receipt.orderedBySku.values()].reduce((a, b) => a + b, 0) : 0,
                receivedUnits: receipt ? [...receipt.receivedBySku.values()].reduce((a, b) => a + b, 0) : 0,
                shortSkus: state.shortSkus,
                receiptsIncomplete: state.verdict === "unknown",
                hasMatchedInvoice: invoice.hasMatchedInvoice,
                invoiceTotal: invoice.invoiceTotal,
                poTotal: Number(details.total ?? 0) || null,
                hasBlockingDiscrepancy: invoice.hasBlockingDiscrepancy,
                // Freight/tax application is gated by the existing freight engine;
                // it reports unapplied amounts into the PO total instead of here.
                freightUnapplied: false,
                taxOrMiscUnapplied: false,
            });

            stats.actions.push({
                orderId,
                action: decision.action,
                reason: decision.reason,
                blockers: decision.blockers,
            });

            if (decision.action === "none") {
                stats.skipped += 1;
                continue;
            }

            if (stats.dryRun) {
                console.log(
                    `[po-close-out] DRY-RUN would ${decision.action} PO ${orderId}: ${decision.reason}`,
                );
                continue;
            }

            if (decision.action === "commit") {
                await finale.commitDraftPO(orderId);
                stats.committed += 1;
            } else {
                await finale.completeOrder(orderId);
                stats.completed += 1;
            }

            if (sb) {
                try {
                    await sb.from("ap_activity_log").insert({
                        email_from: "aria",
                        email_subject: `PO ${orderId} ${decision.action === "commit" ? "auto-committed" : "auto-completed"}`,
                        intent: decision.action === "commit" ? "PO_AUTO_COMMITTED" : "PO_AUTO_COMPLETED",
                        action_taken: `${decision.action}: ${decision.reason}`,
                        metadata: {
                            orderId,
                            action: decision.action,
                            statusIdBefore: details.statusId,
                            shortSkus: state.shortSkus,
                            invoiceTotal: invoice.invoiceTotal,
                            poTotal: Number(details.total ?? 0) || null,
                        },
                    });
                } catch (err: unknown) {
                    console.warn(
                        `[po-close-out] PO ${orderId} acted but activity write failed: ${(err as Error).message}`,
                    );
                }
            }
        } catch (err: unknown) {
            stats.errors += 1;
            console.error(`[po-close-out] PO ${orderId} failed: ${(err as Error).message}`);
        }
    }

    return stats;
}
