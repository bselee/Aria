import { describe, expect, it } from "vitest";

import { shouldIncludePurchasingCandidate } from "./purchasing-candidate";

describe("shouldIncludePurchasingCandidate (v2.8 multi-signal OR gate)", () => {
    describe("Finale signals", () => {
        it("admits products with a Finale reorder recommendation (Path 1)", () => {
            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 12,
                finaleConsumptionQty: 0,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
            })).toBe(true);
        });

        it("admits products with measurable Finale demand (Path 2)", () => {
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
                finaleDemandQty: 0,
                finaleDemandPerDay: 0.67,
            })).toBe(true);
        });

        it("rejects products when all Finale signals are zero", () => {
            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 0,
                finaleConsumptionQty: 3,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
            })).toBe(false);

            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 0,
                finaleConsumptionQty: 0,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
            })).toBe(false);
        });
    });

    describe("Aria PO history (Path 3)", () => {
        it("admits when our PO history shows orders", () => {
            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 0,
                finaleConsumptionQty: 0,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
                ariaPOHistory: {
                    hasHistory: true,
                    totalQty: 2253,
                    orderCount: 90,
                    firstOrderDate: "2017-02-16",
                    lastOrderDate: "2026-06-10",
                    avgDailyRate: 0.53,
                },
            })).toBe(true);
        });

        it("rejects when no Finale signals AND no our PO history", () => {
            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 0,
                finaleConsumptionQty: 0,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
                ariaPOHistory: {
                    hasHistory: false,
                    totalQty: 0,
                    orderCount: 0,
                    firstOrderDate: null,
                    lastOrderDate: null,
                    avgDailyRate: null,
                },
            })).toBe(false);
        });

        it("admits when all signals zero but PO history has data", () => {
            expect(shouldIncludePurchasingCandidate({
                finaleReorderQty: 0,
                finaleConsumptionQty: 0,
                finaleDemandQty: 0,
                finaleDemandPerDay: 0,
                ariaPOHistory: {
                    hasHistory: true,
                    totalQty: 100,
                    orderCount: 5,
                    firstOrderDate: "2025-01-01",
                    lastOrderDate: "2025-06-01",
                    avgDailyRate: 0.3,
                },
            })).toBe(true);
        });
    });
});
