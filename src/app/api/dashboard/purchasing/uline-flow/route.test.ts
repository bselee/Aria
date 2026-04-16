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

describe("dashboard uline flow route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        scrapeBasautoPurchasingDataMock.mockResolvedValue({
            purchases: {
                ULINE: [
                    { sku: "S-1", description: "Box", recommendedReorderQty: "9" },
                ],
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

    it("reuses an existing draft, verifies it, and orders the merged ULINE demand", async () => {
        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.findActiveDraftPOsForVendor = vi.fn().mockResolvedValue([
                { orderId: "124500", orderDate: "2026-04-11", finaleUrl: "https://finale/124500" },
            ]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124500",
                finaleUrl: "https://finale/124500",
                duplicateWarnings: ["Reused existing draft PO #124500 for this vendor."],
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

        const response = await POST(new Request("http://localhost/api/dashboard/purchasing/uline-flow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vendorName: "ULINE",
                vendorPartyId: "party-uline",
                items: [
                    { productId: "S-1", quantity: 5, unitPrice: 1.25 },
                ],
            }),
        }) as any);

        expect(response.status).toBe(200);
        expect(runUlineOrderMock).toHaveBeenCalledWith(
            expect.objectContaining({
                draftPO: "124500",
                items: [
                    { productId: "S-1", quantity: 9, unitPrice: 1.25 },
                    { productId: "S-2", quantity: 7, unitPrice: 2.5 },
                ],
            }),
        );

        await expect(response.json()).resolves.toMatchObject({
            success: true,
            draftResolution: { action: "reuse_existing_draft" },
            draftPO: { orderId: "124500" },
            preOrderVerification: { verified: true },
        });
    });

    it("stops for review when the newest vendor PO is committed and no active draft exists", async () => {
        finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ]);
            this.findActiveDraftPOsForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn();
            this.getOrderDetails = vi.fn();
        });

        const response = await POST(new Request("http://localhost/api/dashboard/purchasing/uline-flow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vendorName: "ULINE",
                vendorPartyId: "party-uline",
                items: [
                    { productId: "S-1", quantity: 5, unitPrice: 1.25 },
                ],
            }),
        }) as any);

        expect(response.status).toBe(409);
        expect(runUlineOrderMock).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            draftResolution: { action: "review_required" },
        });
    });
});
