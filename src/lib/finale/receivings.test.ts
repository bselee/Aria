import { describe, expect, it } from "vitest";

import {
    deriveReceivedPurchaseOrders,
    enrichReceivedPurchaseOrdersWithShipmentDetails,
    getReceiptQueryStartDate,
    getShipmentReceiverName,
    getShipmentReceiptDateTime,
    getReceiptStatusFromPoStatus,
} from "./client";
import { finaleDateOnly } from "./core-client";

describe("finaleDateOnly", () => {
    it("keeps the written calendar date on a naive local timestamp", () => {
        // Regression: 125394's shipment receiveDate 2026-10-29T18:00:00 shifted
        // to 2026-10-30 through toISOString, so a same-day receipt read as
        // future and the Active panel said "need receive".
        expect(finaleDateOnly("2026-10-29T18:00:00")).toBe("2026-10-29");
    });

    it("normalizes US-style dates", () => {
        expect(finaleDateOnly("4/2/2026")).toBe("2026-04-02");
        expect(finaleDateOnly("10/19/2026")).toBe("2026-10-19");
    });

    it("passes through plain ISO dates and rejects junk", () => {
        expect(finaleDateOnly("2026-10-29")).toBe("2026-10-29");
        expect(finaleDateOnly("")).toBeNull();
        expect(finaleDateOnly(null)).toBeNull();
    });
});

describe("receivings helpers", () => {
    it("widens the query window beyond the visible receipt window", () => {
        expect(getReceiptQueryStartDate("2026-04-01")).toBe("2025-04-01");
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
        expect(getReceiptStatusFromPoStatus("Locked")).toBe("received");
        expect(getReceiptStatusFromPoStatus("ORDER_LOCKED")).toBe("received");
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

    it("extracts receiver identity from shipment detail when available", () => {
        expect(getShipmentReceiverName({
            receivedByName: "Luis",
        })).toBe("Luis");

        expect(getShipmentReceiverName({
            statusIdHistoryList: [
                { statusId: "SHIPMENT_DELIVERED", userName: "Emma" },
            ],
        })).toBe("Emma");
    });

    it("enriches received purchase orders with exact shipment timestamps", () => {
        const enriched = enrichReceivedPurchaseOrdersWithShipmentDetails([
            {
                orderId: "23372817A-DropshipPO",
                orderDate: "2026-04-01",
                receiveDate: "2026-04-01T18:00:00",
                receiveDateTime: "2026-04-01T18:00:00",
                receivedBy: null,
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
                    receivedByName: "Warehouse A",
                    statusIdHistoryList: [
                        { statusId: null, txStamp: 1775056004 },
                        { statusId: "SHIPMENT_DELIVERED", txStamp: 1775056006 },
                    ],
                },
            ],
        }, [], {});

        expect(enriched[0]).toMatchObject({
            orderId: "23372817A-DropshipPO",
            receiveDateTime: "2026-04-01T15:06:46.000Z",
            receivedBy: "Warehouse A",
        });
    });

    it("enriches partial receipts with per-shipment received quantities and open balance", () => {
        const enriched = enrichReceivedPurchaseOrdersWithShipmentDetails([
            {
                orderId: "PO-PARTIAL",
                orderDate: "2026-05-01",
                receiveDate: "2026-05-06",
                receiveDateTime: "2026-05-06",
                receivedBy: null,
                receiptStatus: "partial",
                supplier: "Bottle Vendor",
                total: 900,
                items: [{ productId: "BOTTLE-1G", quantity: 300 }],
                finaleUrl: "https://example.test/finale-order",
            },
        ], {
            "PO-PARTIAL": [
                {
                    shipmentId: "rcv-1",
                    receiveDate: "2026-05-06T09:00:00-06:00",
                    receivedByName: "Luis",
                    itemList: [
                        { productId: "BOTTLE-1G", quantityReceived: "150" },
                    ],
                },
                {
                    shipmentId: "rcv-2",
                    receiveDate: "2026-05-07T11:00:00-06:00",
                    receivedByName: "Mia",
                    itemList: [
                        { productId: "BOTTLE-1G", quantityReceived: "75" },
                    ],
                },
            ],
        }, ["rcv-1", "rcv-2"], { "PO-PARTIAL": ["rcv-1", "rcv-2"] });

        expect(enriched[0]?.receiptHistory).toEqual([
            {
                shipmentId: "rcv-1",
                receiveDate: "2026-05-06",
                receiveDateTime: "2026-05-06T15:00:00.000Z",
                receivedBy: "Luis",
                items: [{ productId: "BOTTLE-1G", quantity: 150 }],
            },
            {
                shipmentId: "rcv-2",
                receiveDate: "2026-05-07",
                receiveDateTime: "2026-05-07T17:00:00.000Z",
                receivedBy: "Mia",
                items: [{ productId: "BOTTLE-1G", quantity: 75 }],
            },
        ]);
        expect(enriched[0]?.items).toEqual([
            {
                productId: "BOTTLE-1G",
                quantity: 300,
                orderedQuantity: 300,
                receivedQuantity: 225,
                receivedInWindow: 225,
                openQuantity: 75,
            },
        ]);
    });

    it("leaves received quantities unknown when any shipment is not warm", () => {
        // Only rcv-1 is in the warm set; rcv-2 is expected but missing.
        // The sum over the warm subset (150) must NOT be painted as a receipt.
        const enriched = enrichReceivedPurchaseOrdersWithShipmentDetails([
            {
                orderId: "PO-PARTIAL",
                orderDate: "2026-05-01",
                receiveDate: "2026-05-06",
                receiveDateTime: "2026-05-06",
                receivedBy: null,
                receiptStatus: "partial",
                supplier: "Bottle Vendor",
                total: 900,
                items: [{ productId: "BOTTLE-1G", quantity: 300 }],
                finaleUrl: "https://example.test/finale-order",
            },
        ], {
            "PO-PARTIAL": [
                {
                    shipmentId: "rcv-1",
                    receiveDate: "2026-05-06T09:00:00-06:00",
                    receivedByName: "Luis",
                    itemList: [{ productId: "BOTTLE-1G", quantityReceived: "150" }],
                },
            ],
        }, ["rcv-1"], { "PO-PARTIAL": ["rcv-1", "rcv-2"] });

        expect(enriched[0]?.items).toEqual([
            { productId: "BOTTLE-1G", quantity: 300, orderedQuantity: 300 },
        ]);
    });

    it("resolves the receiver from the DELIVERED event userLoginUrl", () => {
        expect(getShipmentReceiverName({
            statusIdHistoryList: [
                { statusId: null, txStamp: 1792184734, userLoginUrl: "/buildasoilorganics/api/userlogin/nicholas.kubin" },
                { statusId: "SHIPMENT_DELIVERED", txStamp: 1792184736, userLoginUrl: "/buildasoilorganics/api/userlogin/nicholas.kubin" },
            ],
        })).toBe("NK");
    });
});
