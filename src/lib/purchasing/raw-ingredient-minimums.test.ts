/**
 * @file    raw-ingredient-minimums.test.ts
 * @purpose Unit tests for the per-SKU raw-ingredient minimum order quantities and the
 *          42,000 lb floor they impose through the recommender.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    vitest
 * @env     none
 */
import { describe, it, expect } from "vitest";
import {
    RAW_LOAD_QTY,
    rawIngredientBoundsFor,
    rawIngredientMinimumFor,
    rawIngredientMaximumFor,
    rawIngredientMinimumLabel,
} from "./raw-ingredient-minimums";
import { recommendQty } from "./qty-recommender";

const THREE_RAWS = ["RAWWORMCASTINGS", "RAWSEACOASTCOMPOST", "RAWMALIBUCOMPOST"];

describe("rawIngredientMinimumFor", () => {
    it("applies the expected bounds to exactly the three raw ingredients", () => {
        for (const sku of THREE_RAWS) {
            expect(rawIngredientMinimumFor(sku)).toBe(42_000);
            expect(rawIngredientMaximumFor(sku)).toBe(63_000);
        }
        expect(RAW_LOAD_QTY).toBe(42_000);
        // 1.5 loads: conservative ceiling. Bill rarely buys more than 1-1.5 loads/mo.
        expect(rawIngredientMaximumFor("RAWWORMCASTINGS")).toBe(RAW_LOAD_QTY * 1.5);
    });

    it("returns null bounds for unconstrained SKUs", () => {
        expect(rawIngredientBoundsFor("PU100")).toBeNull();
        expect(rawIngredientMaximumFor("SCO101")).toBeNull();
        expect(rawIngredientMaximumFor("MC101")).toBeNull();
    });

    it("is case- and whitespace-insensitive", () => {
        expect(rawIngredientMinimumFor(" rawwormcastings ")).toBe(42_000);
        expect(rawIngredientMinimumFor("RawSeaCoastCompost")).toBe(42_000);
    });

    it("returns null for unconstrained SKUs and empty input", () => {
        expect(rawIngredientMinimumFor("PU100")).toBeNull();
        expect(rawIngredientMinimumFor("SCO101")).toBeNull();
        expect(rawIngredientMinimumFor("MC101")).toBeNull();
        expect(rawIngredientMinimumFor(null)).toBeNull();
        expect(rawIngredientMinimumFor(undefined)).toBeNull();
        expect(rawIngredientMinimumFor("")).toBeNull();
    });

    it("does NOT apply to sibling finished goods from the same vendors", () => {
        // Seacoast and Malibu each supply finished goods alongside the raw. A
        // vendor-wide floor would have wrongly caught these.
        for (const sku of ["SCO101", "SCO102", "SCO104", "MC101", "MC102", "MC109"]) {
            expect(rawIngredientMinimumFor(sku)).toBeNull();
        }
    });

    it("labels the reason readably", () => {
        expect(rawIngredientMinimumLabel(42_000)).toContain("42,000");
        expect(rawIngredientMinimumLabel(42_000)).toContain("lb");
    });
});

/** Minimal recommender input; the floor is what we vary. */
function inputFor(sku: string, over: Record<string, unknown> = {}) {
    return {
        sku,
        dailyRate: 1,
        dailyRateSource: "ledger" as const,
        dailyRateLabel: "90d ledger consumption",
        stockOnHand: 0,
        stockOnOrder: 0,
        openPOCount: 0,
        leadTimeDays: 14,
        coverBufferDays: 30,
        targetCoverDays: 90,
        unitPrice: 0.2,
        ...over,
    } as unknown as Parameters<typeof recommendQty>[0];
}

