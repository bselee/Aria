/**
 * @file    src/lib/storage/tracking-cache.ts
 * @purpose Local-first shipment tracking cache using SQLite shipments_cache table.
 *          Primary store for all tracking data. Async syncs to PostgREST as
 *          a best-effort secondary for dashboard queries.
 *
 *          DESIGN:
 *            - Write to SQLite FIRST (fast, always works)
 *            - Async sync to PostgREST (best-effort, never blocks)
 *            - Read from SQLite (sub-ms, no network)
 *            - Table already exists in local-db.ts init schema
 *
 *          ARCHITECTURE:
 *            carrier-poller → tracking-cache.ts (SQLite write)
 *              ↓
 *            PostgREST sync (async, fire-and-forget)
 *              ↓
 *            shipment-intelligence.ts (dashboard reads)
 *              ↓
 *            PO lifecycle updates
 *
 * @author  Hermia
 * @created 2026-07-15
 * @deps    @/lib/storage/local-db, @/lib/db (PostgREST sync)
 */

import { getLocalDb } from "./local-db";
import { getTrackingStatus } from "../carriers/tracking-service";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CachedShipment {
    tracking_number: string;
    po_numbers: string;              // JSON array
    status_category: string | null;
    status_display: string | null;
    estimated_delivery_at: string | null;
    delivered_at: string | null;
    last_checked_at: string | null;
    updated_at: string;
}

export interface TrackingUpsertInput {
    trackingNumber: string;
    poNumbers?: string[];
    statusCategory?: string | null;
    statusDisplay?: string | null;
    estimatedDeliveryAt?: string | null;
    deliveredAt?: string | null;
}

// ── SQLite Helpers ─────────────────────────────────────────────────────────

/**
 * Upsert a shipment record into the local SQLite cache.
 * Writes FIRST, then optionally syncs to PostgREST.
 */
export function upsertTrackingLocal(input: TrackingUpsertInput): CachedShipment {
    const db = getLocalDb();
    const now = new Date().toISOString();

    // Load existing to merge
    const existing = db.prepare(
        `SELECT * FROM shipments_cache WHERE tracking_number = ?`
    ).get(input.trackingNumber) as CachedShipment | undefined;

    const mergedPoNumbers = [
        ...new Set([
            ...(existing ? JSON.parse(existing.po_numbers || "[]") : []),
            ...(input.poNumbers || []),
        ]),
    ];

    const record: CachedShipment = {
        tracking_number: input.trackingNumber,
        po_numbers: JSON.stringify(mergedPoNumbers),
        status_category: input.statusCategory ?? existing?.status_category ?? null,
        status_display: input.statusDisplay ?? existing?.status_display ?? null,
        estimated_delivery_at: input.estimatedDeliveryAt ?? existing?.estimated_delivery_at ?? null,
        delivered_at: input.deliveredAt ?? existing?.delivered_at ?? null,
        last_checked_at: now,
        updated_at: now,
    };

    db.prepare(`
        INSERT INTO shipments_cache (tracking_number, po_numbers, status_category, status_display, estimated_delivery_at, delivered_at, last_checked_at, updated_at)
        VALUES (@tracking_number, @po_numbers, @status_category, @status_display, @estimated_delivery_at, @delivered_at, @last_checked_at, @updated_at)
        ON CONFLICT(tracking_number) DO UPDATE SET
            po_numbers = excluded.po_numbers,
            status_category = excluded.status_category,
            status_display = excluded.status_display,
            estimated_delivery_at = excluded.estimated_delivery_at,
            delivered_at = excluded.delivered_at,
            last_checked_at = excluded.last_checked_at,
            updated_at = excluded.updated_at
    `).run(record);

    return record;
}

/**
 * Read a shipment from local cache by tracking number.
 */
export function getTrackingLocal(trackingNumber: string): CachedShipment | null {
    const db = getLocalDb();
    const row = db.prepare(
        `SELECT * FROM shipments_cache WHERE tracking_number = ?`
    ).get(trackingNumber) as CachedShipment | undefined;
    return row ?? null;
}

