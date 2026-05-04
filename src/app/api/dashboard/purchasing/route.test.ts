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
                {
                    vendorName: "FedEx",
                    vendorPartyId: "party-2",
                    urgency: "warning",
                    items: [
                        {
                            productId: "LABEL-200",
                            productName: "Shipping Label",
                            supplierName: "FedEx",
                            supplierPartyId: "party-2",
                            unitPrice: 0.25,
                            stockOnHand: 100,
                            stockOnOrder: 0,
                            purchaseVelocity: 0,
                            salesVelocity: 2,
                            demandVelocity: 2,
                            dailyRate: 2,
                            runwayDays: 50,
                            adjustedRunwayDays: 50,
                            leadTimeDays: 14,
                            leadTimeProvenance: "14d default",
                            openPOs: [],
                            urgency: "warning",
                            explanation: "Stock ok.",
                            suggestedQty: 100,
                            orderIncrementQty: null,
                            isBulkDelivery: false,
                            finaleReorderQty: 500,
                            finaleStockoutDays: null,
                            finaleConsumptionQty: 0,
                            finaleDemandQty: 50,
                            reorderMethod: "demand_velocity",
                            qtyDiverged: true,
                            qtyDivergencePct: -80,
                        },
                    ],
                },
            ]);
        });

        assessGroupsMock.mockImplementation((groups: any[]) => ({
            groups: groups.map(g => ({
                vendorName: g.vendorName,
                vendorPartyId: g.vendorPartyId,
                urgency: g.urgency,
                items: g.items.map((item: any) => ({
                    item,
                    candidate: {
                        directDemand: item.dailyRate,
                        bomDemand: item.finaleConsumptionQty ?? 0,
                    },
                    assessment: {
                        decision: item.urgency === "critical" || item.urgency === "warning" ? "order" : "hold",
                        recommendedQty: item.suggestedQty,
                        confidence: "high",
                        explanation: "Assessment computed.",
                        reasonCodes: ["test"],
                    },
                })),
            })),
            actionableLines: [],
            blockedLines: [],
            vendorSummaries: groups.map(g => ({
                vendorName: g.vendorName,
                vendorPartyId: g.vendorPartyId,
                actionableCount: g.items.length,
                blockedCount: 0,
                highestConfidence: "high",
            })),
        }));
    });

    it("returns assessed purchasing groups while preserving item fields", async () => {
        const response = await GET(
            { nextUrl: new URL("http://localhost/api/dashboard/purchasing?bust=1") } as any,
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.groups).toHaveLength(2);
        expect(body.groups[0].items[0]).toMatchObject({
            productId: "BOX-101",
            suggestedQty: 300,
            reorderMethod: "demand_velocity",
            assessment: { decision: "order", recommendedQty: 300 },
            candidate: { directDemand: 9, bomDemand: 0 },
        });
    });

    it("filters groups by urgency tier", async () => {
        const response = await GET(
            { nextUrl: new URL("http://localhost/api/dashboard/purchasing?urgency=critical&bust=1") } as any,
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.groups).toHaveLength(1);
        expect(body.groups[0].urgency).toBe("critical");
        expect(body.groups[0].vendorName).toBe("ULINE");
    });

    it("supports comma-separated urgency tiers", async () => {
        const response = await GET(
            { nextUrl: new URL("http://localhost/api/dashboard/purchasing?urgency=critical,warning&bust=1") } as any,
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.groups).toHaveLength(2);
        expect(body.groups.map((g: any) => g.urgency)).toEqual(["critical", "warning"]);
    });

    it("returns all groups when no urgency filter is supplied", async () => {
        const response = await GET(
            { nextUrl: new URL("http://localhost/api/dashboard/purchasing?bust=1") } as any,
        );

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.groups).toHaveLength(2);
    });
});
