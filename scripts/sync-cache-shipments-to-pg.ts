/**
 * @file    scripts/sync-cache-shipments-to-pg.ts
 * @purpose One-time catch-up sync: push shipments_cache PO refs into the PG
 *          `shipments` table (t_1cb3c67c, plan 2.1/2.2).
 *
 *          WHY: the SQLite cache (local-first write store) carries 610 rows
 *          with PO refs, but the cache→PG sync path was broken — it enqueued
 *          table `tracking_info` (no such PG table) and passed po_numbers as a
 *          JSON string instead of a text[] array. Result: only 66 of 681 PG
 *          shipment rows had PO refs. This script merges the cache's PO refs
 *          into PG (upsert on tracking_key, preserving all existing columns),
 *          then you re-run the idempotent legs backfill migration:
 *            node --import tsx --env-file=.env.local scripts/sync-cache-shipments-to-pg.ts
 *            node scripts/run-migration.mjs supabase/migrations/20260812_backfill_po_shipment_legs.sql
 *
 * @deps    better-sqlite3 (local), pg (PostgREST via DATABASE_URL)
 */

import fs from "fs";
import Database from "better-sqlite3";
import pg from "pg";

function getEnv(key: string): string | undefined {
    const env = fs.readFileSync(".env.local", "utf8");
    const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].replace(/^"|"$/g, "").trim() : undefined;
}

function buildTrackingKey(trackingNumber: string): string {
    const trimmed = String(trackingNumber || "").trim();
    if (trimmed.includes(":::")) {
        const [carrier, num] = trimmed.split(":::", 2);
        return `${carrier.trim().toLowerCase()}:${num.trim().toLowerCase()}`;
    }
    return `unknown:${trimmed.toLowerCase()}`;
}

function parsePoNumbers(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

async function main() {
    const local = new Database("aria-local.db", { readonly: true });
    const rows = local
        .prepare(
            `SELECT tracking_number, po_numbers, status_category, status_display,
                    estimated_delivery_at, delivered_at, last_checked_at, updated_at
             FROM shipments_cache WHERE po_numbers IS NOT NULL AND po_numbers <> '[]' AND po_numbers <> ''`,
        )
        .all() as Array<{
        tracking_number: string;
        po_numbers: string;
        status_category: string | null;
        status_display: string | null;
        estimated_delivery_at: string | null;
        delivered_at: string | null;
        last_checked_at: string | null;
        updated_at: string;
    }>;
    local.close();

    console.log(`cache rows with PO refs: ${rows.length}`);

    const client = new pg.Client({ connectionString: getEnv("DATABASE_URL") });
    await client.connect();

    let merged = 0;
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
        const trackingKey = buildTrackingKey(row.tracking_number);
        const poNumbers = parsePoNumbers(row.po_numbers);
        if (poNumbers.length === 0) {
            skipped++;
            continue;
        }

        // Read existing PG row (if any)
        const existing = await client.query(
            `SELECT id, tracking_key, po_numbers FROM shipments WHERE tracking_key = $1`,
            [trackingKey],
        );

        if (existing.rows.length > 0) {
            const cur: string[] = existing.rows[0].po_numbers || [];
            const mergedSet = new Set([...cur, ...poNumbers]);
            const nextArr = Array.from(mergedSet);
            if (cur.length !== nextArr.length) {
                await client.query(
                    `UPDATE shipments SET po_numbers = $1, updated_at = $2 WHERE tracking_key = $3`,
                    [nextArr, row.updated_at || new Date().toISOString(), trackingKey],
                );
                merged++;
            } else {
                skipped++;
            }
        } else {
            // Insert a minimal shipment row so the PO ref is not lost.
            const normalized = row.tracking_number.includes(":::")
                ? row.tracking_number.split(":::", 2)[1].trim()
                : row.tracking_number.trim();
            await client.query(
                `INSERT INTO shipments
                   (id, tracking_key, tracking_number, normalized_tracking_number,
                    carrier_name, carrier_key, tracking_kind, po_numbers,
                    vendor_names, status_category, status_display,
                    estimated_delivery_at, delivered_at, last_checked_at,
                    last_source, source_refs, active, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'unknown',$7,'{}',$8,$9,$10,$11,$12,$13,'[]',true,now(),$14)
                 ON CONFLICT (tracking_key) DO NOTHING`,
                [
                    trackingKey,
                    trackingKey,
                    row.tracking_number,
                    normalized,
                    row.tracking_number.includes(":::") ? row.tracking_number.split(":::", 1)[0].trim() : null,
                    row.tracking_number.includes(":::") ? row.tracking_number.split(":::", 1)[0].trim().toLowerCase() : null,
                    poNumbers,
                    row.status_category,
                    row.status_display,
                    row.estimated_delivery_at,
                    row.delivered_at,
                    row.last_checked_at,
                    "cache_sync_backfill",
                    row.updated_at || new Date().toISOString(),
                ],
            );
            inserted++;
        }
    }

    await client.end();

    console.log(
        `done: merged=${merged} inserted=${inserted} skipped=${skipped} errors=${errors}`,
    );
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
