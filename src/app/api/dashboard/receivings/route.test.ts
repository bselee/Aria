import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    getTodaysReceivedPOsMock,
    getOrderDetailsMock,
    completeOrderMock,
    getShipmentDetailsMock,
    updateOrderItemQuantityAndPriceMock,
    updateProductSupplierPriceMock,
    addOrderAdjustmentMock,
    updateOrderAdjustmentAmountMock,
    createClientMock,
    supabaseChain,
} = vi.hoisted(() => {
    const chain = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        upsert: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    return {
        getTodaysReceivedPOsMock: vi.fn(),
        getOrderDetailsMock: vi.fn(),
        completeOrderMock: vi.fn(),
        getShipmentDetailsMock: vi.fn(),
        updateOrderItemQuantityAndPriceMock: vi.fn(),
        updateProductSupplierPriceMock: vi.fn(),
        addOrderAdjustmentMock: vi.fn(),
        updateOrderAdjustmentAmountMock: vi.fn(),
        createClientMock: vi.fn().mockReturnValue(chain),
        supabaseChain: chain,
    };
});

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: class {
        getTodaysReceivedPOs = getTodaysReceivedPOsMock;
        getOrderDetails = getOrderDetailsMock;
        completeOrder = completeOrderMock;
        getShipmentDetails = getShipmentDetailsMock;
        updateOrderItemQuantityAndPrice = updateOrderItemQuantityAndPriceMock;
        updateProductSupplierPrice = updateProductSupplierPriceMock;
        addOrderAdjustment = addOrderAdjustmentMock;
        updateOrderAdjustmentAmount = updateOrderAdjustmentAmountMock;
    },
}));

vi.mock("@/lib/db", () => ({
    createClient: () => createClientMock(),
}));

vi.mock("@/lib/purchasing/po-lifecycle", () => ({
    transitionLifecycleState: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/purchasing/vendor-freight-learning", () => ({
    recordFreightEvidence: vi.fn().mockResolvedValue(undefined),
    markVendorFreightPattern: vi.fn().mockResolvedValue(undefined),
    getVendorFreightClassification: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/finale/core-client", () => ({
    getShipmentReceiptItems: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/purchasing/pack-size-registry", () => ({
    getPackSizes: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/purchasing/three-way-match", () => ({
    evaluateThreeWayMatch: vi.fn().mockReturnValue({ canApprove: true, summary: "" }),
}));

vi.mock("@/lib/purchasing/completion-gate", () => ({
    evaluateCompletionGate: vi.fn().mockReturnValue({ ok: true, summary: "" }),
    extractInvoiceLines: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/purchasing/cache", () => ({
    invalidatePurchasingCaches: vi.fn(),
}));

const { recordFreightEvidence } = await import("@/lib/purchasing/vendor-freight-learning");
const { transitionLifecycleState } = await import("@/lib/purchasing/po-lifecycle");
const { invalidatePurchasingCaches } = await import("@/lib/purchasing/cache");
const { evaluateCompletionGate } = await import("@/lib/purchasing/completion-gate");

import { GET, POST, getDenverWeekStart } from "./route";

