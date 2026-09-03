/**
 * @file    finale-receipt-sync.ts
 * @purpose Finale receipt sync — the RECEIPT LEG for three-way match.
 *
 *          Polls Finale for POs with physical receipt evidence (shipment
 *          receiveDate + per-line receipt items), computes per-PO ordered vs
 *          received totals, and upserts into the PG `po_receipt_data` table.
 *
 *          WHY THIS EXISTS (audit 2026-08-11 A-11 / U04):
 *          ap_receiving_variance_analysis had 19 vendor rows, all NULL — the
 *          receipt leg was never populated. The variance/short-ship views now
 *          source from po_receipt_data, so this sync is what makes three-way
 *          match and short-ship detection actually work.
 *
 *          CRITICAL: received quantities come from Finale SHIPMENT DETAIL
 *          receipt items (getShipmentReceiptItems), NOT from PO status. Finale
 *          auto-completes POs on quantity match, so status="Completed" is not
 *          proof of physical receipt. Only actual shipment receipt data counts.
 *
 * @author  Hermia
 * @created 2026-08-12
 * @deps    finale/client, finale/core-client, db
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL, PGRST_URL
 */

import { createClient } from "@/lib/db";
import { finaleClient } from "@/lib/finale/client";
import {
    getShipmentReceiptItems,
    isWarehouseReceivingOrder,
} from "@/lib/finale/core-client";

/** POs processed per run — bounds Finale API time (500ms serial interval). */
const MAX_POS_PER_RUN = 60;
/** Skip POs whose last sync is newer than this (cron runs every 30m). */
const FRESH_MS = 30 * 60 * 1000;

/**
 * True only when a date is a CONCRETE PAST receipt date.
 * Finale mis-stores planned ETAs in receiveDate (observed: Oct 31 on a July
 * order, 2026-08-21 on an Aug order) — a FUTURE date is never proof of
 * physical receipt. Same guard as po-receipt-state.sanitizeReceiveDate.
 */
export function isConcretePastDate(value: string | null | undefined): boolean {
    if (!value) return false;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() <= Date.now();
}

/** A PO has receipt evidence only when a receiveDate is a past, real date. */
export function hasReceiptEvidence(po: {
    receiveDate?: string | null;
    shipments?: Array<{ receiveDate?: string | null }> | null;
}): boolean {
    if (isConcretePastDate(po.receiveDate)) return true;
    return (po.shipments || []).some((s) => isConcretePastDate(s.receiveDate));
}

export interface ReceiptLine {
    sku: string;
    ordered: number;
    received: number;
}

export interface ReceiptSyncResult {
    scanned: number;
    withReceipts: number;
    upserted: number;
    skippedFresh: number;
    errors: number;
    details: string[];
}

/** Per-PO receipt facts before the DB write — pure shape for tests. */
export interface POReceiptFacts {
    po_number: string;
    vendor_name: string;
    total_ordered: number;
    total_received: number;
    units_short: number;
    fully_received: boolean;
    last_receipt_date: string | null;
    line_items: ReceiptLine[];
}

/**
 * Compute receipt facts for a single PO given its ordered items and the
 * raw shipment detail payloads (already fetched). Pure — no I/O.
 */
