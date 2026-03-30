import { describe, expect, it } from "vitest";
import { derivePOCompletionState, type POCompletionInputs } from "./po-completion-state";

function buildInputs(overrides: Partial<POCompletionInputs> = {}): POCompletionInputs {
    return {
        finaleReceived: false,
        trackingDelivered: false,
        hasMatchedInvoice: false,
        reconciliationVerdict: null,
        freightResolved: false,
        unresolvedBlockers: [],
        ...overrides,
    };
}

describe("derivePOCompletionState", () => {
    it("returns received_pending_invoice when items are received but AP has not matched an invoice", () => {
        const state = derivePOCompletionState(buildInputs({
            finaleReceived: true,
        }));

        expect(state).toBe("received_pending_invoice");
    });

    it("returns received_pending_reconciliation when the invoice is matched but still needs review", () => {
        const state = derivePOCompletionState(buildInputs({
            finaleReceived: true,
            hasMatchedInvoice: true,
            reconciliationVerdict: "needs_approval",
            freightResolved: false,
        }));

        expect(state).toBe("received_pending_reconciliation");
    });

    it("returns delivered_awaiting_receipt when tracking says delivered but Finale has not received it", () => {
        const state = derivePOCompletionState(buildInputs({
            trackingDelivered: true,
        }));

        expect(state).toBe("delivered_awaiting_receipt");
    });

    it("returns exception when there are unresolved blockers like over/under or reconciliation errors", () => {
        const state = derivePOCompletionState(buildInputs({
            finaleReceived: true,
            hasMatchedInvoice: true,
            reconciliationVerdict: "auto_approve",
            freightResolved: true,
            unresolvedBlockers: ["short_shipment"],
        }));

        expect(state).toBe("exception");
    });

    it("returns complete only when receipt, AP match, and freight resolution all agree with no blockers", () => {
        const state = derivePOCompletionState(buildInputs({
            finaleReceived: true,
            hasMatchedInvoice: true,
            reconciliationVerdict: "auto_approve",
            freightResolved: true,
        }));

        expect(state).toBe("complete");
    });
});
