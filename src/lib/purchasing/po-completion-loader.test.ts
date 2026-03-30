import { describe, expect, it } from "vitest";
import {
    buildPOCompletionSignalIndex,
    summarizePOCompletionSignal,
    type APActivityRow,
} from "./po-completion-loader";

function buildRow(overrides: Partial<APActivityRow> = {}): APActivityRow {
    return {
        intent: "RECONCILIATION",
        created_at: "2026-03-30T10:00:00Z",
        metadata: {
            orderId: "124547",
            verdict: "auto_approve",
            feeChanges: [],
            errors: [],
        },
        ...overrides,
    };
}

describe("po completion loader", () => {
    it("treats freight as unresolved when reconciliation still needs approval", () => {
        const signal = summarizePOCompletionSignal(buildRow({
            metadata: {
                orderId: "124547",
                verdict: "needs_approval",
                feeChanges: [{ type: "FREIGHT", verdict: "needs_approval" }],
                errors: [],
            },
        }));

        expect(signal.hasMatchedInvoice).toBe(true);
        expect(signal.reconciliationVerdict).toBe("needs_approval");
        expect(signal.freightResolved).toBe(false);
        expect(signal.unresolvedBlockers).toContain("needs_approval");
        expect(signal.unresolvedBlockers).toContain("freight_review");
    });

    it("extracts a clean resolved signal from an applied reconciliation", () => {
        const signal = summarizePOCompletionSignal(buildRow({
            metadata: {
                orderId: "124547",
                verdict: "auto_approve",
                feeChanges: [{ type: "FREIGHT", verdict: "auto_approve" }],
                errors: [],
            },
        }));

        expect(signal.freightResolved).toBe(true);
        expect(signal.unresolvedBlockers).toEqual([]);
    });

    it("keeps only the newest AP signal per PO", () => {
        const index = buildPOCompletionSignalIndex([
            buildRow({
                created_at: "2026-03-29T09:00:00Z",
                metadata: { orderId: "124547", verdict: "needs_approval", feeChanges: [], errors: [] },
            }),
            buildRow({
                created_at: "2026-03-30T09:00:00Z",
                metadata: { orderId: "124547", verdict: "auto_approve", feeChanges: [], errors: [] },
            }),
        ], ["124547"]);

        expect(index.get("124547")?.reconciliationVerdict).toBe("auto_approve");
    });
});
