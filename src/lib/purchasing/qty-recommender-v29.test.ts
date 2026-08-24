import { describe, it, expect } from "vitest";
import { QTY_FORMULA_VERSION, recommendQty, type RecommenderInput } from "./qty-recommender";

/**
 * v2.9 regression guard — byte-identical behavioral oracle.
 *
 * The five CONTROL fixtures below were captured against the deployed v2.8
 * recommender (formula `v2.8-residual-topup-cap-2026-07-10`) via a scratch
 * script BEFORE the freight/cover wiring landed (2026-08-24). Controls are
 * guaranteed no-ops for the v2.9 logic: SKUs NOT in FREIGHT_UNITS,
 * skuPurchaseHistory undefined, minimumOrderEaches undefined, and
 * (stockOnHand + stockOnOrder) / dailyRate >= 30 — so the cover floor
 * computes a 0 gap and must leave both suggestedQty and rawNeededEaches
 * byte-identical. If this suite ever fails, v2.9 changed behavior for a
 * line v2.8 left alone.
 *
 * Captured oracle (v2.8), sku → { suggestedQty, rawNeededEaches }:
 *   THC101  → { 0,   0 }
 *   KMS101  → { 100, 25 }
 *   RMC102  → { 40,  22.8 }
 *   ORS101  → { 12,  4 }
 *   BOX-101 → { 0,   0 }
 */
function makeInput(overrides: Partial<RecommenderInput> = {}): RecommenderInput {
    return {
        dailyRateSource: "demand",
        dailyRateLabel: "90d demand",
        stockOnOrder: 0,
        openPOCount: 0,
        coverBufferDays: 30,
        orderIncrementQty: null,
        safetyMultiplier: 1,
        calibrationSampleCount: 0,
        calibrationMedianErrorPct: null,
        reservedQty: 0,
        reservedDraftPOs: [],
        unitPrice: 10,
        standardOrderQty: null,
        targetCoverDays: null,
        historicalCapMultiple: null,
        historicalLineQtys: [],
        favoriteBatches: null,
        lastPurchaseQty: null,
        moqMode: "enforce",
        overbuyReviewPct: 50,
        overbuyReviewDollars: 1000,
        leadTimeP90: null,
        leadTimeOverrideDays: null,
        // Controls must NOT set: skuPurchaseHistory, minimumOrderEaches,
        // minimumOrderDollars (v2.9 no-op guarantee).
        ...overrides,
    };
}

describe("recommendQty — v2.9 regression oracle (byte-identical vs v2.8)", () => {
    it("formula version is bumped to v2.9", () => {
        expect(QTY_FORMULA_VERSION).toBe("v2.9-freight-and-cover-2026-08-24");
    });

    it("THC101 control: slow mover, 58d existing cover, no order — unchanged (oracle 0)", () => {
        const result = recommendQty(makeInput({
            sku: "THC101",
            dailyRate: 0.69,
            stockOnHand: 40,
            leadTimeDays: 13,
            leadTimeProvenance: "13d (vendor median)",
            unitPrice: 45,
        }));
        expect(result.suggestedQty).toBe(0);
        expect(result.rawNeededEaches).toBe(0);
    });

    it("KMS101 control: pack increment 5 + favorite batch 100 — unchanged (oracle 100)", () => {
        const result = recommendQty(makeInput({
            sku: "KMS101",
            dailyRate: 2.5,
            stockOnHand: 75,
            leadTimeDays: 10,
            leadTimeProvenance: "10d (vendor median)",
            orderIncrementQty: 5,
            unitPrice: 12,
            historicalLineQtys: [100, 100, 120, 100],
            historicalCapMultiple: 2,
            favoriteBatches: [100],
        }));
        expect(result.suggestedQty).toBe(100);
        expect(result.rawNeededEaches).toBe(25);
    });

    it("RMC102 control: open PO + reservation path — unchanged (oracle 40)", () => {
        const result = recommendQty(makeInput({
            sku: "RMC102",
            dailyRate: 1.2,
            stockOnHand: 20,
            stockOnOrder: 20,
            openPOCount: 1,
            reservedQty: 10,
            reservedDraftPOs: ["DRAFT-77"],
            leadTimeDays: 14,
            leadTimeProvenance: "14d (vendor median)",
            unitPrice: 30,
        }));
        expect(result.suggestedQty).toBe(40);
        expect(result.rawNeededEaches).toBeCloseTo(22.8, 5);
    });

    it("ORS101 control: case-pack 12 path — unchanged (oracle 12)", () => {
        const result = recommendQty(makeInput({
            sku: "ORS101",
            dailyRate: 1.0,
            stockOnHand: 40,
            leadTimeDays: 14,
            leadTimeProvenance: "14d (vendor median)",
            orderIncrementQty: 12,
            unitPrice: 10,
        }));
        expect(result.suggestedQty).toBe(12);
        expect(result.rawNeededEaches).toBe(4);
    });

    it("BOX-101 control: no order needed, 100d cover — unchanged (oracle 0)", () => {
        const result = recommendQty(makeInput({
            sku: "BOX-101",
            dailyRate: 0.3,
            stockOnHand: 30,
            leadTimeDays: 21,
            leadTimeProvenance: "21d default",
            unitPrice: 8,
        }));
        expect(result.suggestedQty).toBe(0);
        expect(result.rawNeededEaches).toBe(0);
    });
});

