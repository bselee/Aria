/**
 * @file    pending-reorder.ts
 * @purpose Cross-panel SKU link: an undrafted Ordering recommendation for a SKU,
 *          attached to the Active Purchases row of the open PO that carries it.
 * @author  Hermia
 * @created 2026-10-29
 * @deps    none
 * @env     none
 *
 * DECISION(2026-10-29, Bill, WS6.3): Active Purchases and Ordering tell one
 * story about the same PO. PO 125283 (900 x RAP101, silent 50d) needs "resolve
 * this PO first"; RAP101 also has an undrafted recommendation saying "order 900
 * more". Both statements are true and belong on the same row, so the row reads
 * "resolve PO 125283 first ... / reorder pending 900 RAP101" instead of the two
 * panels contradicting each other.
 *
 * A recommendation is PENDING when it has never been drafted, i.e.
 * `qty_recommendations.resulting_po_number IS NULL`. Once a rec is stamped with
 * the PO that consumed it, the reorder is no longer pending and nothing is
 * attached. Kept pure and dependency-free so the rules get unit tests.
 */

/** What the Active Purchases row shows: which SKU, how many, pending. */
export type PendingReorder = {
    /** Product id / SKU the recommendation is for (e.g. "RAP101"). */
    sku: string;
    /** Recommended order quantity. */
    qty: number;
};

/**
 * Lookback for "still pending". The scan rewrites a recommendation for every
 * SKU on each run, so a rec older than this is a stale snapshot no human is
 * about to act on — naming it would be noise, not a pending reorder.
 */
export const PENDING_REORDER_LOOKBACK_DAYS = 7;

/** One `qty_recommendations` row, as read for the pending-reorder overlay. */
export type RecommendationRow = {
    product_id?: string | null;
    recommended_qty?: number | string | null;
    recommended_at?: string | null;
};

/**
 * Index undrafted recommendations by SKU.
 *
 * The newest row per SKU wins — the scan writes a fresh snapshot every run, and
 * only the latest says what should be ordered *now*. Rows with no usable SKU or
 * a non-positive quantity are dropped (a "pending reorder of 0" is not a
 * reorder). Assumes rows already filtered to `resulting_po_number IS NULL` and
 * the lookback window by the caller.
 *
 * @param rows Undrafted recommendation rows (any order).
 * @returns    SKU → pending reorder. Empty when nothing is pending.
 */
export function derivePendingReordersBySku(
    rows: RecommendationRow[] | null | undefined,
): Map<string, PendingReorder> {
    const bySku = new Map<string, PendingReorder>();
    const newestAt = new Map<string, number>();

    for (const row of rows ?? []) {
        const sku = String(row?.product_id ?? "").trim();
        if (!sku) continue;
        const qty = Math.max(0, Number(row?.recommended_qty) || 0);
        if (qty <= 0) continue;

        const at = row?.recommended_at ? Date.parse(row.recommended_at) : NaN;
        const stamp = Number.isFinite(at) ? at : -Infinity;
        const prev = newestAt.get(sku);
        if (prev !== undefined && prev > stamp) continue;

        newestAt.set(sku, stamp);
        bySku.set(sku, { sku, qty });
    }

    return bySku;
}

/**
 * The pending reorder for a PO's line items, if any line's SKU has one.
 *
 * A PO is per vendor, not per SKU, so one PO can carry several SKUs; the first
 * line with a pending recommendation names the row (a row can only show one
 * "reorder pending" chip, and any of them is the same conversation).
 *
 * @param items PO line items (`productId` is the SKU in Finale/Ordering terms).
 * @param bySku Output of derivePendingReordersBySku.
 * @returns     The pending reorder, or undefined when no line is pending.
 */
export function findPendingReorder(
    items: Array<{ productId?: string | null }> | null | undefined,
    bySku: Map<string, PendingReorder> | null | undefined,
): PendingReorder | undefined {
    if (!items?.length || !bySku || bySku.size === 0) return undefined;
    for (const item of items) {
        const sku = String(item?.productId ?? "").trim();
        if (!sku) continue;
        const hit = bySku.get(sku);
        if (hit) return hit;
    }
    return undefined;
}
