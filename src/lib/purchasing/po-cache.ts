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
import { createClient } from "../db";
import { isCanceledShipmentLeg } from "../finale/shipment-status";
import { CACHE_ACTIVE_STATUS_VALUES } from "./active-po-status";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function getCacheAge(): Promise<Date | null> {
    // No probe gate (2026-10-29): the root probe is slower than the query it
    // guards and failed intermittently, making a fresh cache look stale.
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
    // No probe gate (2026-10-29): the PostgREST root endpoint answers in
    // 1.2-1.4s on this host, so a 1.5s probe failed intermittently and the
    // cache was silently never written — receipts never reached the cache,
    // and Active Purchases said "need receive" while Receivings said received.
    // The batch upsert below fails safely on its own when PostgREST is down.
    const db = createClient();
    if (!db || pos.length === 0) return;

    const now = new Date().toISOString();
    // PGRST102 "All object keys must match": rows with a receive_date and rows
    // without cannot share a batch. Split them so no row is null-wiped and the
    // batch is accepted (2026-10-29 — this rejected EVERY cache write).
    const withRecv: Array<Record<string, unknown>> = [];
    const withoutRecv: Array<Record<string, unknown>> = [];
    const nullRecv: Array<Record<string, unknown>> = [];

    for (const po of pos) {
        const shipRecv = maxPastShipmentReceiveDate(po.shipments);
        // Prefer the shipment receipt date: Finale's PO-level receiveDate can
        // carry the UTC date of a same-day receipt (off by one day, 125394).
        // PO-level dates are only trusted when they are PAST — a future date is
        // a planned ETA, and writing it as a receipt would falsely mark a PO
        // received (Active Purchases collapsed to 4 rows before this guard).
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const poRecv = po.receiveDate && po.receiveDate.slice(0, 10) <= today ? po.receiveDate : null;
        const recv = shipRecv || poRecv || null;
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
        if (recv) {
            row.receive_date = recv;
            withRecv.push(row);
        } else if (po.receiveDate && po.receiveDate.slice(0, 10) > today) {
            // Self-heal: a stored FUTURE receive_date is a planned ETA and must
            // not survive as receipt evidence. Explicit null, never a silent wipe
            // of a real past receipt.
            row.receive_date = null;
            nullRecv.push(row);
        } else {
            withoutRecv.push(row);
        }
    }

    const flush = async (rows: Array<Record<string, unknown>>): Promise<void> => {
        for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            try {
                // postgrest-js does NOT throw on failure — it resolves with { error }.
                // Ignoring it made every cache write fail silently (2026-10-29).
                const { error } = await db.from("purchase_orders").upsert(batch, { onConflict: "po_number" });
                if (error) {
                    console.error(`[po-cache] batch upsert rejected (${batch.length} rows):`, error.message);
                }
            } catch (e) {
                console.error("[po-cache] batch upsert failed:", (e as Error).message);
            }
        }
    };

    await flush(withRecv);
    await flush(nullRecv);
    await flush(withoutRecv);
}

/** Latest past shipment receiveDate (YYYY-MM-DD), or null. Canceled legs are
 *  excluded: a canceled leg's date is not receipt evidence (125394-1 Canceled). */
function maxPastShipmentReceiveDate(
    shipments: FullPO["shipments"] | undefined,
): string | null {
    if (!shipments?.length) return null;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const past = shipments
        .filter((s) => !isCanceledShipmentLeg(s))
        .map((s) => (s.receiveDate || "").slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today);
    if (past.length === 0) return null;
    return past.sort().at(-1) || null;
}

export async function readCachedPos(daysBack = 60): Promise<FullPO[]> {
    const db = createClient();
    if (!db) return [];

    try {
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
        const cutoffStr = cutoff.toISOString().split("T")[0];

        const { data, error } = await db
            .from("purchase_orders")
            .select("*")
            .in("status", [...CACHE_ACTIVE_STATUS_VALUES])
            .gte("issue_date", cutoffStr)
            .order("issue_date", { ascending: false });

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
