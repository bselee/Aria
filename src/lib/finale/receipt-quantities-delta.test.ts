/**
 * @file    src/lib/finale/receipt-quantities.test.ts
 * @purpose Receipt-delta primitives: shorts drive action, over is informational,
 *          and the PO verdict comes from receipts — not Finale's status field.
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest
 */
import { describe, it, expect } from "vitest";
import {
    buildPoReceiptState,
    receiptDeltaShorts,
    receiptDeltas,
    type TrueReceiptQuantities,
} from "./receipt-quantities";

function receipt(
    ordered: Record<string, number>,
    received: Record<string, number>,
): TrueReceiptQuantities {
    return {
        orderedBySku: new Map(Object.entries(ordered)),
        receivedBySku: new Map(Object.entries(received)),
        total: 0,
        subtotal: 0,
        orderItemCount: Object.keys(ordered).length,
        orderAdjustmentList: [],
    };
}

describe("receiptDeltas", () => {
    it("classifies short, exact and over per SKU", () => {
        const deltas = receiptDeltas(receipt(
            { A100: 100, B200: 50, C300: 10 },
            { A100: 60, B200: 50, C300: 12 },
        ));

        expect(deltas.map((d) => [d.sku, d.delta, d.cls])).toEqual([
            ["A100", -40, "short"],
            ["B200", 0, "exact"],
            ["C300", 2, "over"],
        ]);
    });

    it("treats an ordered SKU with no shipment as a full short, not absent", () => {
        // Silence is not delivery: a SKU nobody shipped is short by its full qty.
        const deltas = receiptDeltas(receipt({ RWBP102: 30 }, {}));

        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({ sku: "RWBP102", received: 0, delta: -30, cls: "short" });
    });
});

describe("receiptDeltaShorts", () => {
    it("returns shorts only — over receipts are never action items", () => {
        // Bill 2026-10-29: over receipts are informational, not a work queue.
        const shorts = receiptDeltaShorts(receipt(
            { A100: 100, B200: 50 },
            { A100: 90, B200: 55 },
        ));

        expect(shorts.map((s) => s.sku)).toEqual(["A100"]);
    });
});

describe("buildPoReceiptState", () => {
    it("is complete when every line is covered", () => {
        const state = buildPoReceiptState(receipt({ A100: 100 }, { A100: 100 }));

        expect(state.verdict).toBe("complete");
        expect(state.shortUnits).toBe(0);
        expect(state.shortSkus).toEqual([]);
    });

    it("is partial when something arrived and units are still owed", () => {
        const state = buildPoReceiptState(receipt({ A100: 250, B200: 10 }, { A100: 50 }));

        expect(state.verdict).toBe("partial");
        expect(state.shortUnits).toBe(210);
        expect(state.shortSkus).toEqual(["A100 ×200", "B200 ×10"]);
        expect(state.nothingReceived).toBe(false);
    });

    it("is not_received when nothing arrived at all", () => {
        const state = buildPoReceiptState(receipt({ A100: 250 }, {}));

        expect(state.verdict).toBe("not_received");
        expect(state.nothingReceived).toBe(true);
        expect(state.shortUnits).toBe(250);
    });

    it("reports over units without making them actionable", () => {
        const state = buildPoReceiptState(receipt({ A100: 100, B200: 20 }, { A100: 100, B200: 23 }));

        expect(state.verdict).toBe("complete");
        expect(state.overUnits).toBe(3);
        expect(state.shortSkus).toEqual([]);
    });

    it("is unknown when the POD cannot be read", () => {
        expect(buildPoReceiptState(null).verdict).toBe("unknown");
        expect(buildPoReceiptState(receipt({}, {})).verdict).toBe("unknown");
    });
});
