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
import { getTrackingStatus, type TrackingStatus } from "../carriers/tracking-service";
import { createClient } from "../db";

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

    // Load existing to merge. Case-INSENSITIVE on purpose: callers pass "ups:::1Z…" while the
    // table may hold "UPS:::1Z…", and an exact match would insert a duplicate row (the table has
    // a NOCASE unique index, so that insert would now throw instead of duplicating).
    const existing = db.prepare(
        `SELECT * FROM shipments_cache WHERE upper(tracking_number) = upper(?)`
    ).get(input.trackingNumber) as CachedShipment | undefined;

    const mergedPoNumbers = [
        ...new Set([
            ...(existing ? JSON.parse(existing.po_numbers || "[]") : []),
            ...(input.poNumbers || []),
        ]),
    ];

    const record: CachedShipment = {
        // Reuse the stored spelling when the row already exists so the UPSERT targets it.
        tracking_number: existing?.tracking_number ?? input.trackingNumber,
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
        // Case-insensitive: the cache may store "UPS:::1Z…" while the caller passes "ups:::1Z…".
        `SELECT * FROM shipments_cache WHERE upper(tracking_number) = upper(?)`
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

/** Tiered staleness for the poll loop (2026-10-28). Soon-arriving and
 *  exception rows poll most often; the long tail drains on a 24h cadence
 *  (12h under-provisioned the cap: 1,544 rows / 12h ≈ 129/h > cap 120/h). */
export interface PollTiers {
    tier1: CachedShipment[]; // out_for_delivery / exception / ETA today-tomorrow, stale > 30m
    tier2: CachedShipment[]; // in_transit with an ETA, stale > 4h
    tier3: CachedShipment[]; // everything else active, stale > 24h
}

export function getStaleTrackingsTiered(nowMs: number = Date.now()): PollTiers {
    const db = getLocalDb();
    const now = new Date(nowMs).toISOString();
    const t30 = new Date(nowMs - 30 * 60_000).toISOString();
    const t4h = new Date(nowMs - 4 * 3600_000).toISOString();
    const t24h = new Date(nowMs - 24 * 3600_000).toISOString();
    const rows = db.prepare(
        `SELECT * FROM shipments_cache
         WHERE (status_category IS NULL OR status_category != 'delivered')
         ORDER BY last_checked_at ASC`
    ).all() as CachedShipment[];

    const tomorrowIso = new Date(nowMs + 86400_000).toISOString().slice(0, 10);
    const tier1: CachedShipment[] = [];
    const tier2: CachedShipment[] = [];
    const tier3: CachedShipment[] = [];
    for (const row of rows) {
        const checked = row.last_checked_at ?? "";
        const etaSoon =
            row.estimated_delivery_at != null &&
            (row.estimated_delivery_at.slice(0, 10) === now.slice(0, 10) ||
                row.estimated_delivery_at.slice(0, 10) === tomorrowIso);
        const hot = row.status_category === "out_for_delivery" || row.status_category === "exception";
        if (hot || etaSoon) {
            if (!checked || checked < t30) tier1.push(row);
        } else if (row.estimated_delivery_at != null) {
            if (!checked || checked < t4h) tier2.push(row);
        } else if (!checked || checked < t24h) {
            tier3.push(row);
        }
    }
    return { tier1, tier2, tier3 };
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
 * Write a carrier poll result into the PostgREST `shipments` table — the
 * store the dashboard board actually reads (2026-10-28). Before this, polls
 * only landed in SQLite/tracking_info and the board stayed frozen at ingest
 * time: ETAs and out-for-delivery never surfaced. Guards:
 * - `delivered` is terminal — a poll never downgrades a delivered row.
 * - A missing ETA in the poll keeps the existing one; nulls never wipe data.
 * - `last_checked_at` always advances so staleness is honest.
 */
export async function writePollResultToShipments(
    trackingNumber: string,
    status: TrackingStatus,
): Promise<number> {
    const db = createClient();
    if (!db) return 0;
    const now = new Date().toISOString();
    const { data: rows } = await db
        .from("shipments")
        .select("id, tracking_number, tracking_key, status_category, status_display, estimated_delivery_at, delivered_at")
        .or(`tracking_number.eq.${trackingNumber},tracking_key.ilike.%:::${trackingNumber}`)
        .eq("active", true)
        .limit(20);
    let written = 0;
    for (const row of (rows || []) as Array<{
        id: string;
        tracking_number: string | null;
        tracking_key: string;
        status_category: string | null;
        status_display: string | null;
        estimated_delivery_at: string | null;
        delivered_at: string | null;
    }>) {
        const isDelivered = row.status_category === "delivered" || row.delivered_at != null;
        const incomingDelivered = status.category === "delivered" || status.delivered_at != null;
        if (isDelivered && !incomingDelivered) continue; // terminal — never downgrade

        const patch: Record<string, string> = { last_checked_at: now };
        if (incomingDelivered) {
            patch.status_category = "delivered";
            if (status.delivered_at) patch.delivered_at = status.delivered_at;
            else if (!row.delivered_at) patch.delivered_at = now;
        } else if (status.category && status.category !== row.status_category) {
            patch.status_category = status.category;
        }
        if (status.display && status.display !== row.status_display) {
            patch.status_display = status.display;
        }
        if (status.estimated_delivery_at && status.estimated_delivery_at !== row.estimated_delivery_at) {
            patch.estimated_delivery_at = status.estimated_delivery_at;
        }
        // Always write: `last_checked_at` must advance even when the carrier
        // echoes an unchanged status, or the board's staleness never improves.
        const { error } = await db.from("shipments").update(patch).eq("id", row.id);
        if (!error) written++;
    }
    return written;
}

/**
 * Refresh a single tracking number from carrier API, write to local cache,
 * then write the result into the board's `shipments` table.
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

        // Live writeback into the board's `shipments` table (2026-10-28).
        // Best-effort, never blocks or breaks the poll.
        writePollResultToShipments(trackingNumber, status).catch(() => {});

        return record;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tracking-cache] Refresh failed for ${trackingNumber}: ${msg}`);
        return null;
    }
}

/**
 * Register a tracking number into the poll cache so the carrier loop picks
 * it up (2026-10-28). Called on every successful ingest upsert. A row that
 * already exists is left untouched — the poll refreshes it on cadence.
 */
export function registerTrackingForPolling(input: {
    trackingNumber: string;
    poNumbers?: string[];
    statusCategory?: string | null;
    statusDisplay?: string | null;
    estimatedDeliveryAt?: string | null;
}): void {
    const existing = getTrackingLocal(input.trackingNumber);
    if (existing) return;
    upsertTrackingLocal({
        trackingNumber: input.trackingNumber,
        poNumbers: input.poNumbers,
        statusCategory: input.statusCategory,
        statusDisplay: input.statusDisplay,
        estimatedDeliveryAt: input.estimatedDeliveryAt,
    });
}

/** In-flight guard so overlapping cron ticks never double-poll. */
let refreshing = false;

/**
 * Bulk refresh: tiered by urgency (soon-arriving > ETA-bearing > long tail),
 * capped per run so carrier rate limits hold and the event loop is never
 * starved. Returns 0 when a refresh is already in flight.
 */
export async function refreshStaleTrackings(maxPerRun: number = 120): Promise<number> {
    if (refreshing) return 0;
    refreshing = true;
    try {
        const { tier1, tier2, tier3 } = getStaleTrackingsTiered();
        const queue = [...tier1, ...tier2, ...tier3].slice(0, maxPerRun);
        let refreshed = 0;

        for (const s of queue) {
            const result = await refreshAndCacheTracking(s.tracking_number);
            if (result) refreshed++;
            // Rate limit: 500ms between carrier API calls
            await new Promise((r) => setTimeout(r, 500));
        }

        console.log(
            `[tracking-cache] Refreshed ${refreshed}/${queue.length} (tiers ${tier1.length}/${tier2.length}/${tier3.length} stale)`,
        );
        return refreshed;
    } finally {
        refreshing = false;
    }
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
