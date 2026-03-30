export type POCompletionState =
    | "in_transit"
    | "delivered_awaiting_receipt"
    | "received_pending_invoice"
    | "received_pending_reconciliation"
    | "complete"
    | "exception";

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
