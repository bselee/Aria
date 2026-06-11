import { describe, expect, it } from "vitest";

import { shouldIncludePurchasingCandidate } from "./purchasing-candidate";

describe("shouldIncludePurchasingCandidate", () => {
    it("admits products with a Finale reorder recommendation (original gate)", () => {
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 12,
            finaleConsumptionQty: 0,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(true);
    });

    it("admits products with measurable demand even when Finale skips reorder (v2.7)", () => {
        // RMC103 case: Finale's demand velocity calculation stutters on
        // low-volume items, reorderQuantityToOrder comes back null/0,
        // but demandQuantity is positive — Aria should evaluate it.
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 18,
            finaleDemandPerDay: 0,
            finaleStockoutDays: 30,
        })).toBe(true);

        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 18,
            finaleDemandPerDay: 0,
            finaleStockoutDays: null,
        })).toBe(true);

        // demandPerDay positive — Finale tracking velocity
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0.67,
        })).toBe(true);
    });

    it("rejects products with zero signals across the board", () => {
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(false);
    });

    it("rejects consumption-only with no demand signal (pure BOM, no retail)", () => {
        // BOM components with consumption but no demand should NOT admit
        // through the retail pipeline — the BOM pipeline handles them.
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 3,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(false);
    });

    it("admits when both reorder and demand are positive", () => {
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 60,
            finaleConsumptionQty: 10,
            finaleDemandQty: 50,
            finaleDemandPerDay: 1.7,
        })).toBe(true);
    });
});