export function computePOReceiptFacts(
    po: { orderId: string; vendorName?: string; items?: Array<{ productId: string; quantity: number }> },
    shipmentDetails: any[],
): POReceiptFacts {
    const orderedBySku = new Map<string, number>();
    for (const item of po.items || []) {
        const sku = item.productId;
        if (!sku) continue;
        orderedBySku.set(sku, (orderedBySku.get(sku) ?? 0) + Number(item.quantity ?? 0));
    }

    const receivedBySku = new Map<string, number>();
    let lastReceiptDate: string | null = null;
    for (const shipment of shipmentDetails) {
        if (!shipment) continue;
        // Shipment receipt date — concrete evidence. Only PAST dates count:
        // Finale also carries planned future receiveDates on committed POs.
        // Date extraction: take the YYYY-MM-DD prefix AS-IS (Finale UI display
        // date) — a naive new Date().toISOString() shifts local 18:00 timestamps
        // into the NEXT day's UTC date (+1 day drift, observed 2026-08-12 vs
        // Finale 08-11 on PO 125169). Same guard as po-receipt-state.
        const rcv = shipment.receiveDate || shipment.lastUpdatedDate || shipment.createdDate || null;
        if (isConcretePastDate(rcv)) {
            const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(rcv));
            const iso = match ? match[1] : new Date(rcv).toISOString().slice(0, 10);
            if (!lastReceiptDate || iso > lastReceiptDate) lastReceiptDate = iso;
        }
        for (const item of getShipmentReceiptItems(shipment)) {
            receivedBySku.set(item.productId, (receivedBySku.get(item.productId) ?? 0) + Number(item.quantity ?? 0));
        }
    }

    let totalOrdered = 0;
    let totalReceived = 0;
    const skus = new Set<string>([...orderedBySku.keys(), ...receivedBySku.keys()]);
    const lineItems: ReceiptLine[] = [];
    for (const sku of skus) {
        const ordered = orderedBySku.get(sku) ?? 0;
        const received = receivedBySku.get(sku) ?? 0;
        totalOrdered += ordered;
        totalReceived += received;
        lineItems.push({ sku, ordered, received });
    }

    return {
        po_number: po.orderId,
        vendor_name: po.vendorName ?? "Unknown",
        total_ordered: totalOrdered,
        total_received: totalReceived,
        units_short: Math.max(0, totalOrdered - totalReceived),
        fully_received: totalOrdered > 0 && totalReceived >= totalOrdered - 0.01,
        last_receipt_date: lastReceiptDate,
        line_items: lineItems,
    };
}

/**
 * Sync Finale receipt data into PG po_receipt_data.
 *
 * Flow:
 *   1. getRecentPurchaseOrders(daysBack) — cheap GraphQL list (ordered items,
 *      receiveDate, shipments with receiveDate).
 *   2. Filter to warehouse receiving POs with receipt evidence (receiveDate
 *      OR any shipment receiveDate).
 *   3. Freshness gate: skip POs synced within FRESH_MS (fetched_at check).
 *   4. Per PO: getOrderSummary → shipmentUrls → getShipmentDetails →
 *      getShipmentReceiptItems → computePOReceiptFacts → upsert.
 *
 * Never throws — returns a structured result. Bounded by MAX_POS_PER_RUN.
 */
