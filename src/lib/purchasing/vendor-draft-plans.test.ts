import { describe, expect, it } from "vitest";

import { buildVendorDraftPlans } from "./vendor-draft-plans";

describe("buildVendorDraftPlans", () => {
    it("builds actionable draft plans from assessed vendor groups", () => {
        const result = buildVendorDraftPlans([
            {
                vendorName: "ULINE",
                vendorPartyId: "party-1",
                urgency: "critical",
                items: [
                    {
                        productId: "BOX-101",
                        productName: "Shipping Box",
                        supplierName: "ULINE",
                        supplierPartyId: "party-1",
                        unitPrice: 1.15,
                        stockOnHand: 20,
                        stockOnOrder: 0,
                        purchaseVelocity: 0,
                        salesVelocity: 9,
                        demandVelocity: 9,
                        dailyRate: 9,
                        runwayDays: 2.2,
                        adjustedRunwayDays: 2.2,
                        leadTimeDays: 14,
                        leadTimeProvenance: "14d (Finale)",
                        openPOs: [],
                        urgency: "critical",
                        explanation: "Demand exceeds runway.",
                        suggestedQty: 300,
                        orderIncrementQty: 25,
                        isBulkDelivery: false,
                        finaleReorderQty: 300,
                        finaleStockoutDays: 3,
                        finaleConsumptionQty: 0,
                        finaleDemandQty: 270,
                    },
                ],
            },
        ]);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            vendorName: "ULINE",
            actionableItems: [
                {
                    productId: "BOX-101",
                    quantity: 300,
                },
            ],
        });
        expect(result[0].blockedLines).toHaveLength(0);
    });

    it("keeps blocked lines out of draft items while preserving their explanations", () => {
        const result = buildVendorDraftPlans([
            {
                vendorName: "Sustainable Village",
                vendorPartyId: "party-2",
                urgency: "warning",
                items: [
                    {
                        productId: "VALVE-3MM",
                        productName: "Valve",
                        supplierName: "Sustainable Village",
                        supplierPartyId: "party-2",
                        unitPrice: 0.32,
                        stockOnHand: 500,
                        stockOnOrder: 0,
                        purchaseVelocity: 0,
                        salesVelocity: 0,
                        demandVelocity: 6,
                        dailyRate: 6,
                        runwayDays: 83.3,
                        adjustedRunwayDays: 83.3,
                        leadTimeDays: 21,
                        leadTimeProvenance: "21d default",
                        openPOs: [],
                        urgency: "warning",
                        explanation: "Component demand only.",
                        suggestedQty: 180,
                        orderIncrementQty: 50,
                        isBulkDelivery: false,
                        finaleReorderQty: 180,
                        finaleStockoutDays: 40,
                        finaleConsumptionQty: 150,
                        finaleDemandQty: 180,
                    },
                ],
            },
        ], {
            itemContexts: {
                "VALVE-3MM": {
                    directDemand: 0,
                    bomDemand: 150,
                    finishedGoodsCoverageDays: 42,
                },
            },
        });

        expect(result[0].actionableItems).toHaveLength(0);
        expect(result[0].blockedLines).toHaveLength(1);
        expect(result[0].blockedLines[0].assessment.explanation).toContain("Finished goods already have healthy coverage");
    });

    it("supports vendor filtering without rescanning unrelated vendors", () => {
        const result = buildVendorDraftPlans([
            {
                vendorName: "ULINE",
                vendorPartyId: "party-1",
                urgency: "critical",
                items: [],
            },
            {
                vendorName: "Axiom",
                vendorPartyId: "party-2",
                urgency: "warning",
                items: [],
            },
        ], {}, "axiom");

        expect(result).toHaveLength(1);
        expect(result[0].vendorName).toBe("Axiom");
    });
});
