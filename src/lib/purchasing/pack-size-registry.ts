/**
 * @file    pack-size-registry.ts
 * @purpose Centralised read helpers for the sku_pack_sizes table.
 *          Single source of truth for "how many eaches in a pack" per SKU.
 *          Used by purchasing intelligence, draft PO creation, and reconcilers.
 * @author  Will / Antigravity
 * @created 2026-05-11
 * @updated 2026-06-19
 *
 *          HERMIA(2026-06-19): Replaced direct pg Pool with Supabase JS client.
 *          The old pg Pool (max:4) was leaking connections across prewarm cycles,
 *          exhausting the nano-tier Supavisor pooler (200 conn limit) and causing
 *          ECHECKOUTTIMEOUT/EDBHANDLEREXITED that blocked the purchasing scan.
 *          Supabase JS client uses a single shared connection via the service role
 *          key — no pool management needed.
 */

import { createClient } from "../db";

export interface PackSizeRecord {
    sku: string;
    unitsPerPack: number;
    packUnit: string;
    eaUnitPrice: number | null;
    source: string | null;
    notes: string | null;
}

/**
 * Fetch all pack-size records in one batch (table has ~68 rows — tiny).
 * Returns a Map<sku, PackSizeRecord>.
 * Uses Supabase JS client (single shared connection) instead of a direct
 * pg Pool to avoid connection-leak issues that were exhausting the nano-tier
 * Supavisor pooler during prewarm scans.
 */
export async function getPackSizes(
    skus: string[],
): Promise<Map<string, PackSizeRecord>> {
    const result = new Map<string, PackSizeRecord>();
    if (skus.length === 0) return result;
    const db = createClient();
    if (!db) return result;

    try {
        const { data, error } = await db
            .from("sku_pack_sizes")
            .select("sku, units_per_pack, pack_unit, ea_unit_price, source, notes");
        if (error) {
            console.warn("[pack-size] getPackSizes error:", error.message);
            return result;
        }
        for (const row of data ?? []) {
            result.set(row.sku, {
                sku: row.sku,
                unitsPerPack: Number(row.units_per_pack),
                packUnit: row.pack_unit,
                eaUnitPrice: row.ea_unit_price == null ? null : Number(row.ea_unit_price),
                source: row.source,
                notes: row.notes,
            });
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[pack-size] getPackSizes error:", msg);
    }
    return result;
}

/** @deprecated Use getPackSizes() — Supabase JS client replaces pg Pool. */
async function getPackSize(sku: string): Promise<PackSizeRecord | null> {
    const map = await getPackSizes([sku]);
    return map.get(sku) ?? null;
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