describe("recommendQty — v2.9 cover floor (Bill 2026-08-24)", () => {
    it("THC101: history floor wins over tiny formula need — raises 5→50 with 'raised' provenance", () => {
        // dailyRate 0.69, stock 29 → 29/0.69 = 42d existing cover, so the gap
        // floor is 0; raw need is only ~1 → cognitive snaps to 5. Purchase
        // history consistently says 50 → cover floor must raise to 50
        // (Bill: "THC101 suggested 5 but history says 50, unacceptable").
        const result = recommendQty(makeInput({
            sku: "THC101",
            dailyRate: 0.69,
            stockOnHand: 29,
            stockOnOrder: 0,
            leadTimeDays: 13,
            leadTimeProvenance: "13d (vendor median)",
            skuPurchaseHistory: [50],
            minimumOrderEaches: 9,
            unitPrice: 45,
        }));
        expect(result.suggestedQty).toBe(50);
        const coverStep = result.provenance.find(p => p.step === "cover_floor");
        expect(coverStep).toBeDefined();
        expect(coverStep?.detail).toContain("raised");
        expect(coverStep?.value).toBe(50);
    });

    it("KMS101-style control with existing cover >= 30: cover_floor traced but qty unchanged", () => {
        const result = recommendQty(makeInput({
            sku: "KMS101",
            dailyRate: 2.5,
            stockOnHand: 75, // exactly 30d existing cover → 0 gap floor
            stockOnOrder: 0,
            leadTimeDays: 10,
            leadTimeProvenance: "10d (vendor median)",
            orderIncrementQty: 5,
            unitPrice: 12,
            historicalLineQtys: [100, 100, 120, 100],
            historicalCapMultiple: 2,
            favoriteBatches: [100],
        }));
        expect(result.suggestedQty).toBe(100);
        const coverStep = result.provenance.find(p => p.step === "cover_floor");
        expect(coverStep).toBeDefined();
        expect(coverStep?.value).toBe(100);
    });
});

describe("recommendQty — v2.9 freight sizing (Bill 2026-08-24)", () => {
    it("RAWRICEBRAN: bulk need snaps to a whole 42,000 lb truck, never a fractional truck", () => {
        // daily 1119.63 lb/d, 40,564 on hand, 66d policy cover →
        // raw need ≈ 33,331.58; the 30d floor bumps pre-sizing to 33,589,
        // cognitive ladder nudges to 34,000 — all well under one truck.
        // sizeToFreight must snap to exactly 42,000 lb (21 totes x 2,000 lb).
        const result = recommendQty(makeInput({
            sku: "RAWRICEBRAN",
            dailyRate: 1119.63,
            stockOnHand: 40564,
            stockOnOrder: 0,
            leadTimeDays: 21,
            leadTimeProvenance: "21d (Finale)",
            targetCoverDays: 66,
            orderIncrementQty: 1,
        }));
        expect(result.suggestedQty).toBe(42000);
        // rawNeededEaches must stay the arithmetic truth — step 7.7 only
        // ever mutates suggestedQty, never rawNeededEaches.
        expect(result.rawNeededEaches).toBeCloseTo(33331.58, 1);
        const freightStep = result.provenance.find(p => p.step === "freight_sizing");
        expect(freightStep).toBeDefined();
        expect(freightStep?.value).toBe(42000);
        expect(freightStep?.detail).toContain("full truck");
    });
});
