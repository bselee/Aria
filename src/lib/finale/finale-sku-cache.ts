/**
 * @file    finale-sku-cache.ts
 * @purpose Persistent (DB-backed) cache for Finale /api/product/<sku> lookups.
 *          BOM recipes, vendor assignment, and lead times change rarely — the
 *          existing in-memory caches in products.ts (_vendorCache, 4h TTL)
 *          are wiped on every PM2 restart, forcing a full ~700-SKU rescan
 *          that trips Finale's own rate limiter (429s observed 2026-07-24
 *          during heavy purchasing-intelligence runs).
 *
 *          This module persists per-SKU product detail to `finale_sku_cache`
 *          with a 24h TTL, so steady-state runs only refetch SKUs that are
 *          missing or stale — not the whole catalog on every cold start.
 * @author  Hermia (Aria)
 * @created 2026-07-24
 * @deps    @/lib/db
 * @env     none (uses existing DATABASE_URL / PGRST_URL via createClient())
 */

import { createClient } from "@/lib/db";
import type { FinaleProductDetail } from "./core-client";

/** TTL before a cached SKU row is considered stale and refetched. */
export const SKU_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface CachedSkuRow {
    sku: string;
    vendor_name: string | null;
    vendor_party_id: string | null;
    unit_cost: number | null;
    lead_time_days: number | null;
    has_bom: boolean;
    bom_components: Array<{ componentSku: string; quantity: number }> | null;
    do_not_reorder: boolean;
    reorder_method: string | null;
    raw_detail: FinaleProductDetail | null;
    cached_at: string;
    updated_at: string;
}

/**
 * Fetch all non-stale cached rows for the given SKUs in one query.
 * Callers should treat SKUs absent from the returned map as cache misses.
 *
 * @param skus - SKUs to look up.
 * @returns Map of sku → cached row, containing only fresh (<24h) entries.
 */
export async function getFreshCachedSkus(
    skus: string[],
): Promise<Map<string, CachedSkuRow>> {
    const result = new Map<string, CachedSkuRow>();
    if (skus.length === 0) return result;

    const db = createClient();
    if (!db) return result;

    const cutoff = new Date(Date.now() - SKU_CACHE_TTL_MS).toISOString();

    const { data, error } = await db
        .from("finale_sku_cache")
        .select("*")
        .in("sku", skus)
        .gt("cached_at", cutoff);

    if (error) {
        console.warn("[finale-sku-cache] read failed, treating as full cache miss:", error?.message || error);
        return result;
    }

    for (const row of (data as CachedSkuRow[] | null) || []) {
        result.set(row.sku, row);
    }
    return result;
}

/**
 * Upsert a freshly-fetched Finale product detail into the persistent cache.
 * Fire-and-forget from callers' perspective — failures are logged, never thrown,
 * since a cache-write failure must not block the purchasing pipeline.
 *
 * @param sku - Product SKU.
 * @param detail - Full FinaleProductDetail as returned by lookupProduct().
 * @param bomComponents - Optional BOM component list if this SKU is manufactured.
 */
export async function upsertSkuCache(
    sku: string,
    detail: FinaleProductDetail,
    bomComponents: Array<{ componentSku: string; quantity: number }> | null = null,
): Promise<void> {
    const db = createClient();
    if (!db) return;

    const main = detail.suppliers.find((s) => s.role === "MAIN") ?? detail.suppliers[0];
    const vendorPartyId = main?.partyUrl ? main.partyUrl.split("/").pop() ?? null : null;

    const now = new Date().toISOString();
    const { error } = await db.from("finale_sku_cache").upsert(
        {
            sku,
            vendor_name: main?.name ?? null,
            vendor_party_id: vendorPartyId,
            unit_cost: main?.cost ?? null,
            lead_time_days: detail.leadTimeDays,
            has_bom: detail.hasBOM,
            bom_components: bomComponents,
            do_not_reorder: detail.doNotReorder,
            reorder_method: detail.reorderMethod ?? null,
            raw_detail: detail,
            cached_at: now,
            updated_at: now,
        },
        { onConflict: "sku" },
    );

    if (error) {
        console.warn(`[finale-sku-cache] upsert failed for ${sku}:`, error?.message || error);
    }
}

/**
 * Reconstruct a FinaleProductDetail-shaped object from a cached row, for
 * callers that only need the cached fields (skips the raw_detail passthrough
 * when present).
 *
 * @param row - Cached row from getFreshCachedSkus().
 * @returns The stored FinaleProductDetail if present, else null.
 */
export function cachedRowToProductDetail(row: CachedSkuRow): FinaleProductDetail | null {
    return row.raw_detail ?? null;
}
