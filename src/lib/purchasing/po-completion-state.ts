/**
 * PO Completion States - AP Pipeline tracking (NOT physical receipt)
 *
 * IMPORTANT: These states track the AP/invoice pipeline, NOT physical receipt.
 * Physical receipt is tracked separately via hasPurchaseOrderReceipt().
 *
 * A PO is truly "complete" (all AP steps done) when ALL of these are true:
 *   - finaleReceived: Physical goods received in Finale (staff confirmed)
 *   - hasMatchedInvoice: Invoice matched to this PO
 *   - freightResolved: Shipping charges verified/added
 *   - reconciliationVerdict: Pricing verified (auto_approve, no_change, duplicate)
 *   - unresolvedBlockers: [] (no exceptions)
 */
export type POCompletionState =
    | "in_transit"                        // Not received, no delivered tracking
    | "delivered_awaiting_receipt"        // Tracking shows delivered, awaiting staff receipt in Finale
    | "received_pending_invoice"           // Received but no invoice matched yet
    | "received_pending_reconciliation"    // Invoice matched, reconciliation in progress
    | "complete"                          // ALL AP steps done: received + invoice + freight + pricing verified
    | "exception";                        // Blockers or reconciliation failed

export interface POCompletionInputs {
    finaleReceived: boolean;
    trackingDelivered: boolean;
    hasMatchedInvoice: boolean;
    reconciliationVerdict: string | null;
    freightResolved: boolean;
    unresolvedBlockers: string[];
}

const RESOLVED_VERDICTS = new Set(["auto_approve", "no_change", "duplicate"]);
const PENDING_RECONCILIATION_VERDICTS = new Set(["needs_approval", "pending"]);
const EXCEPTION_VERDICTS = new Set(["rejected", "no_match", "error"]);

export function derivePOCompletionState(inputs: POCompletionInputs): POCompletionState {
    if (inputs.unresolvedBlockers.length > 0) {
        return "exception";
    }

    if (!inputs.finaleReceived) {
        return inputs.trackingDelivered ? "delivered_awaiting_receipt" : "in_transit";
    }

    if (!inputs.hasMatchedInvoice) {
        return "received_pending_invoice";
    }

    const verdict = (inputs.reconciliationVerdict || "").toLowerCase();
    if (EXCEPTION_VERDICTS.has(verdict)) {
        return "exception";
    }

    if (!inputs.freightResolved || PENDING_RECONCILIATION_VERDICTS.has(verdict) || !RESOLVED_VERDICTS.has(verdict)) {
        return "received_pending_reconciliation";
    }

    return "complete";
}
