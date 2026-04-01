import { describe, expect, it } from "vitest";

import { buildPurchasingCandidate } from "./policy-candidates";

describe("buildPurchasingCandidate", () => {
    it("maps Finale purchasing rows into shared policy inputs", () => {
        const candidate = buildPurchasingCandidate({
            productId: "BOX-101",
            productName: "Shipping Box",
            supplierName: "ULINE",
            supplierPartyId: "party-1",
            unitPrice: 1.15,
            stockOnHand: 20,
            stockOnOrder: 100,
            purchaseVelocity: 0,
            salesVelocity: 9,
            demandVelocity: 9,
            dailyRate: 9,
            runwayDays: 2.2,
            adjustedRunwayDays: 13.3,
            leadTimeDays: 14,
            leadTimeProvenance: "14d (Finale)",
            openPOs: [{ orderId: "124500", quantity: 100, orderDate: "2026-03-28" }],
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
        });

        expect(candidate).toMatchObject({
            vendorName: "ULINE",
            productId: "BOX-101",
            directDemand: 9,
            bomDemand: 0,
            stockOnOrder: 100,
            leadTimeDays: 14,
            suggestedQty: 300,
            orderIncrementQty: 25,
            reorderMethod: "demand_velocity",
            sourceUrgency: "critical",
        });
    });

    it("supports mixed-use SKUs with explicit BOM and finished-goods coverage context", () => {
        const candidate = buildPurchasingCandidate({
            productId: "VALVE-3MM",
            productName: "Valve",
            supplierName: "Sustainable Village",
            supplierPartyId: "party-2",
            unitPrice: 0.32,
            stockOnHand: 500,
            stockOnOrder: 0,
            purchaseVelocity: 2,
            salesVelocity: 1,
            demandVelocity: 6,
            dailyRate: 6,
            runwayDays: 83.3,
            adjustedRunwayDays: 83.3,
            leadTimeDays: 21,
            leadTimeProvenance: "21d default",
            openPOs: [],
            urgency: "watch",
            explanation: "Component consumed in builds and sold directly.",
            suggestedQty: 180,
            orderIncrementQty: 50,
            isBulkDelivery: false,
            finaleReorderQty: 180,
            finaleStockoutDays: 40,
            finaleConsumptionQty: 150,
            finaleDemandQty: 180,
            reorderMethod: "default",
        }, {
            directDemand: 30,
            bomDemand: 150,
            finishedGoodsCoverageDays: 34,
            minimumOrderValue: 150,
        });

        expect(candidate.directDemand).toBe(30);
        expect(candidate.bomDemand).toBe(150);
        expect(candidate.finishedGoodsCoverageDays).toBe(34);
        expect(candidate.minimumOrderValue).toBe(150);
    });
});
