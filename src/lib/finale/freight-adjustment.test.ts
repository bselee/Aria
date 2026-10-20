import { describe, expect, it } from "vitest";

import {
    FINALE_FREIGHT_ALLOCATION,
    FINALE_FREIGHT_DESCRIPTION,
    FINALE_FREIGHT_PROMO_URL,
    allocateFreightByWeight,
    allocateFreightForDelivery,
    buildFinaleFreightAdjustment,
    freightLineSkipsLandedCost,
    mergeInvoiceCorrelationNote,
    parseUnitWeightLb,
    resolveUnitWeightLb,
    splitFreightAcrossPos,
    weightInPounds,
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

describe("allocateFreightForDelivery", () => {
    const orderLines = [
        { productId: "RBE101", quantity: 360, weight: 1.3 },
        { productId: "RBE102", quantity: 252, weight: 2.2 },
        { productId: "RMC100", quantity: 560, weight: 2 },
        { productId: "", quantity: 0, weight: 0 },
        { productId: "", quantity: 0, weight: 0 },
        { productId: "RWBP100", quantity: 480, weight: 2 },
        { productId: "", quantity: 0, weight: 0 },
        { productId: "RWBP104", quantity: 33, weight: 1 },
    ];

    it("puts a single-SKU truck entirely on that order line (PO 125057 / 7-31)", () => {
        const alloc = allocateFreightForDelivery(363.95, orderLines, [
            { productId: "RMC100", quantity: 560 },
        ]);
        expect(alloc).toEqual([0, 0, 363.95, 0, 0, 0, 0, 0]);
    });

    it("splits a mixed truck by shipment qty × lb, not full PO qty (PO 125057 / 8-13)", () => {
        const alloc = allocateFreightForDelivery(460.2, orderLines, [
            { productId: "RBE101", quantity: 108 },
            { productId: "RBE102", quantity: 168 },
        ]);
        expect(alloc).toEqual([126.69, 333.51, 0, 0, 0, 0, 0, 0]);
        expect(alloc.reduce((s, n) => s + n, 0)).toBeCloseTo(460.2, 2);
    });

    it("does not charge SKUs that were not on the shipment", () => {
        const alloc = allocateFreightForDelivery(100, orderLines, [
            { productId: "RWBP100", quantity: 80 },
            { productId: "RWBP104", quantity: 33 },
        ]);
        expect(alloc[0]).toBe(0);
        expect(alloc[2]).toBe(0);
        expect(alloc[5]).toBeGreaterThan(0);
        expect(alloc[7]).toBeGreaterThan(0);
        expect(alloc.reduce((s, n) => s + n, 0)).toBeCloseTo(100, 2);
    });

    it("returns zeros when the shipment SKUs are not on the order", () => {
        expect(allocateFreightForDelivery(50, orderLines, [{ productId: "NOPE", quantity: 10 }]))
            .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
});

describe("freightLineSkipsLandedCost", () => {
    it("flags BOL wording and a missing allocation list", () => {
        expect(freightLineSkipsLandedCost({
            description: "Freight BOL 17158448",
            productPromoUrl: "/buildasoilorganics/api/productpromo/10007",
            amount: 363.95,
        } as { description: string; productPromoUrl: string }, 8)).toBe(true);
    });

    it("accepts a plain Freight line whose allocation matches the order", () => {
        expect(freightLineSkipsLandedCost({
            description: "Freight",
            productPromoUrl: FINALE_FREIGHT_PROMO_URL,
            adjustmentAllocationEnumId: "ADJ_BY_WEIGHT",
            orderAdjustmentAllocationList: [0, 0, 363.95, 0, 0, 0, 0, 0],
        }, 8)).toBe(false);
    });
});

describe("weightInPounds", () => {
    it("converts ounces so 2 oz is 0.125 lb, not 2 lb", () => {
        expect(weightInPounds(2, "WT_oz")).toBe(0.125);
        expect(weightInPounds(1.3, "WT_lb")).toBe(1.3);
    });
});

describe("parseUnitWeightLb", () => {
    it("parses plain pound and ounce weights from the name", () => {
        expect(parseUnitWeightLb("Rootwise Mycrobe Complete : 1lb")).toBe(1);
        expect(parseUnitWeightLb("Rootwise Bio-Phos : 8oz")).toBe(0.5);
        expect(parseUnitWeightLb("Rootwise Mycrobe Complete : 4oz")).toBe(0.25);
        expect(parseUnitWeightLb("Rootwise Bio-Phos : 2oz")).toBe(0.125);
    });

    it("parses a case multiplier (2oz × 12ea = 24 oz = 1.5 lb)", () => {
        expect(parseUnitWeightLb("Rootwise Bio-Phos - (2oz) 12ea Case")).toBe(1.5);
    });

    it("returns null for fluid volume, not weight", () => {
        expect(parseUnitWeightLb("Rootwise Enzyme Elixer : 16oz/Pint")).toBeNull();
        expect(parseUnitWeightLb("something 12 fl oz bottle")).toBeNull();
    });

    it("returns null when the name has no weight", () => {
        expect(parseUnitWeightLb("Rootwise Bio-Phos Biological Bloom Support")).toBeNull();
        expect(parseUnitWeightLb(null)).toBeNull();
    });
});

describe("resolveUnitWeightLb", () => {
    it("prefers the name over the raw field (fixes the RWBP102 8oz-as-0.5 bug)", () => {
        // raw field says weight=0.5 tagged WT_oz (wrongly implies 0.5 oz); name says 8oz.
        expect(resolveUnitWeightLb({ name: "Rootwise Bio-Phos : 8oz", weight: 0.5, weightUomId: "WT_oz" })).toBe(0.5);
    });

    it("falls back to the raw field when the name is fluid-only", () => {
        expect(resolveUnitWeightLb({ name: "Rootwise Enzyme : 16oz/Pint", weight: 1.3, weightUomId: "WT_lb" })).toBe(1.3);
    });

    it("falls back to raw ounces when the name has no weight", () => {
        expect(resolveUnitWeightLb({ name: "Rootwise Bio-Phos", weight: 24, weightUomId: "WT_oz" })).toBe(1.5);
    });

    it("returns 0 when no weight is available", () => {
        expect(resolveUnitWeightLb({ name: "unknown", weight: 0, weightUomId: null })).toBe(0);
    });
});

describe("splitFreightAcrossPos", () => {
    it("splits a single bill across three POs by weight and sums exactly", () => {
        const split = splitFreightAcrossPos(397.94, [
            { orderId: "125393", pounds: 40 },
            { orderId: "125271", pounds: 16.56 },
            { orderId: "125241", pounds: 472.2 },
        ]);
        expect(split.map((s) => s.orderId)).toEqual(["125393", "125271", "125241"]);
        expect(split.reduce((sum, s) => sum + s.amount, 0)).toBeCloseTo(397.94, 2);
        // 40 / 528.76 ≈ 7.57% of the bill
        expect(split[0].amount).toBeCloseTo(30.1, 1);
        // 472.2 / 528.76 ≈ 89.3% of the bill
        expect(split[2].amount).toBeCloseTo(355.34, 1);
    });

    it("gives a zero-weight PO a zero share", () => {
        const split = splitFreightAcrossPos(100, [
            { orderId: "A", pounds: 50 },
            { orderId: "B", pounds: 0 },
        ]);
        expect(split[1].amount).toBe(0);
        expect(split.reduce((sum, s) => sum + s.amount, 0)).toBeCloseTo(100, 2);
    });

    it("returns empty for no POs", () => {
        expect(splitFreightAcrossPos(100, [])).toEqual([]);
    });
});
