/**
 * @file snoozes.ts
 * @purpose Persist purchasing-panel snoozes server-side so the Friday report and
 *          the dashboard hide the same things. Browser localStorage alone meant a
 *          snoozed SKU still appeared on the EOW list.
 * @author Hermia
 * @created 2026-11-10
 * @deps better-sqlite3 (aria-local.db via local-db)
 *
 * Keys match the panel: a bare SKU (e.g. "RMC104") or "v:<vendorPartyId>" for a
 * vendor-level snooze. `until` is either "forever" or an ISO timestamp.
 */

import { getLocalDb } from "../storage/local-db";

export interface SnoozeRow {
    key: string;
    until: string;
    updatedAt: string;
}

let ensured = false;

function db() {
    const handle = getLocalDb();
    if (!ensured) {
        handle.exec(`
            CREATE TABLE IF NOT EXISTS purchasing_snoozes (
                key        TEXT PRIMARY KEY,
                until      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        ensured = true;
    }
    return handle;
}

/**
 * Every snooze that is still in force right now.
 * Expired timestamps are filtered in SQL so callers never have to think about it.
 */
export function listActiveSnoozes(nowIso: string = new Date().toISOString()): SnoozeRow[] {
    const rows = db()
        .prepare(`SELECT key, until, updated_at FROM purchasing_snoozes WHERE until = 'forever' OR until > ?`)
        .all(nowIso) as Array<{ key: string; until: string; updated_at: string }>;
    return rows.map((r) => ({ key: r.key, until: r.until, updatedAt: r.updated_at }));
}

/** Insert or replace a snooze. `until` is "forever" or an ISO timestamp. */
export function setSnooze(key: string, until: string): void {
    if (!key) return;
    db()
        .prepare(
            `INSERT INTO purchasing_snoozes (key, until, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET until = excluded.until, updated_at = excluded.updated_at`
        )
        .run(key, until, new Date().toISOString());
}

/** Remove a snooze (unsnooze). */
export function clearSnooze(key: string): void {
    if (!key) return;
    db().prepare(`DELETE FROM purchasing_snoozes WHERE key = ?`).run(key);
}

/**
 * Is a purchasing item hidden?
 *
 * @param sku Finale product id.
 * @param vendorPartyId Finale supplier party id, when known.
 * @param rows Result of {@link listActiveSnoozes}; pass it in a loop.
 */
export function isItemSnoozed(
    sku: string,
    vendorPartyId: string | null | undefined,
    rows: SnoozeRow[]
): boolean {
    for (const r of rows) {
        if (r.key === sku) return true;
        if (vendorPartyId && r.key === `v:${vendorPartyId}`) return true;
    }
    return false;
}
