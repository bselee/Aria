import { describe, expect, it } from "vitest";

import {
    FINALE_FREIGHT_ALLOCATION,
    FINALE_FREIGHT_DESCRIPTION,
    FINALE_FREIGHT_PROMO_URL,
    allocateFreightByWeight,
    buildFinaleFreightAdjustment,
    mergeInvoiceCorrelationNote,
} from "./freight-adjustment";

describe("Finale freight adjustments", () => {
    it("uses native Freight + ADJ_BY_WEIGHT so landed cost calculates", () => {
        expect(buildFinaleFreightAdjustment(15.68)).toEqual({
            amount: 15.68,
            description: FINALE_FREIGHT_DESCRIPTION,
            productPromoUrl: FINALE_FREIGHT_PROMO_URL,
            adjustmentAllocationEnumId: FINALE_FREIGHT_ALLOCATION,
            orderAdjustmentAllocationList: [15.68],
        });
        expect(FINALE_FREIGHT_DESCRIPTION).toBe("Freight");
        expect(FINALE_FREIGHT_ALLOCATION).toBe("ADJ_BY_WEIGHT");
    });

    it("never puts BOL, invoice, or vendor text on the freight description", () => {
        const adj = buildFinaleFreightAdjustment(612.63, [612.63]);
        expect(adj.description).toBe("Freight");
        expect(adj.description).not.toMatch(/BOL|PRO|Inv|invoice|backfill/i);
    });

    it("keeps invoice correlation in notes instead of the freight adjustment label", () => {
        expect(mergeInvoiceCorrelationNote("", ["INV126321"])).toBe("Invoice #INV126321");
        expect(mergeInvoiceCorrelationNote("Rush order", ["INV126321"])).toBe("Rush order\nInvoice #INV126321");
        expect(mergeInvoiceCorrelationNote("Invoice #INV126321", ["INV126321"])).toBe("Invoice #INV126321");
    });
});

describe("allocateFreightByWeight", () => {
    it("puts the full amount on a single line", () => {
        expect(allocateFreightByWeight(612.63, [{ quantity: 120, weight: 1 }])).toEqual([612.63]);
    });

    it("allocates Diamond K RAWGYPSUM + bag SKU by lb (PO 125249 shape)", () => {
        const alloc = allocateFreightByWeight(2250, [
            { quantity: 40000, weight: 1 },
            { quantity: 4, weight: 50 },
        ]);
        expect(alloc).toEqual([2238.81, 11.19]);
        expect(alloc.reduce((s, n) => s + n, 0)).toBeCloseTo(2250, 2);
    });

    it("zeros empty placeholder lines and still fills the list", () => {
        const alloc = allocateFreightByWeight(724.17, [
            { quantity: 60, weight: 1 },
            { quantity: 0, weight: 0 },
            { quantity: 60, weight: 0.8 },
        ]);
        expect(alloc).toHaveLength(3);
        expect(alloc[1]).toBe(0);
        expect(alloc.reduce((s, n) => s + n, 0)).toBeCloseTo(724.17, 2);
    });

    it("falls back to quantity when weight is missing", () => {
        expect(allocateFreightByWeight(100, [{ quantity: 1 }, { quantity: 3 }])).toEqual([25, 75]);
    });
});
