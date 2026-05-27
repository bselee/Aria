import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    assessGroupsMock,
    createDraftMock,
    recentPurchaseOrdersMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    assessGroupsMock: vi.fn(),
    createDraftMock: vi.fn(),
    recentPurchaseOrdersMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/cache", () => ({
    resaleSlot: { value: null, at: 0, promise: null },
    bomSlot: { value: null, at: 0, promise: null },
    readSWR: vi.fn(async (slot, fetcher) => {
        const val = await fetcher();
        return { value: val, refreshing: false };
    }),
    invalidatePurchasingCaches: vi.fn(),
}));

vi.mock("@/lib/purchasing/assessment-service", () => ({
    assessPurchasingGroups: assessGroupsMock,
}));

import { GET, POST } from "./route";
import { resaleSlot, bomSlot } from "@/lib/purchasing/cache";

describe("dashboard purchasing route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resaleSlot.value = null;
        resaleSlot.at = 0;
        resaleSlot.promise = null;
        bomSlot.value = null;
        bomSlot.at = 0;
        bomSlot.promise = null;

        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.getBOMDemand = vi.fn().mockResolvedValue([]);
            this.getRecentPurchaseOrders = recentPurchaseOrdersMock;
            this.createDraftPurchaseOrder = createDraftMock;
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
        recentPurchaseOrdersMock.mockResolvedValue([]);
        createDraftMock.mockResolvedValue({
            orderId: "125000",
            finaleUrl: "https://example.com/po/125000",
            facilityName: "Shipping",
            duplicateWarnings: [],
            priceAlerts: [],
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
            commitGuard: {
                decision: "draft_only",
                targetCoverDays: 44,
                blockReasons: ["recommended_qty_below_lead_plus_30"],
            },
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

    it("rejects draft creation when requested lines fail the commit guard", async () => {
        const response = await POST({
            json: async () => ({
                vendorPartyId: "party-1",
                items: [
                    {
                        productId: "BOX-101",
                        quantity: 300,
                        unitPrice: 1.15,
                        orderIncrementQty: 25,
                        isBulkDelivery: false,
                    },
                ],
            }),
        } as any);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toContain("lead time plus 30");
        expect(body.guards[0]).toMatchObject({
            productId: "BOX-101",
            decision: "draft_only",
            blockReasons: ["recommended_qty_below_lead_plus_30"],
        });
        expect(createDraftMock).not.toHaveBeenCalled();
    });

    it("rejects routine draft creation when the vendor cycle is locked by a recent PO", async () => {
        recentPurchaseOrdersMock.mockResolvedValue([
            {
                orderId: "124832",
                vendorName: "FedEx",
                status: "Committed",
                orderDate: "2026-05-19",
                receiveDate: null,
                items: [{ productId: "OTHER-SKU", quantity: 1 }],
            },
        ]);

        const response = await POST({
            json: async () => ({
                vendorPartyId: "party-2",
                items: [
                    {
                        productId: "LABEL-200",
                        quantity: 100,
                        unitPrice: 0.25,
                        orderIncrementQty: null,
                        isBulkDelivery: false,
                    },
                ],
            }),
        } as any);

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.vendorCycle).toMatchObject({
            decision: "routine_locked",
            blockingPO: { orderId: "124832" },
        });
        expect(createDraftMock).not.toHaveBeenCalled();
    });

    it("uses warm purchasing cache for draft creation instead of rescanning Finale", async () => {
        const cachedGroup = {
            vendorName: "FedEx Supplies",
            vendorPartyId: "party-2",
            urgency: "warning" as const,
            items: [
                {
                    productId: "LABEL-200",
                    productName: "Thermal Label",
                    supplierName: "FedEx Supplies",
                    supplierPartyId: "party-2",
                    unitPrice: 0.08,
                    stockOnHand: 200,
                    stockOnOrder: 0,
                    purchaseVelocity: 0.8,
                    salesVelocity: 0.8,
                    demandVelocity: 0.8,
                    dailyRate: 0.8,
                    runwayDays: 250,
                    adjustedRunwayDays: 250,
                    leadTimeDays: 7,
                    leadTimeProvenance: "7d default",
                    openPOs: [],
                    urgency: "warning" as const,
                    explanation: "Routine reorder.",
                    suggestedQty: 100,
                    orderIncrementQty: 1,
                    isBulkDelivery: false,
                    finaleReorderQty: 100,
                    finaleStockoutDays: 250,
                    finaleConsumptionQty: 0,
                    finaleDemandQty: 24,
                    reorderMethod: "demand_velocity" as const,
                },
            ],
        };
        resaleSlot.value = [cachedGroup];
        resaleSlot.at = Date.now();

        const response = await POST({
            json: async () => ({
                vendorPartyId: "party-2",
                items: [{ productId: "LABEL-200", quantity: 100, unitPrice: 0.08 }],
            }),
        } as any);

        expect(response.status).toBe(200);
        const client = (finaleCtorMock as any).mock.results[0].value;
        expect(client.getPurchasingIntelligence).not.toHaveBeenCalled();
        expect(createDraftMock).toHaveBeenCalledWith(
            "party-2",
            [{ productId: "LABEL-200", quantity: 100, unitPrice: 0.08 }],
            undefined,
            undefined,
        );
    });
});
