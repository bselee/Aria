/**
 * @file    src/lib/storage/receiving-cache.ts
 * @purpose SQLite cache for Finale PO receiving data. Reduces API calls
 *          during reconciliation by caching shipment receiving results.
 * @author  Hermia
 * @created 2026-06-01
 * @deps    @/lib/storage/local-db
 *
 * TTL: 1 hour for active POs, 4 hours for fully-received POs.
 * Cache is populated lazily — first miss triggers Finale API call.
 */

import { getLocalDb } from "./local-db";

const CACHE_TTL_ACTIVE_HOURS = 1;
const CACHE_TTL_COMPLETE_HOURS = 4;

export interface CachedReceivingData {
    poNumber: string;
    receivedQtyTotal: number;
    lineItems: Array<{
        productId: string;
        sku: string;
        description: string;
        poQty: number;
        receivedQty: number;
        remainingQty: number;
    }>;
    fullyReceived: boolean;
    lastReceiptDate: string | null;
}

/**
 * Get cached receiving data for a PO.
 * Returns null if not cached or expired.
 */
export function getCachedReceiving(poNumber: string): CachedReceivingData | null {
    try {
        const db = getLocalDb();
        const row = db.prepare(
            `SELECT * FROM receiving_cache
             WHERE po_number = ?
             AND expire_at > datetime('now')`
        ).get(poNumber) as any;

        if (!row) return null;

        return {
            poNumber: row.po_number,
            receivedQtyTotal: row.received_qty_total,
            lineItems: JSON.parse(row.line_items_json || "[]"),
            fullyReceived: !!row.fully_received,
            lastReceiptDate: row.last_receipt_date,
        };
    } catch {
        return null;
    }
}

/**
 * Cache receiving data for a PO.
 */
export function setCachedReceiving(data: CachedReceivingData): void {
    try {
        const db = getLocalDb();
        const ttlHours = data.fullyReceived
            ? CACHE_TTL_COMPLETE_HOURS
            : CACHE_TTL_ACTIVE_HOURS;
        const expireAt = new Date(
            Date.now() + ttlHours * 3600000
        ).toISOString();

        db.prepare(
            `INSERT OR REPLACE INTO receiving_cache
             (po_number, received_qty_total, line_items_json, fully_received,
              last_receipt_date, fetched_at, expire_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`
        ).run(
            data.poNumber,
            data.receivedQtyTotal,
            JSON.stringify(data.lineItems),
            data.fullyReceived ? 1 : 0,
            data.lastReceiptDate,
            expireAt
        );
    } catch {
        // non-critical
    }
}

/**
 * Invalidate cache for a PO (force re-fetch on next access).
 */
export function invalidateReceivingCache(poNumber: string): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `DELETE FROM receiving_cache WHERE po_number = ?`
        ).run(poNumber);
    } catch {
        // non-critical
    }
}

/**
 * Invalidate cache for all POs (e.g., on bot restart).
 */
export function invalidateAllReceivingCache(): void {
    try {
        const db = getLocalDb();
        db.prepare(`DELETE FROM receiving_cache WHERE 1=1`).run();
    } catch {
        // non-critical
    }
}

/**
 * Get cache statistics.
 */
export function getReceivingCacheStats(): {
    total: number;
    active: number;
    complete: number;
} {
    try {
        const db = getLocalDb();
        const total = (
            db.prepare(
                `SELECT COUNT(*) as cnt FROM receiving_cache
                 WHERE expire_at > datetime('now')`
            ).get() as any
        )?.cnt || 0;
        const active = (
            db.prepare(
                `SELECT COUNT(*) as cnt FROM receiving_cache
                 WHERE expire_at > datetime('now') AND fully_received = 0`
            ).get() as any
        )?.cnt || 0;
        const complete = (
            db.prepare(
                `SELECT COUNT(*) as cnt FROM receiving_cache
                 WHERE expire_at > datetime('now') AND fully_received = 1`
            ).get() as any
        )?.cnt || 0;
        return { total, active, complete };
    } catch {
        return { total: 0, active: 0, complete: 0 };
    }
}