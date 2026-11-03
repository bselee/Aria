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
import { isCanceledShipmentLeg } from "./shipment-status";

export interface TrueReceiptQuantities {
    orderedBySku: Map<string, number>;
    receivedBySku: Map<string, number>;
    /** PO totals straight from the order doc: freight already on the PO is
     *  total − subtotal (Finale carries no freight line until applied). */
    total: number;
    subtotal: number;
    /** Raw item count — allocation lists must match it to reach landed cost. */
    orderItemCount: number;
    /** Raw adjustments, for the freight-line hygiene gate (2026-10-28). */
    orderAdjustmentList: Array<Record<string, unknown>>;
}

/**
 * Add one shipment leg's line quantities into a per-SKU receipt map.
 *
 * @purpose Canceled legs carry quantities (the lines were committed before the
 *          leg was canceled) but no goods arrived — summing them let a short PO
 *          pass the Complete gate (125394-1 Canceled counted toward 125394).
 *          Null/unreadable legs contribute nothing.
 */
export function accumulateShipmentReceipts(
    receivedBySku: Map<string, number>,
    shipment: Record<string, unknown> | null | undefined,
): void {
    if (!shipment || isCanceledShipmentLeg(shipment)) return;
    for (const line of getShipmentLineContainers(shipment)) {
        const productId = getShipmentLineProductId(line);
        const qty = getShipmentLineQuantity(line);
        if (productId && qty > 0) {
            receivedBySku.set(productId, (receivedBySku.get(productId) || 0) + qty);
        }
    }
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
        total?: unknown;
        subtotal?: unknown;
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
        accumulateShipmentReceipts(receivedBySku, shipment);
    }
    return {
        orderedBySku,
        receivedBySku,
        total: Number(order.total || 0),
        subtotal: Number(order.subtotal || 0),
        orderItemCount: (order as { orderItemList?: unknown[] }).orderItemList?.length ?? 0,
        orderAdjustmentList: ((order as { orderAdjustmentList?: unknown }).orderAdjustmentList as Array<Record<string, unknown>>) ?? [],
    };
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

// ──────────────────────────────────────────────────────────────────────────
// RECEIPT DELTA — the shared primitive (2026-10-29)
// ──────────────────────────────────────────────────────────────────────────

/**
 * How one SKU's receipt compares to what was ordered.
 *
 * - `short`  — received < ordered. The only class that drives action: goods were
 *              bought and never arrived, the PO cannot close, and the inbound
 *              quantity must STOP counting as cover on Ordering.
 * - `exact`  — received === ordered. Done.
 * - `over`   — received > ordered. Informational only (Bill 2026-10-29: "over
 *              receipts are not a big issue here... we are not losing money").
 *              Rendered as a number on the line; never a queue, never an alert.
 */
export type ReceiptDeltaClass = "short" | "exact" | "over";

export interface ReceiptDeltaLine {
    sku: string;
    ordered: number;
    received: number;
    /** received − ordered. Negative means short by that many units. */
    delta: number;
    cls: ReceiptDeltaClass;
}

/**
 * Classify every ordered SKU by its receipt delta.
 *
 * Ordered SKUs with no shipment lines at all are reported as full shorts
 * (received 0) rather than skipped — silence is not delivery.
 *
 * @param receipt True receipt quantities for one PO.
 * @returns       One entry per ordered SKU, in ordered order.
 */
export function receiptDeltas(receipt: TrueReceiptQuantities): ReceiptDeltaLine[] {
    const lines: ReceiptDeltaLine[] = [];
    for (const [sku, ordered] of receipt.orderedBySku) {
        const received = receipt.receivedBySku.get(sku) || 0;
        const delta = received - ordered;
        lines.push({
            sku,
            ordered,
            received,
            delta,
            cls: delta < 0 ? "short" : delta > 0 ? "over" : "exact",
        });
    }
    return lines;
}

/**
 * The actionable subset of {@link receiptDeltas}: shorts only.
 *
 * @param receipt True receipt quantities for one PO.
 */
export function receiptDeltaShorts(
    receipt: TrueReceiptQuantities,
): Array<ReceiptDeltaLine & { cls: "short" }> {
    return receiptDeltas(receipt).filter(
        (l): l is ReceiptDeltaLine & { cls: "short" } => l.cls === "short",
    );
}

/**
 * PO-level receipt verdict, derived from the deltas — NOT from Finale's status.
 *
 * The status field is a clerical consequence of receipts and drifts (125080 was
 * received in July and still reads `open`). This answers the operational
 * question directly: are all the goods here, are some still coming, or are some
 * never coming?
 *
 * - `complete`    — every ordered SKU received ≥ ordered.
 * - `partial`     — something arrived, and short units remain.
 * - `not_received`— nothing arrived at all.
 * - `unknown`     — no readable ordered lines.
 */
export type PoReceiptVerdict = "complete" | "partial" | "not_received" | "unknown";

export interface PoReceiptState {
    verdict: PoReceiptVerdict;
    lines: ReceiptDeltaLine[];
    /** Units still owed on short lines (sum of |delta| where short). */
    shortUnits: number;
    /** SKUs still owed, e.g. ["RWBP102 ×30"]. Empty when complete. */
    shortSkus: string[];
    /** Units received beyond ordered across all lines — informational. */
    overUnits: number;
    /** True when nothing has arrived on a PO that ordered something. */
    nothingReceived: boolean;
}

/**
 * Build the PO receipt state from true quantities.
 *
 * @param receipt True receipt quantities for one PO, or null when unreadable.
 * @returns       Verdict plus the per-line deltas behind it.
 */
export function buildPoReceiptState(receipt: TrueReceiptQuantities | null): PoReceiptState {
    if (!receipt || receipt.orderedBySku.size === 0) {
        return {
            verdict: "unknown",
            lines: [],
            shortUnits: 0,
            shortSkus: [],
            overUnits: 0,
            nothingReceived: false,
        };
    }

    const lines = receiptDeltas(receipt);
    const shortLines = lines.filter((l) => l.cls === "short");
    const shortUnits = shortLines.reduce((s, l) => s + Math.abs(l.delta), 0);
    const overUnits = lines.filter((l) => l.cls === "over").reduce((s, l) => s + l.delta, 0);
    const receivedUnits = lines.reduce((s, l) => s + l.received, 0);
    const nothingReceived = receivedUnits === 0;

    const verdict: PoReceiptVerdict = shortLines.length === 0
        ? "complete"
        : nothingReceived
            ? "not_received"
            : "partial";

    return {
        verdict,
        lines,
        shortUnits,
        shortSkus: shortLines.map((l) => `${l.sku} ×${Math.abs(l.delta)}`),
        overUnits,
        nothingReceived,
    };
}
