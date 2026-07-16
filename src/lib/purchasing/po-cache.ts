/**
 * @file    po-cache.ts
 * @purpose Cache layer for Finale PO data. Stores PO summaries in the local
 *          purchase_orders table so the dashboard reads from PostgREST instead
 *          of live-querying Finale's GraphQL API (which is slow and rate-limited).
 *
 *          Flow:
 *          getCachedOrFresh(forceRefresh=false)
 *            ├─ Check purchase_orders: if any PO has updated_at < 15 min ago → RETURN CACHE
 *            ├─ Otherwise → call Finale → upsert ALL POs → RETURN FRESH
 *
 * @author  Hermia
 * @created 2026-07-16
 * @deps    @/lib/db, @/lib/finale/client
 */

import type { FinaleClient, FullPO } from "../finale/client";
import { createClient } from "../db";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SYNC_TAG_KEY = "po_cache_last_sync";

/**
 * Check if the PO cache is fresh enough to skip a Finale call.
 * Returns the ISO timestamp of the last sync, or null if never synced.
 */
async function getCacheAge(): Promise<Date | null> {
    const db = createClient();
    if (!db) return null;
    try {
        const { data } = await db
            .from("purchase_orders")
            .select("updated_at")
            .order("updated_at", { ascending: false })
            .limit(1);
        if (data && data.length > 0 && data[0].updated_at) {
            return new Date(data[0].updated_at);
        }
    } catch { /* no cache yet */ }
    return null;
}

/**
 * Whether the cache is fresh enough to skip Finale.
 */
function isCacheFresh(lastSync: Date | null): boolean {
    if (!lastSync) return false;
    return (Date.now() - lastSync.getTime()) < CACHE_TTL_MS;
}

/**
 * Upsert Finale PO data into the purchase_orders cache table.
 * Returns the list of POs that were cached.
 */
export async function cacheFinalePos(pos: FullPO[]): Promise<void> {
    const db = createClient();
    if (!db || pos.length === 0) return;

    const now = new Date().toISOString();
    const chunks: any[] = [];

    for (const po of pos) {
        chunks.push({
            po_number: po.orderId,
            vendor_name: po.vendorName,
            status: po.status || "unknown",
            total: po.total,
            total_amount: po.total,
            line_items: JSON.stringify(po.items || []),
            issue_date: po.orderDate || null,
            required_date: (po as any).expectedDate || (po as any).dueDate || null,
            updated_at: now,
        });
    }

    // Upsert in batches of 100
    for (let i = 0; i < chunks.length; i += 100) {
        const batch = chunks.slice(i, i + 100);
        try {
            await db.from("purchase_orders").upsert(batch, { onConflict: "po_number" });
        } catch (e) {
            console.error("[po-cache] batch upsert failed:", (e as Error).message);
        }
    }
}

/**
 * Read cached PO data from purchase_orders table.
 * Returns FullPO-like objects reconstructed from cache.
 */
async function readCachedPos(): Promise<FullPO[]> {
    const db = createClient();
    if (!db) return [];

    try {
        const { data } = await db
            .from("purchase_orders")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(500);

        if (!data || data.length === 0) return [];

        return data.map((row: any) => {
            let items: Array<{ productId: string; quantity: number }> = [];
            try {
                const parsed = typeof row.line_items === "string"
                    ? JSON.parse(row.line_items)
                    : (row.line_items || []);
                items = Array.isArray(parsed) ? parsed : [];
            } catch { items = []; }

            return {
                orderId: row.po_number,
                vendorName: row.vendor_name || "",
                orderDate: row.issue_date ? new Date(row.issue_date).toISOString().split("T")[0] : "",
                status: row.status || "",
                total: Number(row.total) || 0,
                items,
                itemList: { edges: items.map((i: any) => ({ node: { product: { productId: i.productId }, quantity: i.quantity } })) },
                supplier: { name: row.vendor_name || "" },
                orderUrl: "",
                shipmentList: [],
            } as unknown as FullPO;
        });
    } catch {
        return [];
    }
}

/**
 * Get active POs, using cache when fresh.
 *
 * @param finale       FinaleClient instance
 * @param daysBack     Days of history to fetch from Finale on cache miss
 * @param forceRefresh If true, skip cache and call Finale directly
 * @returns FullPO array + whether it came from cache
 */
export async function getCachedOrFresh(
    finale: FinaleClient,
    daysBack = 60,
    forceRefresh = false
): Promise<{ pos: FullPO[]; fromCache: boolean }> {
    // Check cache freshness
    const lastSync = forceRefresh ? null : await getCacheAge();
    if (lastSync && isCacheFresh(lastSync)) {
        const cached = await readCachedPos();
        if (cached.length > 0) {
            console.log(`[po-cache] HIT — ${cached.length} POs from cache (synced ${timeAgo(lastSync)})`);
            return { pos: cached, fromCache: true };
        }
    }

    // Cache miss or stale — fetch from Finale
    console.log(`[po-cache] MISS — fetching from Finale (last sync: ${lastSync?.toISOString() || "never"})`);
    const pos = await finale.getRecentPurchaseOrders(daysBack);

    // Cache the result
    await cacheFinalePos(pos);
    console.log(`[po-cache] CACHED — ${pos.length} POs`);

    return { pos, fromCache: false };
}

function timeAgo(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
}
