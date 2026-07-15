/**
 * @file    src/lib/storage/sync-queue.ts
 * @purpose Unified async sync queue: SQLite → PostgREST.
 *
 *          Every module that writes to local SQLite and wants to sync to
 *          PostgREST uses this queue instead of writing their own sync logic.
 *          The queue is backed by a SQLite table so it survives crashes.
 *
 *          DESIGN:
 *            - enqueueSync() writes a sync task to SQLite, returns immediately
 *            - processSyncQueue() is called by a cron job every 60s
 *            - Each task has: table_name, record_id, operation (upsert/delete),
 *              retry_count, next_retry_at
 *            - Exponential backoff: 1min → 2min → 4min → 8min → 16min → max 1h
 *            - Failed tasks past max retries are logged and archived
 *
 *          USAGE:
 *            import { enqueueSync } from "@/lib/storage/sync-queue";
 *
 *            // After writing to SQLite:
 *            await enqueueSync("purchase_orders", poNumber, "upsert");
 *
 * @author  Hermia
 * @created 2026-07-15
 * @deps    @/lib/storage/local-db, @/lib/db
 */

import { getLocalDb } from "./local-db";
import { createClient } from "../db";

// ── Schema ──────────────────────────────────────────────────────────────────

let initialized = false;

function ensureSchema(): void {
    if (initialized) return;
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL DEFAULT 'upsert',
            payload_json TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 5,
            next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(table_name, record_id, operation)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_retry ON sync_queue(next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_sync_table ON sync_queue(table_name);
    `);
    initialized = true;
}

// ── Retry schedule: 1min, 2min, 4min, 8min, 16min, 32min, 1h cap ───────────

const RETRY_DELAYS_MINUTES = [1, 2, 4, 8, 16, 32, 60];
const MAX_RETRIES = RETRY_DELAYS_MINUTES.length;

function getNextRetryAt(retryCount: number): string {
    const delay = RETRY_DELAYS_MINUTES[Math.min(retryCount, RETRY_DELAYS_MINUTES.length - 1)];
    return new Date(Date.now() + delay * 60_000).toISOString();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enqueue a sync task. Writes to SQLite queue immediately, returns.
 * The background cron will process it asynchronously.
 *
 * @param tableName - PostgREST table name (e.g. "purchase_orders", "tracking_info")
 * @param recordId  - Primary key value of the record to sync
 * @param operation - "upsert" (default) or "delete"
 * @param payload   - Optional full record payload (if not provided, sync reads from SQLite cache)
 */
export async function enqueueSync(
    tableName: string,
    recordId: string,
    operation: "upsert" | "delete" = "upsert",
    payload?: Record<string, unknown>,
): Promise<void> {
    try {
        ensureSchema();
        const db = getLocalDb();
        db.prepare(`
            INSERT INTO sync_queue (table_name, record_id, operation, payload_json, next_retry_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(table_name, record_id, operation) DO UPDATE SET
                retry_count = 0,
                payload_json = COALESCE(excluded.payload_json, sync_queue.payload_json),
                last_error = NULL,
                next_retry_at = datetime('now'),
                updated_at = datetime('now')
        `).run(tableName, recordId, operation, payload ? JSON.stringify(payload) : null);
    } catch (err: any) {
        console.warn(`[sync-queue] Enqueue failed (non-fatal): ${err.message}`);
    }
}

/**
 * Get the current queue depth (pending + retrying tasks).
 */
export function getQueueDepth(): number {
    try {
        ensureSchema();
        const db = getLocalDb();
        const row = db.prepare(
            `SELECT COUNT(*) as c FROM sync_queue WHERE next_retry_at <= datetime('now')`
        ).get() as { c: number };
        return row?.c ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Get queue stats for health monitoring.
 */
export function getQueueStats(): {
    pending: number;
    retrying: number;
    failed: number;
    total: number;
} {
    try {
        ensureSchema();
        const db = getLocalDb();
        const total = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue`).get() as any)?.c ?? 0;
        const pending = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE next_retry_at <= datetime('now') AND retry_count < ?`).get(MAX_RETRIES) as any)?.c ?? 0;
        const retrying = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE next_retry_at > datetime('now') AND retry_count < ?`).get(MAX_RETRIES) as any)?.c ?? 0;
        const failed = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE retry_count >= ?`).get(MAX_RETRIES) as any)?.c ?? 0;
        return { pending, retrying, failed, total };
    } catch {
        return { pending: 0, retrying: 0, failed: 0, total: 0 };
    }
}

// ── Sync Handlers ───────────────────────────────────────────────────────────

/**
 * Process one sync task: read from SQLite cache, write to PostgREST.
 * Each table needs its own sync handler registered here.
 */
async function executeSyncTask(task: {
    id: number;
    table_name: string;
    record_id: string;
    operation: string;
    payload_json: string | null;
}): Promise<boolean> {
    const db = createClient();
    if (!db) {
        console.warn(`[sync-queue] PostgREST not available — will retry`);
        return false;
    }

    const table = task.table_name;
    const id = task.record_id;

    try {
        if (task.operation === "delete") {
            await db.from(table).delete().eq(getPKColumn(table), id);
            return true;
        }

        // For upsert: use provided payload or read from SQLite cache
        let payload: Record<string, unknown> | null = null;

        if (task.payload_json) {
            payload = JSON.parse(task.payload_json);
        } else {
            // Auto-fetch from the appropriate cache table
            payload = fetchRecordFromCache(table, id);
        }

        if (!payload) {
            console.warn(`[sync-queue] No data to sync for ${table}.${id} — skipping`);
            return true; // Not an error — nothing to sync
        }

        await db.from(table).upsert(payload, { onConflict: getPKColumn(table) });
        return true;
    } catch (err: any) {
        console.warn(`[sync-queue] Sync failed for ${table}.${id}: ${err.message}`);
        return false;
    }
}

/**
 * Read a record from SQLite cache tables to build the sync payload.
 * Add new tables here as the cache layer expands.
 */
function fetchRecordFromCache(table: string, id: string): Record<string, unknown> | null {
    const localDb = getLocalDb();

    try {
        switch (table) {
            case "shipments":
            case "tracking_info": {
                const row = localDb.prepare(
                    `SELECT * FROM shipments_cache WHERE tracking_number = ?`
                ).get(id) as any;
                if (!row) return null;
                return {
                    tracking_number: row.tracking_number,
                    po_numbers: row.po_numbers,
                    status_category: row.status_category,
                    status_display: row.status_display,
                    estimated_delivery_at: row.estimated_delivery_at,
                    delivered_at: row.delivered_at,
                    last_checked_at: row.last_checked_at,
                    updated_at: row.updated_at,
                };
            }

            case "purchase_orders": {
                const row = localDb.prepare(
                    `SELECT * FROM po_cache WHERE po_number = ?`
                ).get(id) as any;
                if (!row) return null;
                return {
                    po_number: row.po_number,
                    vendor_name: row.vendor_name,
                    status: row.status,
                    total_amount: row.total_amount,
                    line_items: row.line_items,
                    lifecycle_state: row.lifecycle_state,
                    estimated_eta: row.estimated_eta,
                    updated_at: row.updated_at,
                };
            }

            case "vendor_invoices": {
                const row = localDb.prepare(
                    `SELECT * FROM invoice_cache WHERE vendor_invoice_id = ?`
                ).get(id) as any;
                if (!row) return null;
                return {
                    vendor_invoice_id: row.vendor_invoice_id,
                    vendor_name: row.vendor_name,
                    invoice_number: row.invoice_number,
                    invoice_date: row.invoice_date,
                    po_number: row.po_number,
                    total: row.total,
                    freight: row.freight,
                    status: row.status,
                    matched_po: row.matched_po,
                    updated_at: row.updated_at,
                };
            }

            case "ap_activity_log": {
                const row = localDb.prepare(
                    `SELECT * FROM ap_activity_log WHERE id = ?`
                ).get(Number(id)) as any;
                if (!row) return null;
                return {
                    intent: row.intent,
                    action_taken: row.action_taken,
                    email_from: row.email_from,
                    metadata: row.metadata,
                    created_at: row.created_at,
                };
            }

            default:
                // Try generic: assume record_id is a JSON payload stored in sync_queue
                return null;
        }
    } catch {
        return null;
    }
}

/**
 * Get the primary key column name for a PostgREST table.
 */
function getPKColumn(table: string): string {
    const pkMap: Record<string, string> = {
        shipments: "tracking_key",
        tracking_info: "tracking_number",
        purchase_orders: "po_number",
        vendor_invoices: "vendor_invoice_id",
        ap_activity_log: "id",
        po_cache: "po_number",
        invoice_cache: "vendor_invoice_id",
        shipments_cache: "tracking_number",
    };
    return pkMap[table] || "id";
}

// ── Cron Handler ────────────────────────────────────────────────────────────

/**
 * Process all pending sync tasks. Call from a cron job (every 60s).
 * Adds exponential backoff: failed tasks are rescheduled at increasing intervals.
 *
 * @param batchSize - Max tasks to process per tick (default 20)
 * @returns { processed, succeeded, failed }
 */
export async function processSyncQueue(batchSize: number = 20): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
}> {
    ensureSchema();
    const localDb = getLocalDb();

    const tasks = localDb.prepare(`
        SELECT * FROM sync_queue
        WHERE next_retry_at <= datetime('now')
        AND retry_count < ?
        ORDER BY retry_count ASC, created_at ASC
        LIMIT ?
    `).all(MAX_RETRIES, batchSize) as Array<{
        id: number;
        table_name: string;
        record_id: string;
        operation: string;
        payload_json: string | null;
        retry_count: number;
    }>;

    if (tasks.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;

    for (const task of tasks) {
        const ok = await executeSyncTask(task);

        if (ok) {
            localDb.prepare(`DELETE FROM sync_queue WHERE id = ?`).run(task.id);
            succeeded++;
        } else {
            const newCount = task.retry_count + 1;
            if (newCount >= MAX_RETRIES) {
                // Max retries exceeded — mark as permanently failed
                localDb.prepare(`
                    UPDATE sync_queue SET
                        retry_count = ?,
                        last_error = 'Max retries exceeded',
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(newCount, task.id);
                console.warn(`[sync-queue] Permanently failed: ${task.table_name}.${task.record_id}`);
            } else {
                const nextRetry = getNextRetryAt(newCount);
                localDb.prepare(`
                    UPDATE sync_queue SET
                        retry_count = ?,
                        next_retry_at = ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(newCount, nextRetry, task.id);
            }
            failed++;
        }
    }

    return { processed: tasks.length, succeeded, failed };
}

/**
 * Clean up permanently failed tasks (older than 7 days).
 */
export function cleanFailedSyncs(): number {
    try {
        ensureSchema();
        const db = getLocalDb();
        const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
        const result = db.prepare(
            `DELETE FROM sync_queue WHERE retry_count >= ? AND updated_at < ?`
        ).run(MAX_RETRIES, cutoff);
        return result.changes;
    } catch {
        return 0;
    }
}
