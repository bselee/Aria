import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    scrapeBasautoPurchasingDataMock,
    loadPendingUlineRequestDemandMock,
    runUlineOrderMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    scrapeBasautoPurchasingDataMock: vi.fn(),
    loadPendingUlineRequestDemandMock: vi.fn(),
    runUlineOrderMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/basauto-purchases", () => ({
    scrapeBasautoPurchasingData: scrapeBasautoPurchasingDataMock,
}));

vi.mock("@/lib/purchasing/uline-request-demand", () => ({
    loadPendingUlineRequestDemand: loadPendingUlineRequestDemandMock,
}));

vi.mock("@/lib/purchasing/uline-order-service", () => ({
    runUlineOrder: runUlineOrderMock,
}));

import { POST } from "./route";

function makeRequest(body: any) {
    return new Request("http://localhost/api/dashboard/purchasing/uline-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }) as any;
}

describe("dashboard uline flow route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        scrapeBasautoPurchasingDataMock.mockResolvedValue({
            purchases: {
                ULINE: [{ sku: "S-1", description: "Box", recommendedReorderQty: "9" }],
            },
            requests: [],
        });

        loadPendingUlineRequestDemandMock.mockResolvedValue([
            { sku: "S-2", description: "Tape", requiredQty: 7, sources: ["request"] },
        ]);

        runUlineOrderMock.mockResolvedValue({
            success: true,
            itemsAdded: 2,
            message: "Added 2 verified item(s) to ULINE cart.",
            priceUpdatesApplied: 1,
        });
    });

    it("delegates create-or-reuse to Finale, verifies, and orders the merged demand", async () => {
        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124500",
                finaleUrl: "https://finale/124500",
                duplicateWarnings: [],
                priceAlerts: [],
            });
            this.getOrderDetails = vi.fn().mockResolvedValue({
                orderId: "124500",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    { productId: "S-1", quantity: 9, unitPrice: 1.25, itemDescription: "Box" },
                    { productId: "S-2", quantity: 7, unitPrice: 2.5, itemDescription: "Tape" },
                ],
            });
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(200);
        expect(runUlineOrderMock).toHaveBeenCalledWith(
            expect.objectContaining({
                draftPO: "124500",
                items: expect.arrayContaining([
                    expect.objectContaining({ productId: "S-1", quantity: 9 }),
                    expect.objectContaining({ productId: "S-2", quantity: 7 }),
                ]),
            }),
        );

        const json = await response.json();
        expect(json.success).toBe(true);
        expect(json.draftPO.orderId).toBe("124500");
    });

    it("blocks when a committed ULINE PO exists within 7 days", async () => {
        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ]);
            this.createDraftPurchaseOrder = vi.fn();
            this.getOrderDetails = vi.fn();
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(409);
        expect(runUlineOrderMock).not.toHaveBeenCalled();
        const json = await response.json();
        expect(json.success).toBe(false);
        expect(json.blockingPO.orderId).toBe("124490");
    });

    it("continues gracefully when basauto scrape fails", async () => {
        scrapeBasautoPurchasingDataMock.mockRejectedValue(new Error("basauto session expired"));

        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124600",
                finaleUrl: "https://finale/124600",
                duplicateWarnings: [],
                priceAlerts: [],
            });
            this.getOrderDetails = vi.fn().mockResolvedValue({
                orderId: "124600",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    { productId: "S-1", quantity: 5, unitPrice: 1.25, itemDescription: "Box" },
                    { productId: "S-2", quantity: 7, unitPrice: 2.5, itemDescription: "Tape" },
                ],
            });
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.success).toBe(true);
    });

    it("filters out zero-quantity items before ordering", async () => {
        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124700",
                finaleUrl: "https://finale/124700",
                duplicateWarnings: [],
                priceAlerts: [],
            });
            this.getOrderDetails = vi.fn().mockResolvedValue({
                orderId: "124700",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    { productId: "S-2", quantity: 7, unitPrice: 2.5, itemDescription: "Tape" },
                ],
            });
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [
                { productId: "S-ZERO", quantity: 0, unitPrice: 1 },
                { productId: "S-NEG", quantity: -5, unitPrice: 1 },
            ],
        }));

        // Still succeeds because request demand (S-2) provides items
        expect(response.status).toBe(200);
        // Zero-qty items not passed to createDraftPurchaseOrder
        const createCall = finaleCtorMock.mock.results[0].value.createDraftPurchaseOrder.mock.calls[0];
        const skusInDraft = createCall[1].map((i: any) => i.productId);
        expect(skusInDraft).not.toContain("S-ZERO");
        expect(skusInDraft).not.toContain("S-NEG");
    });
});