/**
 * Search shipments by PO number (uses JSON array contains).
 */
export function getTrackingByPO(poNumber: string): CachedShipment[] {
    const db = getLocalDb();
    const rows = db.prepare(
        `SELECT * FROM shipments_cache WHERE po_numbers LIKE ?`
    ).all(`%${poNumber}%`) as CachedShipment[];
    return rows;
}

/**
 * Get all shipments that need refresh (not checked in N minutes).
 */
export function getStaleTrackings(staleMinutes: number = 60): CachedShipment[] {
    const db = getLocalDb();
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const rows = db.prepare(
        `SELECT * FROM shipments_cache WHERE last_checked_at IS NULL OR last_checked_at < ? ORDER BY last_checked_at ASC`
    ).all(cutoff) as CachedShipment[];
    return rows;
}

/**
 * Count active shipments (not delivered, checked recently).
 */
export function countActiveTrackings(): number {
    const db = getLocalDb();
    const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM shipments_cache
         WHERE (status_category IS NULL OR status_category != 'delivered')
         AND last_checked_at IS NOT NULL`
    ).get() as { cnt: number };
    return row?.cnt ?? 0;
}

// ── PostgREST Sync ─────────────────────────────────────────────────────────

/**
 * Enqueue a tracking record for async sync to PostgREST via the unified sync queue.
 * Fire-and-forget — never blocks the caller.
 */
export async function syncTrackingToPostgREST(record: CachedShipment): Promise<void> {
    const { enqueueSync } = await import("./sync-queue");
    await enqueueSync("tracking_info", record.tracking_number, "upsert", record as any);
}

/**
 * Refresh a single tracking number from carrier API, write to local cache,
 * then async sync to PostgREST.
 */
export async function refreshAndCacheTracking(trackingNumber: string): Promise<CachedShipment | null> {
    try {
        const status = await getTrackingStatus(trackingNumber);
        if (!status) return null;

        const record = upsertTrackingLocal({
            trackingNumber,
            statusCategory: status.category,
            statusDisplay: status.display,
            estimatedDeliveryAt: status.estimated_delivery_at,
            deliveredAt: status.delivered_at,
        });

        // Fire-and-forget sync to PostgREST
        syncTrackingToPostgREST(record).catch(() => {});

        return record;
    } catch (err: any) {
        console.warn(`[tracking-cache] Refresh failed for ${trackingNumber}: ${err.message}`);
        return null;
    }
}

/**
 * Bulk refresh: get stale trackings, refresh each from carrier API.
 * Returns count of refreshed records.
 */
export async function refreshStaleTrackings(staleMinutes: number = 60): Promise<number> {
    const stale = getStaleTrackings(staleMinutes);
    let refreshed = 0;

    for (const s of stale) {
        const result = await refreshAndCacheTracking(s.tracking_number);
        if (result) refreshed++;
        // Rate limit: 500ms between carrier API calls
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[tracking-cache] Refreshed ${refreshed}/${stale.length} stale tracking records`);
    return refreshed;
}

// ── Dashboard Query ────────────────────────────────────────────────────────

/**
 * Get all shipments that are arriving today or are out for delivery.
 * Used by the dashboard panels.
 */
export function getTodaysDeliveries(): CachedShipment[] {
    const db = getLocalDb();
    const today = new Date().toISOString().split("T")[0];
    const rows = db.prepare(
        `SELECT * FROM shipments_cache
         WHERE (date(estimated_delivery_at) = ? OR status_category = 'out_for_delivery')
         AND (status_category IS NULL OR status_category != 'delivered')
         ORDER BY estimated_delivery_at ASC`
    ).all(today) as CachedShipment[];
    return rows;
}

/**
 * Get shipments with delivery exceptions (delayed, damaged, etc.).
 */
export function getExceptionShipments(): CachedShipment[] {
    const db = getLocalDb();
    const rows = db.prepare(
        `SELECT * FROM shipments_cache
         WHERE status_category IN ('exception', 'delayed', 'damaged')
         ORDER BY updated_at DESC`
    ).all() as CachedShipment[];
    return rows;
}
