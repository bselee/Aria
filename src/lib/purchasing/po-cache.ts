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
 *
 * HERMIA(2026-08-06): NEVER write receive_date:null — that wiped real
 * shipment-level receipts (Stock Bag 124895: PO.receiveDate null but
 * shipment Received 2026-06-12). Prefer max past shipment receiveDate.
 */
export async function cacheFinalePos(pos: FullPO[]): Promise<void> {
    const healthy = await probePostgrest(1500);
    if (!healthy) return;

    const db = createClient();
    if (!db || pos.length === 0) return;

    const now = new Date().toISOString();
    const chunks: any[] = [];

    for (const po of pos) {
        const shipRecv = maxPastShipmentReceiveDate(po.shipments);
        const recv = po.receiveDate || shipRecv || null;
        const row: Record<string, unknown> = {
            po_number: po.orderId,
            vendor_name: po.vendorName,
            vendor_party_id: po.vendorPartyId || null,
            status: po.status || "unknown",
            total: po.total,
            total_amount: po.total,
            // BUGFIX(2026-07-27): do NOT JSON.stringify into a jsonb column.
            line_items: po.items || [],
            issue_date: po.orderDate || null,
            required_date: (po as any).expectedDate || (po as any).dueDate || null,
            updated_at: now,
        };
        // Only set receive_date when we have a real value — never null-wipe.
        if (recv) row.receive_date = recv;
        chunks.push(row);
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

/** Latest past shipment receiveDate (YYYY-MM-DD), or null. */
function maxPastShipmentReceiveDate(
    shipments: FullPO["shipments"] | undefined,
): string | null {
    if (!shipments?.length) return null;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const past = shipments
        .map((s) => (s.receiveDate || "").slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today);
    if (past.length === 0) return null;
    return past.sort().at(-1) || null;
}

/**
 * Read cached POs for the Active Purchases view.
 *
 * HERMIA(2026-08-27): ordering by `updated_at` desc + limit(500) silently
 * excluded every in-flight PO. A cache-wide refresh stamps ~1,300 rows with a
 * near-identical updated_at, so that ordering is effectively arbitrary — 538
 * rows sorted ahead of PO 125235, pushing live POs past the 500 cutoff and
 * showing 8 where Finale had 19. Order by `issue_date` desc (newest ORDERS
 * first, which is what "active" means) and drop terminal `closed` rows
 * server-side so the window is spent on live POs.
 */
async function readCachedPos(daysBack = 60): Promise<FullPO[]> {
    const db = createClient();
    if (!db) return [];

    // Match the live Finale path's window — getRecentPurchaseOrders(daysBack).
    // Without this the cache returned POs of ANY age, so the cached branch
    // disagreed with the bust branch on which POs even exist.
    const cutoff = new Date(Date.now() - daysBack * 86400_000)
        .toISOString().slice(0, 10);

    try {
        const { data, error } = await db
            .from("purchase_orders")
            .select("*")
            .neq("status", "closed")
            .gte("issue_date", cutoff)
            .order("issue_date", { ascending: false })
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
                            vendorPartyId: row.vendor_party_id || null,
                            orderDate: row.issue_date ? new Date(row.issue_date).toISOString().split("T")[0] : "",
                            status: row.status || "",
                            total: Number(row.total) || Number(row.total_amount) || 0,
                            receiveDate: row.receive_date ? new Date(row.receive_date).toISOString().split("T")[0] : null,
                            items,
                            itemList: { edges: items.map((i: any) => ({ node: { product: { productId: i.productId }, quantity: i.quantity } })) },
                            supplier: { name: row.vendor_name || "" },
                            orderUrl: "",
                            shipmentList: [],
                            // HERMIA(2026-08-06): Cache path used to drop shipment receive
                            // evidence. Reconstruct a synthetic shipment when receive_date
                            // exists so hasPurchaseOrderReceipt still sees it. Also pass
                            // lifecycle_stage through for Active exit.
                            shipments: row.receive_date
                                ? [{
                                    shipmentId: `${row.po_number}-cached`,
                                    status: "Received",
                                    receiveDate: new Date(row.receive_date).toISOString().split("T")[0],
                                    shipDate: null,
                                }]
                                : [],
                            // @ts-expect-error carry-through for loadActivePurchases
                            lifecycleStage: row.lifecycle_stage || null,
                        } as unknown as FullPO;
        });
    } catch {
        return [];
    }
}

/**
 * Get POs using cache when PostgREST is healthy and fresh; otherwise Finale.
 * Cache write is best-effort after a Finale fetch.
 *
 * HERMIA(2026-07-28): Single-flight per (daysBack, force) key. Concurrent
 * dashboard panels (Active Purchases, Ordering SWR warm, bust paths) used to
 * stampede Finale with identical getRecentPurchaseOrders calls. One shared
 * promise keeps accounting views on the same snapshot.
 */
const _inflightByKey = new Map<string, Promise<{ pos: FullPO[]; fromCache: boolean }>>();

export async function getCachedOrFresh(
    finale: FinaleClient,
    daysBack = 60,
    forceRefresh = false
): Promise<{ pos: FullPO[]; fromCache: boolean }> {
    const key = `${daysBack}:${forceRefresh ? "1" : "0"}`;
    const existing = _inflightByKey.get(key);
    if (existing) {
        console.log(`[po-cache] JOIN inflight ${key}`);
        return existing;
    }

    const work = (async () => {
        if (!forceRefresh) {
            try {
                const lastSync = await getCacheAge();
                if (lastSync && isCacheFresh(lastSync)) {
                    const cached = await readCachedPos(daysBack);
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
    })();

    _inflightByKey.set(key, work);
    try {
        return await work;
    } finally {
        _inflightByKey.delete(key);
    }
}

function timeAgo(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
}
