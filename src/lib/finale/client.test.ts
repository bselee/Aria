import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FinaleClient } from "./client";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });
}

function textResponse(body: string, init: ResponseInit = {}) {
    return new Response(body, {
        status: init.status ?? 400,
        headers: { "Content-Type": "text/plain" },
        ...init,
    });
}

describe("FinaleClient tracking writeback", () => {
    const originalEnv = {
        FINALE_API_KEY: process.env.FINALE_API_KEY,
        FINALE_API_SECRET: process.env.FINALE_API_SECRET,
        FINALE_ACCOUNT_PATH: process.env.FINALE_ACCOUNT_PATH,
        FINALE_BASE_URL: process.env.FINALE_BASE_URL,
    };

    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        process.env.FINALE_API_KEY = originalEnv.FINALE_API_KEY;
        process.env.FINALE_API_SECRET = originalEnv.FINALE_API_SECRET;
        process.env.FINALE_ACCOUNT_PATH = originalEnv.FINALE_ACCOUNT_PATH;
        process.env.FINALE_BASE_URL = originalEnv.FINALE_BASE_URL;
    });

    it("skips writeback when tracking fields already match", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            orderId: "PO-100",
            statusId: "ORDER_LOCKED",
            userFieldDataList: [
                { attrName: "user_10002", attrValue: "1Z999" },
                { attrName: "user_10001", attrValue: "https://track.example/1Z999" },
            ],
        }) as any);

        const client = new FinaleClient();
        const changed = await client.updatePurchaseOrderTracking(
            "PO-100",
            "1Z999",
            "https://track.example/1Z999",
        );

        expect(changed).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("restores completed or locked orders back to committed after tracking edits", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-200",
                statusId: "ORDER_COMPLETED",
                actionUrlEdit: "/buildasoil/api/order/PO-200/edit",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-200",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-200",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any);

        const client = new FinaleClient();
        const changed = await client.updatePurchaseOrderTracking(
            "PO-200",
            "1Z200",
            "https://track.example/1Z200",
        );

        expect(changed).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(6);

        const restoreCall = vi.mocked(global.fetch).mock.calls[5];
        expect(String(restoreCall[0])).toContain("/buildasoil/api/order/PO-200");
        expect(JSON.parse(String((restoreCall[1] as RequestInit).body))).toMatchObject({
            statusId: "ORDER_LOCKED",
        });
    });

    it("restores the order even when the tracking write fails after unlock", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-300",
                statusId: "ORDER_LOCKED",
                actionUrlEdit: "/buildasoil/api/order/PO-300/edit",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-300",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(textResponse("bad write", { status: 400, statusText: "Bad Request" }) as any)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-300",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const client = new FinaleClient();
        const changed = await client.updatePurchaseOrderTracking(
            "PO-300",
            "1Z300",
            "https://track.example/1Z300",
        );

        expect(changed).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(6);

        const restoreCall = vi.mocked(global.fetch).mock.calls[5];
        expect(JSON.parse(String((restoreCall[1] as RequestInit).body))).toMatchObject({
            statusId: "ORDER_LOCKED",
        });
        expect(warnSpy).toHaveBeenCalled();
    });

    it("leaves draft orders in draft after tracking edits", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-400",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true }) as any)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "PO-400",
                statusId: "ORDER_CREATED",
                userFieldDataList: [],
            }) as any);

        const client = new FinaleClient();
        const changed = await client.updatePurchaseOrderTracking(
            "PO-400",
            "1Z400",
            "https://track.example/1Z400",
        );

        expect(changed).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });
});

