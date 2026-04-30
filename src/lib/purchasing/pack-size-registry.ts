/**
 * @file    pack-size-registry.ts
 * @purpose Centralised read helpers for the sku_pack_sizes table.
 *          Single source of truth for "how many eaches in a pack" per SKU.
 *          Used by purchasing intelligence, draft PO creation, and reconcilers.
 * @author  Will / Antigravity
 * @created 2026-05-11
 * @updated 2026-05-11
 *
 *          Uses pg directly via DATABASE_URL because the @supabase/supabase-js
 *          fetch path was throwing "TypeError: fetch failed" inside the Next.js
 *          server (Node 20 + Next 15 fetch wrapper interaction). pg is also
 *          faster for hot paths like getPurchasingIntelligence.
 */

import { Pool } from "pg";

export interface PackSizeRecord {
    sku: string;
    unitsPerPack: number;
    packUnit: string;
    eaUnitPrice: number | null;
    source: string | null;
    notes: string | null;
}

let _pool: Pool | null = null;

function getPool(): Pool | null {
    if (_pool) return _pool;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.warn("[pack-size] DATABASE_URL missing — registry disabled");
        return null;
    }
    _pool = new Pool({
        connectionString,
        max: 4,
        idleTimeoutMillis: 30_000,
    });
    _pool.on("error", (err) => {
        console.warn("[pack-size] pool error:", err.message);
    });
    return _pool;
}

function rowToRecord(row: {
    sku: string;
    units_per_pack: number;
    pack_unit: string;
    ea_unit_price: string | number | null;
    source: string | null;
    notes: string | null;
}): PackSizeRecord {
    return {
        sku: row.sku,
        unitsPerPack: Number(row.units_per_pack),
        packUnit: row.pack_unit,
        eaUnitPrice: row.ea_unit_price == null ? null : Number(row.ea_unit_price),
        source: row.source,
        notes: row.notes,
    };
}

/**
 * Fetch a single pack-size record by SKU.
 * Returns null if the SKU is not registered.
 */
export async function getPackSize(sku: string): Promise<PackSizeRecord | null> {
    const pool = getPool();
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            "SELECT sku, units_per_pack, pack_unit, ea_unit_price, source, notes FROM sku_pack_sizes WHERE sku = $1 LIMIT 1",
            [sku],
        );
        if (rows.length === 0) return null;
        return rowToRecord(rows[0]);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pack-size] getPackSize error for ${sku}:`, msg);
        return null;
    }
}

/**
 * Batch-fetch pack sizes for many SKUs in one query.
 * Returns a Map<sku, PackSizeRecord>.
 */
export async function getPackSizes(
    skus: string[],
): Promise<Map<string, PackSizeRecord>> {
    const result = new Map<string, PackSizeRecord>();
    const pool = getPool();
    if (!pool || skus.length === 0) return result;

    try {
        const { rows } = await pool.query(
            "SELECT sku, units_per_pack, pack_unit, ea_unit_price, source, notes FROM sku_pack_sizes WHERE sku = ANY($1::text[])",
            [skus],
        );
        for (const row of rows) {
            const rec = rowToRecord(row);
            result.set(rec.sku, rec);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[pack-size] getPackSizes error:", msg);
    }
    return result;
}

/**
 * Convert a pack quantity to eaches using the registry.
 * Returns the original quantity if no registry entry exists.
 */
export function packsToEaches(
    qty: number,
    packSize: PackSizeRecord | null
): number {
    if (!packSize || packSize.unitsPerPack <= 1) return qty;
    return qty * packSize.unitsPerPack;
}

/**
 * Convert an each quantity to pack quantity using the registry.
 * Returns the original quantity if no registry entry exists.
 */
export function eachesToPacks(
    qty: number,
    packSize: PackSizeRecord | null
): number {
    if (!packSize || packSize.unitsPerPack <= 1) return qty;
    return qty / packSize.unitsPerPack;
}

/**
 * Compute per-each price from a pack price using the registry.
 * Returns the original price if no registry entry exists.
 */
export function packPriceToEaPrice(
    packPrice: number,
    packSize: PackSizeRecord | null
): number {
    if (!packSize || packSize.unitsPerPack <= 1) return packPrice;
    return packPrice / packSize.unitsPerPack;
}

/**
 * Build a human-readable pack string for UI display.
 * Example: "12 case" or "1 each"
 */
export function formatPackSize(packSize: PackSizeRecord | null): string {
    if (!packSize) return "";
    return `${packSize.unitsPerPack} ${packSize.packUnit}`;
}
