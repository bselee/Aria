import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    assessGroupsMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    assessGroupsMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/assessment-service", () => ({
    assessPurchasingGroups: assessGroupsMock,
}));

import { GET } from "./route";

describe("dashboard purchasing route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.getPurchasingIntelligence = vi.fn().mockResolvedValue([
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
        });

        assessGroupsMock.mockReturnValue({
            groups: [
                {
                    vendorName: "ULINE",
                    vendorPartyId: "party-1",
                    urgency: "critical",
                    items: [
                        {
                            item: {
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
                            candidate: {
                                directDemand: 9,
                                bomDemand: 0,
                            },
                            assessment: {
                                decision: "order",
                                recommendedQty: 300,
                                confidence: "high",
                                explanation: "Current demand and supply position support placing a reorder now.",
                                reasonCodes: ["direct_demand_support"],
                            },
                        },
                    ],
                },
            ],
            actionableLines: [{}],
            blockedLines: [],
            vendorSummaries: [
                {
                    vendorName: "ULINE",
                    vendorPartyId: "party-1",
                    actionableCount: 1,
                    blockedCount: 0,
                    highestConfidence: "high",
                },
            ],
        });
    });

    it("returns assessed purchasing groups while preserving the item fields the dashboard already uses", async () => {
        const response = await GET(
            {
                nextUrl: new URL("http://localhost/api/dashboard/purchasing?bust=1"),
            } as any,
        );

        expect(response.status).toBe(200);
        expect(assessGroupsMock).toHaveBeenCalledTimes(1);

        const body = await response.json();
        expect(body.groups).toHaveLength(1);
        expect(body.groups[0].items[0]).toMatchObject({
            productId: "BOX-101",
            productName: "Shipping Box",
            suggestedQty: 300,
            reorderMethod: "demand_velocity",
            assessment: {
                decision: "order",
                recommendedQty: 300,
            },
            candidate: {
                directDemand: 9,
                bomDemand: 0,
            },
        });
        expect(body.vendorSummaries).toEqual([
            expect.objectContaining({
                vendorName: "ULINE",
                actionableCount: 1,
            }),
        ]);
    });
});
