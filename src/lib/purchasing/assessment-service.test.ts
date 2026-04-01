import { describe, expect, it } from "vitest";

import { assessPurchasingGroups } from "./assessment-service";

describe("assessPurchasingGroups", () => {
    it("assesses vendor groups and surfaces actionable lines for draft POs", () => {
        const result = assessPurchasingGroups([
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
                        explanation: "Demand exceeds available runway.",
                        suggestedQty: 300,
                        orderIncrementQty: 25,
                        isBulkDelivery: false,
                        finaleReorderQty: 300,
                        finaleStockoutDays: 3,
                        finaleConsumptionQty: 0,
                        finaleDemandQty: 270,
                        reorderMethod: "demand_velocity",
                    },
                ],
            },
        ]);

        expect(result.groups).toHaveLength(1);
        expect(result.actionableLines).toHaveLength(1);
        expect(result.blockedLines).toHaveLength(0);
        expect(result.groups[0].items[0].assessment.decision).toBe("order");
    });

    it("preserves hold and manual review lines with explanations", () => {
        const result = assessPurchasingGroups([
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
                        purchaseVelocity: 2,
                        salesVelocity: 0,
                        demandVelocity: 6,
                        dailyRate: 6,
                        runwayDays: 83.3,
                        adjustedRunwayDays: 83.3,
                        leadTimeDays: 21,
                        leadTimeProvenance: "21d default",
                        openPOs: [],
                        urgency: "warning",
                        explanation: "Component consumed in builds.",
                        suggestedQty: 180,
                        orderIncrementQty: 50,
                        isBulkDelivery: false,
                        finaleReorderQty: 180,
                        finaleStockoutDays: 40,
                        finaleConsumptionQty: 150,
                        finaleDemandQty: 180,
                        reorderMethod: "default",
                    },
                    {
                        productId: "LABEL-42",
                        productName: "Label Roll",
                        supplierName: "Sustainable Village",
                        supplierPartyId: "party-2",
                        unitPrice: 0.12,
                        stockOnHand: 120,
                        stockOnOrder: 0,
                        purchaseVelocity: 0,
                        salesVelocity: 4,
                        demandVelocity: 4,
                        dailyRate: 4,
                        runwayDays: 30,
                        adjustedRunwayDays: 30,
                        leadTimeDays: 21,
                        leadTimeProvenance: "21d default",
                        openPOs: [],
                        urgency: "warning",
                        explanation: "Labels sell directly but come in huge pack sizes.",
                        suggestedQty: 500,
                        orderIncrementQty: 5000,
                        isBulkDelivery: false,
                        finaleReorderQty: 500,
                        finaleStockoutDays: 20,
                        finaleConsumptionQty: 0,
                        finaleDemandQty: 120,
                        reorderMethod: "manual",
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

        expect(result.actionableLines).toHaveLength(0);
        expect(result.blockedLines).toHaveLength(2);
        expect(result.blockedLines.map(line => line.assessment.decision)).toEqual(
            expect.arrayContaining(["hold", "manual_review"]),
        );
        expect(result.blockedLines[0].assessment.explanation.length).toBeGreaterThan(0);
    });

    it("works across multiple vendors without vendor-specific branching", () => {
        const result = assessPurchasingGroups([
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
        ]);

        expect(result.groups.map(group => group.vendorName)).toEqual(["ULINE", "Axiom"]);
        expect(result.vendorSummaries).toHaveLength(2);
    });

    it("filters non-moving default items out of actionable assessment output", () => {
        const result = assessPurchasingGroups([
            {
                vendorName: "ULINE",
                vendorPartyId: "party-1",
                urgency: "watch",
                items: [
                    {
                        productId: "DUSTY-SKU",
                        productName: "Dusty SKU",
                        supplierName: "ULINE",
                        supplierPartyId: "party-1",
                        unitPrice: 1,
                        stockOnHand: 100,
                        stockOnOrder: 0,
                        purchaseVelocity: 0,
                        salesVelocity: 0,
                        demandVelocity: 0,
                        dailyRate: 0,
                        runwayDays: 999,
                        adjustedRunwayDays: 999,
                        leadTimeDays: 14,
                        leadTimeProvenance: "14d (Finale)",
                        openPOs: [],
                        urgency: "watch",
                        explanation: "No recent movement.",
                        suggestedQty: 10,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                        finaleReorderQty: null,
                        finaleStockoutDays: null,
                        finaleConsumptionQty: 0,
                        finaleDemandQty: 0,
                        reorderMethod: "default",
                    },
                ],
            },
        ]);

        expect(result.groups[0].items).toHaveLength(0);
        expect(result.actionableLines).toHaveLength(0);
    });
});
