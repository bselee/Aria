import { describe, expect, it } from "vitest";

import { shouldIncludePurchasingCandidate } from "./purchasing-candidate";

describe("shouldIncludePurchasingCandidate", () => {
    it("keeps only products with a real purchasing signal", () => {
        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(false);

        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 12,
            finaleConsumptionQty: 0,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(true);

        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 3,
            finaleDemandQty: 0,
            finaleDemandPerDay: 0,
        })).toBe(false);

        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 18,
            finaleDemandPerDay: 0,
            finaleStockoutDays: 30,
        })).toBe(false);

        expect(shouldIncludePurchasingCandidate({
            finaleReorderQty: 0,
            finaleConsumptionQty: 0,
            finaleDemandQty: 18,
            finaleDemandPerDay: 0,
            finaleStockoutDays: null,
        })).toBe(false);
    });
});