describe("FinaleClient receivings pagination", () => {
    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    it("keeps paging orderViewConnection until delayed receipts are found", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                data: {
                    orderViewConnection: {
                        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                        edges: [],
                    },
                },
            }) as any)
            .mockResolvedValueOnce(jsonResponse({
                data: {
                    orderViewConnection: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        edges: [{
                            node: {
                                orderId: "PO-500",
                                orderUrl: "/buildasoil/api/order/PO-500",
                                status: "Completed",
                                orderDate: "2025-08-01",
                                receiveDate: "2026-03-15",
                                shipmentList: [
                                    { shipmentId: "sh-500", status: "received", receiveDate: "2026-04-02T10:15:00-06:00" },
                                ],
                                total: "25",
                                supplier: { name: "Paged Vendor" },
                                itemList: { edges: [{ node: { product: { productId: "SKU-500" }, quantity: "2" } }] },
                            },
                        }],
                    },
                },
            }) as any)
            .mockResolvedValueOnce(jsonResponse({
                shipmentUrlList: ["/buildasoil/api/shipment/sh-500"],
            }) as any)
            .mockResolvedValueOnce(jsonResponse({
                shipmentId: "sh-500",
                receiveDate: "2026-04-02T10:15:00-06:00",
                lastUpdatedDate: "2026-04-02T15:06:46Z",
                statusIdHistoryList: [
                    { statusId: "SHIPMENT_DELIVERED", txStamp: 1775142406 },
                ],
            }) as any);

        const client = new FinaleClient();
        const received = await client.getTodaysReceivedPOs("2026-04-01", "2026-04-03");

        expect(received).toHaveLength(1);
        expect(received[0]?.orderId).toBe("PO-500");

        const graphqlBodies = vi.mocked(global.fetch).mock.calls
            .slice(0, 2)
            .map((call) => JSON.parse(String((call[1] as RequestInit).body)).query);

        expect(graphqlBodies[0]).not.toContain('after: "cursor-1"');
        expect(graphqlBodies[1]).toContain('after: "cursor-1"');
    });
});

describe("FinaleClient PO write gating", () => {
    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    it("denies draft PO creation without an allowed write context", async () => {
        const client = new FinaleClient();

        await expect(client.createDraftPurchaseOrder(
            "vendor-1",
            [{ productId: "SKU-1", quantity: 5, unitPrice: 2.5 }],
        )).rejects.toThrow(/Finale write denied/);

        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("allows draft PO creation when the dashboard write context is provided", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            orderId: "PO-900",
            orderUrl: "/buildasoil/api/order/PO-900",
            orderItemList: [
                { productUrl: "/buildasoil/api/product/SKU-1" },
            ],
        }) as any);

        const client = new FinaleClient();
        vi.spyOn(client, "checkDuplicatePOs").mockResolvedValue([]);
        vi.spyOn(client, "checkPriceChange").mockResolvedValue(null);
        vi.spyOn(client, "validateProductExists").mockResolvedValue(true);
        vi.spyOn(client, "getFacilityUrl").mockResolvedValue("/buildasoil/api/facility/shipping");

        const result = await client.createDraftPurchaseOrder(
            "vendor-1",
            [{ productId: "SKU-1", quantity: 5, unitPrice: 2.5 }],
            undefined,
            undefined,
            { source: "dashboard", action: "create_draft_po" },
        );

        expect(result.orderId).toBe("PO-900");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("denies draft PO commit without an allowed write context", async () => {
        const client = new FinaleClient();

        await expect(client.commitDraftPO("PO-1001")).rejects.toThrow(/Finale write denied/);

        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("denies draft PO commit when telegram context is provided", async () => {
        const client = new FinaleClient();

        await expect(client.commitDraftPO("PO-1001", {
            source: "telegram",
            action: "commit_draft_po",
        })).rejects.toThrow(/Finale write denied/);

        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("allows draft PO commit when the dashboard write context is provided", async () => {
        const client = new FinaleClient();
        vi.spyOn(client, "getOrderDetails").mockResolvedValue({
            orderId: "PO-1001",
            statusId: "ORDER_CREATED",
            actionUrlComplete: "/buildasoil/api/order/PO-1001/complete",
        } as any);
        const postSpy = vi.spyOn(client as any, "post").mockResolvedValue({
            statusId: "ORDER_LOCKED",
        });

        const result = await client.commitDraftPO("PO-1001", {
            source: "dashboard",
            action: "commit_draft_po",
        });

        expect(result).toEqual({
            orderId: "PO-1001",
            committed: true,
            finalStatus: "ORDER_LOCKED",
        });
        expect(postSpy).toHaveBeenCalledWith(
            "/buildasoil/api/order/PO-1001/complete",
            {},
        );
    });
});
