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

describe("FinaleClient draft PO creation guardrails", () => {
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

    it("reuses an active draft instead of creating a new vendor PO", async () => {
        const client = new FinaleClient();
        vi.spyOn(client, "findActiveDraftPOsForVendor").mockResolvedValue([
            {
                orderId: "124500",
                status: "Draft",
                orderDate: "2026-04-03",
                finaleUrl: "https://finale.example/po/124500",
            },
        ]);
        vi.spyOn(client as any, "validateProductExists").mockResolvedValue(true);
        vi.spyOn(client as any, "getOrderDetails").mockResolvedValue({
            orderId: "124500",
            orderUrl: "/buildasoil/api/order/124500",
            statusId: "ORDER_CREATED",
            orderItemList: [],
        });
        const postSpy = vi.spyOn(client as any, "post").mockResolvedValue({});

        const result = await client.createDraftPurchaseOrder(
            "party-uline",
            [{ productId: "FJG102", quantity: 240, unitPrice: 1.25 }],
            "memo",
        );

        expect(result.orderId).toBe("124500");
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("reuses the current vendor draft instead of creating another PO", async () => {
        const client = new FinaleClient();
        vi.spyOn(client, "findActiveDraftPOsForVendor").mockResolvedValue([
            {
                orderId: "124500",
                status: "Draft",
                orderDate: "2026-04-03",
                finaleUrl: "https://finale.example/po/124500",
            },
        ]);
        vi.spyOn(client as any, "validateProductExists").mockResolvedValue(true);
        vi.spyOn(client as any, "checkPriceChange").mockResolvedValue(null);
        vi.spyOn(client as any, "getOrderDetails").mockResolvedValue({
            orderId: "124500",
            orderUrl: "/buildasoil/api/order/124500",
            statusId: "ORDER_CREATED",
            orderItemList: [
                {
                    productId: "EXISTING-1",
                    productUrl: "/buildasoil/api/product/EXISTING-1",
                    quantity: 5,
                    unitPrice: 3,
                },
                {
                    productId: "FJG102",
                    productUrl: "/buildasoil/api/product/FJG102",
                    quantity: 120,
                    unitPrice: 1.25,
                },
            ],
        });
        const postSpy = vi.spyOn(client as any, "post").mockResolvedValue({});

        const result = await client.createDraftPurchaseOrder(
            "party-uline",
            [
                { productId: "FJG102", quantity: 240, unitPrice: 1.25 },
                { productId: "NEW-1", quantity: 4, unitPrice: 2.5 },
            ],
            "memo",
        );

        expect(result.orderId).toBe("124500");
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(postSpy).toHaveBeenCalledWith(
            "/buildasoil/api/order/124500",
            expect.objectContaining({
                orderItemList: expect.arrayContaining([
                    expect.objectContaining({
                        productId: "EXISTING-1",
                        quantity: 5,
                        unitPrice: 3,
                    }),
                    expect.objectContaining({
                        productId: "FJG102",
                        quantity: 240,
                        unitPrice: 1.25,
                    }),
                    expect.objectContaining({
                        productUrl: "/buildasoil/api/product/NEW-1",
                        quantity: 4,
                        unitPrice: 2.5,
                    }),
                ]),
            }),
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe("FinaleClient native PO email", () => {
    const originalEnv = {
        FINALE_API_KEY: process.env.FINALE_API_KEY,
        FINALE_API_SECRET: process.env.FINALE_API_SECRET,
        FINALE_ACCOUNT_PATH: process.env.FINALE_ACCOUNT_PATH,
        FINALE_BASE_URL: process.env.FINALE_BASE_URL,
        FINALE_PO_EMAIL_ACTION_TEMPLATE: process.env.FINALE_PO_EMAIL_ACTION_TEMPLATE,
    };

    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        delete process.env.FINALE_PO_EMAIL_ACTION_TEMPLATE;
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        process.env.FINALE_API_KEY = originalEnv.FINALE_API_KEY;
        process.env.FINALE_API_SECRET = originalEnv.FINALE_API_SECRET;
        process.env.FINALE_ACCOUNT_PATH = originalEnv.FINALE_ACCOUNT_PATH;
        process.env.FINALE_BASE_URL = originalEnv.FINALE_BASE_URL;
        process.env.FINALE_PO_EMAIL_ACTION_TEMPLATE = originalEnv.FINALE_PO_EMAIL_ACTION_TEMPLATE;
    });

    it("posts to a Finale PO email action URL when available", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "124790",
                statusId: "ORDER_LOCKED",
                actionUrlEmailPurchaseOrder: "/buildasoil/api/order/124790/action/emailPurchaseOrder",
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "finale-email-1" }) as any);

        const client = new FinaleClient();
        const result = await client.sendPurchaseOrderEmail("124790", {
            toEmail: "vendor@example.com",
            subject: "BuildASoil PO # 124790 - Clarke - 5/1/2026",
            body: "Please see our attached PO.",
        });

        expect(result).toMatchObject({
            orderId: "124790",
            sent: true,
            pdfAttached: true,
            actionUrl: "/buildasoil/api/order/124790/action/emailPurchaseOrder",
        });

        const sendCall = vi.mocked(global.fetch).mock.calls[1];
        expect(String(sendCall[0])).toBe("https://finale.example/buildasoil/api/order/124790/action/emailPurchaseOrder");
        expect(JSON.parse(String((sendCall[1] as RequestInit).body))).toMatchObject({
            toEmail: "vendor@example.com",
            to: "vendor@example.com",
            subject: "BuildASoil PO # 124790 - Clarke - 5/1/2026",
            body: "Please see our attached PO.",
        });
    });

    it("does not mistake a generic edit action for the native PO email action", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "124790",
                statusId: "ORDER_LOCKED",
                actionUrlEdit: "/buildasoil/api/order/124790/edit",
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "finale-email-1" }) as any);

        const client = new FinaleClient();
        await client.sendPurchaseOrderEmail("124790", {
            toEmail: "vendor@example.com",
            subject: "BuildASoil PO # 124790 - Clarke - 5/1/2026",
            body: "Please see our attached PO.",
        });

        expect(String(vi.mocked(global.fetch).mock.calls[1][0]))
            .toBe("https://finale.example/buildasoil/api/order/124790/action/emailPurchaseOrder");
    });

    it("uses Finale's default emailPurchaseOrder action when the order payload omits action URLs", async () => {
        vi.mocked(global.fetch)
            .mockResolvedValueOnce(jsonResponse({
                orderId: "124790",
                statusId: "ORDER_LOCKED",
            }) as any)
            .mockResolvedValueOnce(jsonResponse({ ok: true, messageId: "finale-email-1" }) as any);

        const client = new FinaleClient();
        await client.sendPurchaseOrderEmail("124790", {
            toEmail: "vendor@example.com",
            subject: "BuildASoil PO # 124790 - Clarke - 5/1/2026",
            body: "Please see our attached PO.",
        });

        expect(String(vi.mocked(global.fetch).mock.calls[1][0]))
            .toBe("https://finale.example/buildasoil/api/order/124790/action/emailPurchaseOrder");
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

describe("FinaleClient product activity stock parsing", () => {
    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    it("prefers GraphQL stockOnHand when unitsInStock reports zero", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            data: {
                purchasedIn: { edges: [] },
                soldIn: { edges: [] },
                committedPOs: { edges: [] },
                stockInfo: {
                    edges: [{
                        node: {
                            stockOnHand: "300",
                            stockAvailable: "275",
                            unitsInStock: "0",
                        },
                    }],
                },
            },
        }) as any);

        const client = new FinaleClient();
        const activity = await client.getProductActivity("BOTTLE-1G", 90);

        expect(activity.stockOnHand).toBe(300);
        expect(activity.stockAvailable).toBe(275);
    });
});

