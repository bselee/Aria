/**
 * @file    po-cache.ts
 * @purpose Cache layer for Finale PO data. Reads from PostgREST when healthy + fresh;
 *          always falls back to Finale. Never blocks the dashboard on a dead DB.
 * @author  Hermia
 * @created 2026-07-16
 * @updated 2026-07-16 — probe + timeout; fire-and-forget cache write
 * @deps    @/lib/db, @/lib/finale/client
 */

import type { FinaleClient, FullPO } from "../finale/client";
import { createClient, probePostgrest } from "../db";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function getCacheAge(): Promise<Date | null> {
    const healthy = await probePostgrest(1500);
    if (!healthy) return null;

    const db = createClient();
    if (!db) return null;
    try {
        const { data, error } = await db
            .from("purchase_orders")
            .select("updated_at")
            .order("updated_at", { ascending: false })
            .limit(1);
        if (error || !data || data.length === 0 || !data[0].updated_at) return null;
        return new Date(data[0].updated_at);
    } catch {
        return null;
    }
}

function isCacheFresh(lastSync: Date | null): boolean {
    if (!lastSync) return false;
    return (Date.now() - lastSync.getTime()) < CACHE_TTL_MS;
}

/**
 * Upsert Finale PO data into the purchase_orders cache table.
 * Best-effort — failures are logged, never thrown.
 */
export async function cacheFinalePos(pos: FullPO[]): Promise<void> {
    const healthy = await probePostgrest(1500);
    if (!healthy) return;

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

    for (let i = 0; i < chunks.length; i += 100) {
        const batch = chunks.slice(i, i + 100);
        try {
            await db.from("purchase_orders").upsert(batch, { onConflict: "po_number" });
        } catch (e) {
            console.error("[po-cache] batch upsert failed:", (e as Error).message);
        }
    }
}

async function readCachedPos(): Promise<FullPO[]> {
    const db = createClient();
    if (!db) return [];

    try {
        const { data, error } = await db
            .from("purchase_orders")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(500);

        if (error || !data || data.length === 0) return [];

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
 * Get POs using cache when PostgREST is healthy and fresh; otherwise Finale.
 * Cache write is best-effort after a Finale fetch.
 */
export async function getCachedOrFresh(
    finale: FinaleClient,
    daysBack = 60,
    forceRefresh = false
): Promise<{ pos: FullPO[]; fromCache: boolean }> {
    if (!forceRefresh) {
        try {
            const lastSync = await getCacheAge();
            if (lastSync && isCacheFresh(lastSync)) {
                const cached = await readCachedPos();
                if (cached.length > 0) {
                    console.log(`[po-cache] HIT — ${cached.length} POs (synced ${timeAgo(lastSync)})`);
                    return { pos: cached, fromCache: true };
                }
            }
        } catch (e: any) {
            console.warn("[po-cache] cache read failed, using Finale:", e?.message || e);
        }
    }

    console.log(`[po-cache] MISS — fetching from Finale`);
    const pos = await finale.getRecentPurchaseOrders(daysBack);

    // Fire-and-forget cache write — never delay response
    void cacheFinalePos(pos).catch((e) =>
        console.warn("[po-cache] background cache write failed:", (e as Error).message)
    );
    console.log(`[po-cache] FRESH — ${pos.length} POs from Finale`);

    return { pos, fromCache: false };
}

function timeAgo(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
}