export async function syncFinaleReceiptData(opts?: {
    daysBack?: number;
    limit?: number;
    maxPos?: number;
    force?: boolean;
}): Promise<ReceiptSyncResult> {
    const result: ReceiptSyncResult = {
        scanned: 0,
        withReceipts: 0,
        upserted: 0,
        skippedFresh: 0,
        errors: 0,
        details: [],
    };

    const db = createClient();
    if (!db) {
        console.warn("[finale-receipt-sync] No DB client — skipping sync");
        return result;
    }

    const daysBack = opts?.daysBack ?? 120;
    const limit = opts?.limit ?? 500;
    const maxPos = opts?.maxPos ?? MAX_POS_PER_RUN;

    try {
        const pos = await finaleClient.getRecentPurchaseOrders(daysBack, limit);
        result.scanned = pos.length;

        // Only warehouse receiving POs (drop Finale DropshipPO pseudo-orders)
        const candidates = pos.filter((p: any) => isWarehouseReceivingOrder(p.orderId));
        // Only POs with CONCRETE PAST receipt evidence — a future receiveDate
        // is a planned ETA, not a physical receipt (po-receipt-state guard).
        const withReceipts = candidates.filter((p: any) => hasReceiptEvidence(p));
        result.withReceipts = withReceipts.length;

        // Freshness gate — skip POs synced recently (unless forced).
        // Existing rows are ALWAYS loaded so backfill drains unknown POs first;
        // the freshness SKIP only applies on non-forced (cron) runs.
        let freshSet = new Set<string>();
        let knownRows: Array<{ po_number: string; fetched_at: string | null }> = [];
        try {
            const poNumbers = withReceipts.map((p: any) => p.orderId);
            const { data: existing } = await db
                .from("po_receipt_data")
                .select("po_number, fetched_at")
                .in("po_number", poNumbers);
            knownRows = (existing as any) || [];
            if (!opts?.force) {
                const cutoff = Date.parse(new Date(Date.now() - FRESH_MS).toISOString());
                freshSet = new Set(
                    knownRows
                        .filter((row) => row.fetched_at && Date.parse(row.fetched_at) > cutoff)
                        .map((row) => row.po_number),
                );
            }
        } catch (freshErr: any) {
            console.warn(`[finale-receipt-sync] Freshness check failed (proceeding): ${freshErr?.message || freshErr}`);
        }

        // Sort by receiveDate desc (most recent first), but DRAIN UN-SYNCED POs
        // first so a backfill pass covers every receipt instead of re-fetching
        // the same newest batch. Known (already-in-table) rows sort after.
        const knownSet = new Set<string>(knownRows.map((row) => row.po_number));
        const toProcess = withReceipts
            .filter((p: any) => !freshSet.has(p.orderId))
            .sort((a: any, b: any) => {
                const aKnown = knownSet.has(a.orderId) ? 1 : 0;
                const bKnown = knownSet.has(b.orderId) ? 1 : 0;
                if (aKnown !== bKnown) return aKnown - bKnown; // unknown first
                return String(b.receiveDate || "").localeCompare(String(a.receiveDate || ""));
            })
            .slice(0, maxPos);

        result.skippedFresh = withReceipts.length - toProcess.length;

        for (const po of toProcess) {
            try {
                const summary = await finaleClient.getOrderSummary(po.orderId);
                const shipmentDetails: any[] = [];
                for (const url of summary?.shipmentUrls || []) {
                    try {
                        shipmentDetails.push(await finaleClient.getShipmentDetails(url));
                    } catch (shipErr: any) {
                        console.warn(`[finale-receipt-sync] PO ${po.orderId} shipment ${url} detail failed: ${shipErr?.message || shipErr}`);
                    }
                }

                const facts = computePOReceiptFacts(po, shipmentDetails);

                const { error } = await db
                    .from("po_receipt_data")
                    .upsert({
                        po_number: facts.po_number,
                        vendor_name: facts.vendor_name,
                        total_ordered: facts.total_ordered,
                        total_received: facts.total_received,
                        units_short: facts.units_short,
                        fully_received: facts.fully_received,
                        last_receipt_date: facts.last_receipt_date,
                        line_items: facts.line_items,
                        fetched_at: new Date().toISOString(),
                    }, { onConflict: "po_number" });

                if (error) {
                    result.errors++;
                    result.details.push(`${po.orderId}: db error ${error.message || error}`);
                } else {
                    result.upserted++;
                    result.details.push(
                        `${po.orderId}: ${facts.total_received}/${facts.total_ordered} (${facts.units_short} short, ${facts.fully_received ? "full" : "partial"})`,
                    );
                }
            } catch (poErr: any) {
                result.errors++;
                result.details.push(`${po.orderId}: ${poErr?.message || poErr}`);
            }
        }

        console.log(
            `[finale-receipt-sync] scanned=${result.scanned} withReceipts=${result.withReceipts} ` +
            `upserted=${result.upserted} skippedFresh=${result.skippedFresh} errors=${result.errors}`,
        );
    } catch (err: any) {
        result.errors++;
        result.details.push(`sync failed: ${err?.message || err}`);
        console.warn(`[finale-receipt-sync] Error: ${err?.message || err}`);
    }

    return result;
}