describe("findCommittedPOsForProduct quantityOnOrder", () => {
    beforeEach(() => {
        process.env.FINALE_API_KEY = "key";
        process.env.FINALE_API_SECRET = "secret";
        process.env.FINALE_ACCOUNT_PATH = "buildasoil";
        process.env.FINALE_BASE_URL = "https://finale.example";
        vi.restoreAllMocks();
        global.fetch = vi.fn();
    });

    // Finale's `shipment` GraphQL type has no per-line quantity field. POs with
    // every line received transition to status='Completed' and are dropped by
    // the Committed/Locked status filter — so we report quantityOnOrder at the
    // original ordered qty for any still-Committed PO.

    it("reports original qty for committed POs regardless of shipment activity", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            data: {
                orderViewConnection: {
                    edges: [{
                        node: {
                            orderId: "PO-PARTIAL",
                            status: "Committed",
                            orderDate: "2026-01-15",
                            total: "500",
                            supplier: { name: "Test Vendor" },
                            itemList: { edges: [{ node: { product: { productId: "SKU-001" }, quantity: "100" } }] },
                            shipmentList: [
                                { shipmentId: "sh-1", receiveDate: "2026-02-01T10:00:00Z" },
                            ],
                        },
                    }],
                },
            },
        }) as any);

        const client = new FinaleClient();
        const pos = await client.findCommittedPOsForProduct("SKU-001");

        expect(pos).toHaveLength(1);
        expect(pos[0]?.orderId).toBe("PO-PARTIAL");
        expect(pos[0]?.quantityOnOrder).toBe(100);
    });

    it("filters out POs whose status is not Committed or Locked", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            data: {
                orderViewConnection: {
                    edges: [{
                        node: {
                            orderId: "PO-DONE",
                            status: "Completed",
                            orderDate: "2026-01-15",
                            total: "500",
                            supplier: { name: "Test Vendor" },
                            itemList: { edges: [{ node: { product: { productId: "SKU-001" }, quantity: "100" } }] },
                            shipmentList: [{ shipmentId: "sh-1", receiveDate: "2026-02-01T10:00:00Z" }],
                        },
                    }],
                },
            },
        }) as any);

        const client = new FinaleClient();
        const pos = await client.findCommittedPOsForProduct("SKU-001");

        expect(pos).toHaveLength(0);
    });

    it("returns no rows when the matching item has zero ordered qty", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
            data: {
                orderViewConnection: {
                    edges: [{
                        node: {
                            orderId: "PO-ZERO",
                            status: "Committed",
                            orderDate: "2026-01-15",
                            total: "0",
                            supplier: { name: "Test Vendor" },
                            itemList: { edges: [{ node: { product: { productId: "SKU-001" }, quantity: "0" } }] },
                            shipmentList: [],
                        },
                    }],
                },
            },
        }) as any);

        const client = new FinaleClient();
        const pos = await client.findCommittedPOsForProduct("SKU-001");

        expect(pos).toHaveLength(0);
    });
});
