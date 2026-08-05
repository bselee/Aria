/**
 * @file    receiving-cache.ts
 * @purpose Populate the local receiving_cache table from Finale PO receipt data.
 *          Tracks per-PO received quantities and full-receipt status so the
 *          purchasing pipeline can distinguish fully-received single-shipment POs
 *          from partially-received blanket POs.
 *
 *          Called during purchasing scan warmup and by the po-receiving-watcher cron.
 *
 * @author  Hermia
 * @created 2026-08-04
 * @deps    finale/client, storage/local-db
 * @env     none
 */

import { FinaleClient, finaleClient } from "../finale/client";
import { getLocalDb } from "../storage/local-db";

export interface ReceivingCacheRow {
    po_number: string;
    received_qty_total: number;
    line_items_json: string;
    fully_received: number; // 0 or 1
    last_receipt_date: string | null;
    fetched_at: string;
    expire_at: string;
}

/**
 * Refresh the receiving_cache from Finale's PO data.
 * Queries recent POs (180d window), extracts per-line received quantities,
 * and upserts into the local SQLite table.
 *
 * Returns the number of POs upserted.
 */
export async function refreshReceivingCache(): Promise<number> {
    const db = getLocalDb();
    if (!db) {
        console.warn("[receiving-cache] Local DB unavailable — skipping refresh");
        return 0;
    }

    const client: FinaleClient = finaleClient;
    let upserted = 0;

    try {
        // Fetch recent POs with receipt data
        const pos = await client.getRecentPurchaseOrders(180, 500);

        const now = new Date().toISOString();
        const expireAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h TTL

        const upsert = db.prepare(`
            INSERT INTO receiving_cache 
                (po_number, received_qty_total, line_items_json, fully_received, last_receipt_date, fetched_at, expire_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(po_number) DO UPDATE SET
                received_qty_total = excluded.received_qty_total,
                line_items_json = excluded.line_items_json,
                fully_received = excluded.fully_received,
                last_receipt_date = excluded.last_receipt_date,
                fetched_at = excluded.fetched_at,
                expire_at = excluded.expire_at
        `);

        for (const po of pos) {
            const orderId = String(po.orderId);
            const items = po.items ?? [];

            // Sum received quantities across all line items
            let receivedQtyTotal = 0;
            let totalOrderedQty = 0;
            const lineItems: Array<{ sku: string; ordered: number; received: number }> = [];

            for (const item of items) {
                const ordered = item.quantity ?? 0;
                const received = item.receivedQty ?? 0;
                receivedQtyTotal += received;
                totalOrderedQty += ordered;
                lineItems.push({
                    sku: item.productId ?? item.sku ?? "?",
                    ordered,
                    received,
                });
            }

            // Fully received when received >= ordered (with 0.01 tolerance for rounding)
            const fullyReceived = totalOrderedQty > 0 && receivedQtyTotal >= totalOrderedQty - 0.01 ? 1 : 0;

            // Last receipt date from PO-level or item-level
            const lastReceiptDate = po.receiveDate ?? null;

            upsert.run(
                orderId,
                receivedQtyTotal,
                JSON.stringify(lineItems),
                fullyReceived,
                lastReceiptDate,
                now,
                expireAt,
            );
            upserted++;
        }

        console.log(`[receiving-cache] Refreshed ${upserted} POs (${pos.length} fetched from Finale)`);
    } catch (err: any) {
        console.warn(`[receiving-cache] Refresh failed: ${err?.message ?? err}`);
    }

    return upserted;
}

/**
 * Get receiving data for a single PO. Returns null if not cached or expired.
 */
export function getReceivingCache(poNumber: string): ReceivingCacheRow | null {
    const db = getLocalDb();
    if (!db) return null;

    const row = db.prepare(`
        SELECT * FROM receiving_cache 
        WHERE po_number = ? AND expire_at > datetime('now')
    `).get(poNumber) as ReceivingCacheRow | undefined;

    return row ?? null;
}

/**
 * Check if a PO is fully received according to the cache.
 * Returns null if no cache data available (caller should be conservative).
 */
export function isPOFullyReceived(poNumber: string): boolean | null {
    const row = getReceivingCache(poNumber);
    if (!row) return null;
    return row.fully_received === 1;
}
