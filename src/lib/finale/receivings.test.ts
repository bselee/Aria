import { describe, expect, it } from "vitest";

import {
    deriveReceivedPurchaseOrders,
    enrichReceivedPurchaseOrdersWithShipmentDetails,
    getReceiptQueryStartDate,
    getShipmentReceiptDateTime,
    getReceiptStatusFromPoStatus,
} from "./client";

describe("receivings helpers", () => {
    it("widens the query window beyond the visible receipt window", () => {
        expect(getReceiptQueryStartDate("2026-04-01")).toBe("2025-10-03");
    });

    it("excludes ghost receivings with only expected PO receive dates", () => {
        const received = deriveReceivedPurchaseOrders([
            {
                node: {
                    orderId: "12450",
                    orderUrl: "/buildasoil/api/order/12450",
                    status: "Committed",
                    orderDate: "2026-03-01",
                    receiveDate: "2026-04-03",
                    shipmentList: [],
                    total: "10",
                    supplier: { name: "Ghost Vendor" },
                    itemList: { edges: [{ node: { product: { productId: "SKU-1" }, quantity: "5" } }] },
                },
            },
        ], "2026-04-01", "2026-04-03", "buildasoil");

        expect(received).toEqual([]);
    });

    it("includes real receipts when shipment dates fall inside the requested window even if PO receiveDate does not", () => {
        const received = deriveReceivedPurchaseOrders([
            {
                node: {
                    orderId: "12451",
                    orderUrl: "/buildasoil/api/order/12451",
                    status: "Completed",
                    orderDate: "2026-01-15",
                    receiveDate: "2026-03-20",
                    shipmentList: [
                        { shipmentId: "sh-1", status: "received", receiveDate: "2026-04-02T10:15:00-06:00" },
                    ],
                    total: "25",
                    supplier: { name: "Real Vendor" },
                    itemList: { edges: [{ node: { product: { productId: "SKU-2" }, quantity: "2" } }] },
                },
            },
        ], "2026-04-01", "2026-04-03", "buildasoil");

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            orderId: "12451",
            receiptStatus: "full",
            receiveDateTime: "2026-04-02T10:15:00-06:00",
        });
    });

    it("excludes dropship purchase orders from warehouse receivings", () => {
        const received = deriveReceivedPurchaseOrders([
            {
                node: {
                    orderId: "23372817A-DropshipPO",
                    orderUrl: "/buildasoil/api/order/23372817A-DropshipPO",
                    status: "Completed",
                    orderDate: "2026-03-31",
                    receiveDate: "2026-04-01",
                    shipmentList: [
                        { shipmentId: "sh-1", status: "received", receiveDate: "2026-04-01T10:15:00-06:00" },
                    ],
                    total: "25",
                    supplier: { name: "Printful" },
                    itemList: { edges: [{ node: { product: { productId: "SKU-2" }, quantity: "2" } }] },
                },
            },
        ], "2026-04-01", "2026-04-03", "buildasoil");

        expect(received).toEqual([]);
    });

    it("marks open received purchase orders as partial", () => {
        expect(getReceiptStatusFromPoStatus("Committed")).toBe("partial");
        expect(getReceiptStatusFromPoStatus("Locked")).toBe("partial");
        expect(getReceiptStatusFromPoStatus("Completed")).toBe("full");
        expect(getReceiptStatusFromPoStatus("Closed")).toBe("full");
    });

    it("extracts exact receipt timestamp from shipment status history", () => {
        expect(
            getShipmentReceiptDateTime({
                receiveDate: "2026-04-01T18:00:00",
                lastUpdatedDate: "2026-04-01T15:06:46",
                statusIdHistoryList: [
                    { statusId: null, txStamp: 1775056004 },
                    { statusId: "SHIPMENT_DELIVERED", txStamp: 1775056006 },
                ],
            }),
        ).toBe("2026-04-01T15:06:46.000Z");
    });

    it("enriches received purchase orders with exact shipment timestamps", () => {
        const enriched = enrichReceivedPurchaseOrdersWithShipmentDetails([
            {
                orderId: "23372817A-DropshipPO",
                orderDate: "2026-04-01",
                receiveDate: "2026-04-01T18:00:00",
                receiveDateTime: "2026-04-01T18:00:00",
                receiptStatus: "full",
                supplier: "Printful",
                total: 47,
                items: [{ productId: "S-21592", quantity: 4 }],
                finaleUrl: "https://example.test/finale-order",
            },
        ], {
            "23372817A-DropshipPO": [
                {
                    shipmentId: "585408",
                    receiveDate: "2026-04-01T18:00:00",
                    lastUpdatedDate: "2026-04-01T15:06:46",
                    statusIdHistoryList: [
                        { statusId: null, txStamp: 1775056004 },
                        { statusId: "SHIPMENT_DELIVERED", txStamp: 1775056006 },
                    ],
                },
            ],
        });

        expect(enriched[0]).toMatchObject({
            orderId: "23372817A-DropshipPO",
            receiveDateTime: "2026-04-01T15:06:46.000Z",
        });
    });
});