describe("42,000 lb floor through the recommender", () => {
    it("raises a sub-minimum requirement up to 42,000", () => {
        // 42 days of cover at 100/day = 4,200 needed — well under one truckload.
        const r = recommendQty(inputFor("RAWWORMCASTINGS", {
            dailyRate: 100,
            stockOnHand: 0,
            leadTimeDays: 14,
            targetCoverDays: 30,
            coverBufferDays: 0,
        }));
        expect(r.suggestedQty).toBeGreaterThanOrEqual(42_000);
        expect(r.provenance.some(p => /42,000|raw-ingredient minimum/i.test(p.detail))).toBe(true);
    });

    it("leaves an already-above-minimum requirement untouched (floor, not multiple)", () => {
        // A need clearly above 42,000 must not be COERCED to a multiple of 42,000.
        // The precise check is that the raw-ingredient floor step never fires; the
        // final qty may still land on a multiple by coincidence of clean rounding,
        // which would make a `qty % 42000 !== 0` assertion wrong.
        const r = recommendQty(inputFor("RAWWORMCASTINGS", {
            dailyRate: 2_800,
            stockOnHand: 0,
            leadTimeDays: 14,
            targetCoverDays: 60,
            coverBufferDays: 0,
        }));
        expect(r.suggestedQty).toBeGreaterThan(42_000);
        const floorStep = r.provenance.find(p => p.step === "standard_order_floor");
        expect(floorStep).toBeUndefined();
    });

    it("does not invent a quantity when the recommender says hold", () => {
        const r = recommendQty(inputFor("RAWMALIBUCOMPOST", {
            dailyRate: 0,
            stockOnHand: 100_000,
            targetCoverDays: 90,
        }));
        expect(r.suggestedQty).toBe(0);
    });

    it("does not apply the floor to sibling finished goods", () => {
        const r = recommendQty(inputFor("SCO101", {
            dailyRate: 100,
            stockOnHand: 0,
            leadTimeDays: 14,
            targetCoverDays: 30,
            coverBufferDays: 0,
        }));
        expect(r.suggestedQty).toBeLessThan(42_000);
    });

    it("does NOT force a truckload onto a sub-minimum residual with a PO already inbound", () => {
        // Real scenario: 42k lb in flight, 2k short of the order point. Forcing the
        // 42k minimum here would buy 40k lb nobody asked for (defeating the v2.8
        // residual cap); emitting 2k would create a PO below the minimum. Correct
        // answer: suppress, and flag for review.
        const r = recommendQty(inputFor("RAWWORMCASTINGS", {
            dailyRate: 1_000,
            stockOnHand: 0,
            stockOnOrder: 42_000,
            openPOCount: 1,
            leadTimeDays: 14,
            coverBufferDays: 30,
            targetCoverDays: 90,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));
        expect(r.suggestedQty).toBe(0);
        expect(r.provenance.find(p => p.step === "standard_order_floor")).toBeUndefined();
        expect(r.provenance.some(p => p.step === "raw_minimum_residual_suppressed")).toBe(true);
        expect(r.reviewReasons.join(" ")).toMatch(/inbound/i);
    });

    it("DOES apply the floor when nothing is inbound", () => {
        const r = recommendQty(inputFor("RAWSEACOASTCOMPOST", {
            dailyRate: 100,
            stockOnHand: 0,
            stockOnOrder: 0,
            openPOCount: 0,
            leadTimeDays: 14,
            coverBufferDays: 0,
            targetCoverDays: 30,
        }));
        expect(r.suggestedQty).toBeGreaterThanOrEqual(42_000);
    });
});

describe("raw-ingredient order ceiling (1.5 loads)", () => {
    it("caps the 126,000 lb worm-castings suggestion at 63,000", () => {
        // Reproduces the live case: build-derived 2,800/day over 90d cover against
        // 72,357 on hand produced 126,000 lb — 3 loads. Bill: "a ridiculous amount".
        const r = recommendQty(inputFor("RAWWORMCASTINGS", {
            dailyRate: 2_800,
            stockOnHand: 72_357,
            stockOnOrder: 0,
            openPOCount: 0,
            leadTimeDays: 14,
            coverBufferDays: 30,
            targetCoverDays: 90,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));
        expect(r.suggestedQty).toBe(63_000);
        expect(r.provenance.some(p => p.step === "raw_ingredient_ceiling")).toBe(true);
        expect(r.reviewReasons.join(" ")).toMatch(/capped/i);
    });

    it("does not touch a requirement already under the ceiling", () => {
        const r = recommendQty(inputFor("RAWMALIBUCOMPOST", {
            dailyRate: 200,
            stockOnHand: 0,
            stockOnOrder: 0,
            openPOCount: 0,
            leadTimeDays: 14,
            coverBufferDays: 0,
            targetCoverDays: 30,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));
        expect(r.suggestedQty).toBeGreaterThanOrEqual(42_000);
        expect(r.suggestedQty).toBeLessThan(63_000);
        expect(r.provenance.some(p => p.step === "raw_ingredient_ceiling")).toBe(false);
    });

    it("does not cap SKUs with no raw bounds", () => {
        const r = recommendQty(inputFor("PU100", {
            dailyRate: 5_000,
            stockOnHand: 0,
            stockOnOrder: 0,
            openPOCount: 0,
            leadTimeDays: 14,
            coverBufferDays: 30,
            targetCoverDays: 90,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));
        expect(r.suggestedQty).toBeGreaterThan(63_000);
        expect(r.provenance.some(p => p.step === "raw_ingredient_ceiling")).toBe(false);
    });
});
