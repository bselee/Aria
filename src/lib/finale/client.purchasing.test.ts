import { describe, expect, it } from "vitest";
import {
    calculateSuggestedReorderQty,
    resolvePurchasingDailyRate,
    summarizePurchasingDemandAnomalies,
} from "./client";

describe("resolvePurchasingDailyRate", () => {
    it("falls back when Finale demand velocity is wildly inconsistent with real movement", () => {
        const result = resolvePurchasingDailyRate({
            purchaseVelocity: 0,
            salesVelocity: 12 / 90,
            demandVelocity: 93.13,
            consumptionQuantity90d: 12,
            stockOnHand: 13,
            stockoutDays: 97,
        });

        expect(result.demandAnomalous).toBe(true);
        expect(result.dailyRate).toBeCloseTo(12 / 90, 3);
        expect(result.rateSource).toBe("90d consumption");
    });

    it("still uses purchase velocity when there is no better demand signal", () => {
        const result = resolvePurchasingDailyRate({
            purchaseVelocity: 17.8,
            salesVelocity: 0,
            demandVelocity: 0,
            consumptionQuantity90d: 0,
            stockOnHand: 100,
            stockoutDays: null,
        });

        expect(result.demandAnomalous).toBe(false);
        expect(result.dailyRate).toBe(17.8);
        expect(result.rateSource).toBe("90d receipts");
    });
});

describe("calculateSuggestedReorderQty", () => {
    it("nets out on-hand and on-order supply before suggesting reorder quantity", () => {
        const suggestedQty = calculateSuggestedReorderQty({
            dailyRate: 12 / 90,
            leadTimeDays: 14,
            stockOnHand: 13,
            stockOnOrder: 0,
            orderIncrementQty: null,
        });

        expect(suggestedQty).toBe(0);
    });

    it("rounds the net needed quantity to the configured order increment", () => {
        const suggestedQty = calculateSuggestedReorderQty({
            dailyRate: 3,
            leadTimeDays: 14,
            stockOnHand: 20,
            stockOnOrder: 10,
            orderIncrementQty: 25,
        });

        expect(suggestedQty).toBe(200);
    });
});

describe("summarizePurchasingDemandAnomalies", () => {
    it("returns only items whose Finale demand signal was flagged anomalous", () => {
        const anomalies = summarizePurchasingDemandAnomalies([
            {
                vendorName: "TeraGanix",
                vendorPartyId: "10075",
                urgency: "ok",
                items: [
                    {
                        productId: "EM103",
                        productName: "EM 1 Microbial Inoculant - (1gal)",
                        supplierName: "TeraGanix",
                        supplierPartyId: "10075",
                        unitPrice: 55.7,
                        stockOnHand: 13,
                        stockOnOrder: 0,
                        purchaseVelocity: 0,
                        salesVelocity: 12 / 90,
                        demandVelocity: 93.13,
                        dailyRate: 12 / 90,
                        runwayDays: 97.5,
                        adjustedRunwayDays: 97.5,
                        leadTimeDays: 14,
                        leadTimeProvenance: "14d default",
                        openPOs: [],
                        urgency: "ok",
                        explanation: "ignored anomalous Finale demand",
                        suggestedQty: 0,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                        finaleDemandAnomalous: true,
                        finaleReorderQty: 5580,
                        finaleStockoutDays: 97,
                        finaleConsumptionQty: 12,
                        finaleDemandQty: 8382,
                    },
                    {
                        productId: "SAFE-1",
                        productName: "Normal Item",
                        supplierName: "TeraGanix",
                        supplierPartyId: "10075",
                        unitPrice: 10,
                        stockOnHand: 5,
                        stockOnOrder: 0,
                        purchaseVelocity: 1,
                        salesVelocity: 1,
                        demandVelocity: 1,
                        dailyRate: 1,
                        runwayDays: 5,
                        adjustedRunwayDays: 5,
                        leadTimeDays: 14,
                        leadTimeProvenance: "14d default",
                        openPOs: [],
                        urgency: "warning",
                        explanation: "normal",
                        suggestedQty: 60,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                        finaleDemandAnomalous: false,
                        finaleReorderQty: 60,
                        finaleStockoutDays: 5,
                        finaleConsumptionQty: 90,
                        finaleDemandQty: 90,
                    },
                ],
            },
        ]);

        expect(anomalies).toHaveLength(1);
        expect(anomalies[0]).toMatchObject({
            productId: "EM103",
            vendorName: "TeraGanix",
            rawDemandVelocity: 93.13,
            trustedDailyRate: 12 / 90,
            anomalyRatio: 93.13 / (12 / 90),
        });
    });
});