describe("dashboard receivings route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        createClientMock.mockReturnValue(supabaseChain);
        supabaseChain.maybeSingle.mockResolvedValue({ data: null, error: null });
        supabaseChain.single.mockResolvedValue({ data: null, error: null });
        (evaluateCompletionGate as any).mockReturnValue({ ok: true, summary: "" });
    });

    // ── GET tests ───────────────────────────────────────────────────────

    it("defaults to Denver week-to-date receipts", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings"));

        expect(response.status).toBe(200);
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-04", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            received: [],
            days: 30,
            range: "rolling_30d",
            startDate: "2026-03-04",
            asOf: "2026-04-03",
        });
    });

    it("keeps rolling-day override when days is provided", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?days=7"));

        expect(response.status).toBe(200);
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-27", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            days: 7,
            range: "rolling_days",
        });
    });

    it("computes Monday week start in Denver time", () => {
        expect(getDenverWeekStart(new Date("2026-04-03T18:00:00.000Z"))).toBe("2026-03-30");
    });

    // ── POST complete_po tests ──────────────────────────────────────────

    describe("POST complete_po", () => {
        it("completes a PO without changes (backward compat)", async () => {
            getOrderDetailsMock.mockResolvedValue({
                statusId: "ORDER_LOCKED",
                shipmentList: [],
            });
            completeOrderMock.mockResolvedValue({ finalStatus: "ORDER_COMPLETED" });

            const response = await POST(
                new Request("http://localhost/api/dashboard/receivings", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "complete_po",
                        orderId: "125100",
                        vendorName: "Surepack",
                        hadFreightOnPO: true,
                        invoiceFreight: 75,
                        freightMatched: true,
                    }),
                }),
            );

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.completed).toBe(true);
            expect(body.orderId).toBe("125100");
            expect(completeOrderMock).toHaveBeenCalledWith("125100");
            expect(recordFreightEvidence).toHaveBeenCalledWith(
                expect.objectContaining({
                    orderId: "125100",
                    vendorName: "Surepack",
                }),
            );
            expect(transitionLifecycleState).toHaveBeenCalledWith(
                "125100",
                "COMPLETED",
                "dashboard-receivings",
                expect.any(Object),
            );
            expect(invalidatePurchasingCaches).toHaveBeenCalled();
        });

        it("returns 409 when 3-way match gate blocks completion", async () => {
            getOrderDetailsMock.mockResolvedValue({
                statusId: "ORDER_LOCKED",
                shipmentList: [],
            });

            (evaluateCompletionGate as any).mockReturnValue({
                ok: false,
                blockReason: "Qty mismatch on SKU1: PO=100, Received=80, Invoice=100",
            });

            const response = await POST(
                new Request("http://localhost/api/dashboard/receivings", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "complete_po",
                        orderId: "125100",
                        vendorName: "Surepack",
                    }),
                }),
            );

            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.completed).toBe(false);
            expect(body.error).toContain("refused completion");
            expect(completeOrderMock).not.toHaveBeenCalled();
        });

        it("applies changes (priceUpdates, lineAdjustments, freight, tax, tariffs) before completing", async () => {
            getOrderDetailsMock.mockResolvedValue({
                statusId: "ORDER_LOCKED",
                shipmentList: [],
            });
            completeOrderMock.mockResolvedValue({ finalStatus: "ORDER_COMPLETED" });
            updateProductSupplierPriceMock.mockResolvedValue(true);
            updateOrderItemQuantityAndPriceMock.mockResolvedValue({
                updated: true,
                oldQuantity: 500,
                newQuantity: 600,
                oldPrice: 1.50,
                newPrice: 1.73,
                orderData: {},
                supplierPartyUrl: "/api/party/99",
            });
            updateOrderAdjustmentAmountMock.mockResolvedValue({});

            const response = await POST(
                new Request("http://localhost/api/dashboard/receivings", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "complete_po",
                        orderId: "125100",
                        vendorName: "Surepack",
                        changes: {
                            priceUpdates: { SP22146: 1.73 },
                            lineAdjustments: [
                                { productId: "SP22146", newQty: 600, newUnitPrice: 1.73 },
                            ],
                            freight: 75.0,
                            tax: 95.15,
                            tariffs: 42.0,
                        },
                    }),
                }),
            );

            expect(response.status).toBe(200);
            const jsonBody = await response.json();
            expect(jsonBody.completed).toBe(true);

            // Phase 1: changes applied
            expect(updateOrderItemQuantityAndPriceMock).toHaveBeenCalledWith(
                "125100",
                "SP22146",
                600,
                1.73,
            );
            expect(updateOrderAdjustmentAmountMock).toHaveBeenCalledWith(
                "125100",
                "FREIGHT",
                75.0,
                "Freight",
            );
            expect(updateOrderAdjustmentAmountMock).toHaveBeenCalledWith(
                "125100",
                "TAX",
                95.15,
                "Tax",
            );
            expect(updateOrderAdjustmentAmountMock).toHaveBeenCalledWith(
                "125100",
                "TARIFF",
                42.0,
                "Tariff",
            );

            // Phase 2: completion still runs
            expect(completeOrderMock).toHaveBeenCalledWith("125100");
            expect(recordFreightEvidence).toHaveBeenCalled();
            expect(transitionLifecycleState).toHaveBeenCalledWith(
                "125100",
                "COMPLETED",
                "dashboard-receivings",
                expect.any(Object),
            );
            expect(invalidatePurchasingCaches).toHaveBeenCalled();
        });

        it("continues to complete even if SKU price update fails", async () => {
            getOrderDetailsMock.mockResolvedValue({
                statusId: "ORDER_LOCKED",
                shipmentList: [],
            });
            completeOrderMock.mockResolvedValue({ finalStatus: "ORDER_COMPLETED" });
            updateProductSupplierPriceMock.mockRejectedValue(new Error("Finale 503"));
            updateOrderItemQuantityAndPriceMock.mockResolvedValue({
                updated: true,
                oldQuantity: 500,
                newQuantity: 600,
                oldPrice: 1.50,
                newPrice: 1.73,
                orderData: {},
            });
            updateOrderAdjustmentAmountMock.mockResolvedValue({});

            const response = await POST(
                new Request("http://localhost/api/dashboard/receivings", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "complete_po",
                        orderId: "125100",
                        vendorName: "Surepack",
                        changes: {
                            priceUpdates: { SP22146: 1.73 },
                            lineAdjustments: [
                                { productId: "SP22146", newQty: 600, newUnitPrice: 1.73 },
                            ],
                            freight: 75.0,
                            tax: 95.15,
                            tariffs: 42.0,
                        },
                    }),
                }),
            );

            // Should NOT fail — best effort on SKU price updates
            expect(response.status).toBe(200);
            expect(completeOrderMock).toHaveBeenCalled();
        });

        it("still completes even if changes field is omitted entirely", async () => {
            getOrderDetailsMock.mockResolvedValue({
                statusId: "ORDER_LOCKED",
                shipmentList: [],
            });
            completeOrderMock.mockResolvedValue({ finalStatus: "ORDER_COMPLETED" });

            const response = await POST(
                new Request("http://localhost/api/dashboard/receivings", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "complete_po",
                        orderId: "125100",
                        vendorName: "Surepack",
                    }),
                }),
            );

            expect(response.status).toBe(200);
            expect(completeOrderMock).toHaveBeenCalled();
            expect(updateProductSupplierPriceMock).not.toHaveBeenCalled();
            expect(updateOrderItemQuantityAndPriceMock).not.toHaveBeenCalled();
        });
    });
});