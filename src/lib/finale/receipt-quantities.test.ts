/**
 * @file    src/lib/finale/receipt-quantities.test.ts
 * @purpose Pin the canceled-shipment-leg rule on the Complete gate: a canceled
 *          leg carries committed line quantities but no goods arrived, so its
 *          quantities must never inflate receivedBySku (125394-1 case,
 *          2026-10-29). accumulateShipmentReceipts is the single sum point.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    src/lib/finale/receipt-quantities.ts, src/lib/finale/shipment-status.ts
 */
import { describe, expect, it } from "vitest";

import {
    accumulateShipmentReceipts,
    receiptShorts,
    type TrueReceiptQuantities,
} from "./receipt-quantities";

function restLeg(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        shipmentId: "626292",
        statusId: "SHIPMENT_DELIVERED",
        receiveDate: "2026-10-29T18:00:00",
        itemList: [{ productId: "TEC101", quantity: 12 }],
        ...overrides,
    };
}

describe("accumulateShipmentReceipts", () => {
    it("sums a delivered leg's line quantities", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(received, restLeg({}));
        expect(received.get("TEC101")).toBe(12);
    });

    it("ignores a REST-canceled leg (statusId SHIPMENT_CANCELLED) even with quantities", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(
            received,
            restLeg({ statusId: "SHIPMENT_CANCELLED", cancelDate: "2026-10-28T09:00:00" }),
        );
        expect(received.size).toBe(0);
    });

    it("ignores a GraphQL-canceled leg (status Canceled)", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(received, {
            shipmentId: "125394-1",
            status: "Canceled",
            receiveDate: null,
            itemList: [{ productId: "TEC101", quantity: 12 }],
        });
        expect(received.size).toBe(0);
    });

    it("ignores a leg canceled only in its status history (no top-level status)", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(received, {
            shipmentId: "622959",
            itemList: [{ productId: "TEC101", quantity: 12 }],
            statusIdHistoryList: [
                { statusId: "SHIPMENT_CREATED", txStamp: 1000 },
                { statusId: "SHIPMENT_CANCELLED", txStamp: 2000 },
            ],
        });
        expect(received.size).toBe(0);
    });

    it("keeps summing a later delivered leg after skipping a canceled one", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(
            received,
            restLeg({ shipmentId: "622959", statusId: "SHIPMENT_CANCELLED" }),
        );
        accumulateShipmentReceipts(received, restLeg({ shipmentId: "626292" }));
        expect(received.get("TEC101")).toBe(12);
    });

    it("treats null and undefined legs as zero", () => {
        const received = new Map<string, number>();
        accumulateShipmentReceipts(received, null);
        accumulateShipmentReceipts(received, undefined);
        expect(received.size).toBe(0);
    });
});

describe("receiptShorts with a canceled leg in the population", () => {
    it("reports the true short when only the received leg's quantities count", () => {
        const receipt: TrueReceiptQuantities = {
            orderedBySku: new Map([["TEC101", 12]]),
            receivedBySku: new Map([["TEC101", 12]]),
            total: 216,
            subtotal: 216,
            orderItemCount: 1,
            orderAdjustmentList: [],
        };
        expect(receiptShorts(receipt)).toEqual([]);
    });

    it("still reports short when the delivered leg under-delivers and a canceled leg is excluded", () => {
        const receipt: TrueReceiptQuantities = {
            orderedBySku: new Map([["TEC101", 12]]),
            receivedBySku: new Map([["TEC101", 8]]),
            total: 216,
            subtotal: 216,
            orderItemCount: 1,
            orderAdjustmentList: [],
        };
        expect(receiptShorts(receipt)).toEqual([
            { sku: "TEC101", ordered: 12, received: 8, short: 4 },
        ]);
    });
});
