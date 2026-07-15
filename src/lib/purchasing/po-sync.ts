/**
 * @file    po-sync.ts
 * @purpose Keep the local purchase_orders table in sync with Finale. Pulls all
 *          recent POs (90-day window) and upserts them with complete data:
 *          vendor_name, vendor_party_id, total_amount, status, issue_date,
 *          line_items. This is the foundation for invoice→PO matching —
 *          without a complete PO mirror, matching is impossible.
 *
 *          Also normalizes vendor names using vendor_aliases to bridge the
 *          gap between Finale vendor names and OCR-extracted vendor names
 *          from invoices.
 *
 *          Runs as a cron job every 2 hours. Idempotent — upsert on po_number.
 *
 * @author  Hermia
 * @created 2026-07-14
 */

import { createClient } from "../db";
import { FinaleClient } from "../finale/client";

export interface POSyncStats {
    synced: number;
    newPOs: number;
    updatedPOs: number;
    errors: number;
}

/**
 * Sync purchase orders from Finale into the local purchase_orders table.
 * Pulls POs from the last `daysBack` days (default 90) and upserts them.
 */
export async function syncPurchaseOrders(daysBack = 90): Promise<POSyncStats> {
    const db = createClient();
    const finale = new FinaleClient();
    const stats: POSyncStats = { synced: 0, newPOs: 0, updatedPOs: 0, errors: 0 };

    if (!db) {
        console.warn("[po-sync] DB unavailable — skipping");
        return stats;
    }

    // Get existing PO numbers to detect new vs updated
    const { data: existing } = await db
        .from("purchase_orders")
        .select("po_number")
        .order("created_at", { ascending: false })
        .limit(5000);

    const existingSet = new Set((existing || []).map((r: any) => r.po_number));

    try {
        // Pull all POs from Finale (includes Committed, Open, Received, Completed, Cancelled)
        const pos = await finale.getRecentPurchaseOrders(daysBack, 1000);
        console.log(`[po-sync] Fetched ${pos.length} POs from Finale (${daysBack}d window)`);

        for (const po of pos) {
            try {
                const isNew = !existingSet.has(po.orderId);

                await db.from("purchase_orders").upsert({
                    po_number: po.orderId,
                    vendor_name: po.vendorName || null,
                    vendor_party_id: (po as any).vendorPartyId || null,
                    status: normalizePOStatus(po.status),
                    issue_date: po.orderDate || null,
                    total_amount: po.total || 0,
                    line_items: po.items || [],
                    updated_at: new Date().toISOString(),
                }, { onConflict: "po_number" });

                stats.synced++;
                if (isNew) stats.newPOs++;
                else stats.updatedPOs++;
            } catch (err: any) {
                stats.errors++;
                if (stats.errors <= 3) {
                    console.warn(`[po-sync] Failed to upsert PO ${po.orderId}: ${err.message}`);
                }
            }
        }
    } catch (err: any) {
        console.error("[po-sync] Finale fetch failed:", err.message);
        stats.errors++;
    }

    console.log(
        `[po-sync] Done: ${stats.synced} synced (${stats.newPOs} new, ${stats.updatedPOs} updated, ${stats.errors} errors)`,
    );

    return stats;
}

/**
 * Normalize Finale status strings to our simpler enum.
 */
function normalizePOStatus(status: string): string {
    const s = (status || "").toLowerCase();
    if (s.includes("cancel")) return "closed";
    if (s.includes("complete") || s.includes("received")) return "received";
    if (s.includes("partial")) return "partial";
    if (s.includes("commit") || s.includes("open") || s.includes("draft")) return "open";
    return "open";
}
