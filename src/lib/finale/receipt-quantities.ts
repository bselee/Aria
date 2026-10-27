/**
 * @file    src/lib/finale/receipt-quantities.ts
 * @purpose Load the TRUE per-SKU receipt quantity for a PO from Finale shipment
 *          details. Shared by the receivings and po-modify routes so every
 *          "Complete" action gates on real receipts, not on cache sums or the
 *          ordered quantity.
 *
 * @author  Hermia
 * @created 2026-10-27
 * @deps    src/lib/finale/client.ts, src/lib/finale/core-client.ts
 */

import { FinaleClient } from "./client";
import {
    getShipmentLineContainers,
    getShipmentLineProductId,
    getShipmentLineQuantity,
} from "./core-client";

export interface TrueReceiptQuantities {
    orderedBySku: Map<string, number>;
    receivedBySku: Map<string, number>;
}

/**
 * Fetch a PO and all of its shipments, summing received quantities per SKU.
 *
 * @purpose Complete is a financial close. It must never run on a PO whose goods
 *          have not all arrived. The dashboard GET cannot supply this: its
 *          shipment cache is often cold, and a cold read must render unknown
 *          rather than wrong. The POST path fetches every shipment live —
 *          user-initiated latency is acceptable, one PO at a time.
 *
 * @param orderId - the Finale PO number (e.g. "125408")
 * @returns per-SKU received totals against the ordered lines, or null when the
 *          PO or its shipment list cannot be read.
 */
export async function loadTrueReceiptQuantities(orderId: string): Promise<TrueReceiptQuantities | null> {
    const finale = new FinaleClient();
    const order = (await finale.getOrderDetails(orderId).catch(() => null)) as {
        shipmentUrlList?: unknown[];
        orderItemList?: Array<{ productId?: unknown; quantity?: unknown }>;
    } | null;
    if (!order || !Array.isArray(order.shipmentUrlList)) return null;

    const orderedBySku = new Map<string, number>();
    for (const line of order.orderItemList || []) {
        const productId = String(line?.productId || "").split("/").pop() || "?";
        orderedBySku.set(productId, (orderedBySku.get(productId) || 0) + Number(line?.quantity || 0));
    }

    const receivedBySku = new Map<string, number>();
    for (const url of order.shipmentUrlList) {
        const shipment = (await finale.getShipmentDetails(String(url)).catch(() => null)) as Record<string, unknown> | null;
        if (!shipment) continue;
        for (const line of getShipmentLineContainers(shipment)) {
            const productId = getShipmentLineProductId(line);
            const qty = getShipmentLineQuantity(line);
            if (productId && qty > 0) {
                receivedBySku.set(productId, (receivedBySku.get(productId) || 0) + qty);
            }
        }
    }
    return { orderedBySku, receivedBySku };
}

/**
 * Diff the receipt against the order. Returns one entry per SKU that has
 * received less than ordered.
 */
export function receiptShorts(
    receipt: TrueReceiptQuantities,
): Array<{ sku: string; ordered: number; received: number; short: number }> {
    const shorts: Array<{ sku: string; ordered: number; received: number; short: number }> = [];
    for (const [sku, ordered] of receipt.orderedBySku) {
        const received = receipt.receivedBySku.get(sku) || 0;
        if (received < ordered) shorts.push({ sku, ordered, received, short: ordered - received });
    }
    return shorts;
}
