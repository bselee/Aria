/**
 * @file    src/lib/purchasing/order-sanity.ts
 * @purpose Sanity flag for recommended order quantities (Phase 2.2 of the
 *          ordering-engine cleanup). Flags a recommendation that exceeds
 *          3x the median of the SKU's last few ACTUAL order quantities.
 *
 *          FLAG ONLY, NEVER SUPPRESS: a deliberate buy-up must still render
 *          its quantity — the flag is advisory context for the human, not a
 *          gate. Computed at render time in /api/dashboard/purchasing; there
 *          is deliberately no watcher cron.
 *
 *          History source: local purchase_orders.line_items (po-finale-sync
 *          maintained). A SKU with no history is never flagged — there is
 *          nothing to compare against.
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    none (pure)
 */

/** Compare against the last N actual orders (plan: median of last 3-5). */
export const SANITY_WINDOW = 5;
export const SANITY_FACTOR = 3;

export interface SanityFlag {
    /** True when recommendedQty > 3x the median of recent actual orders. */
    flag: boolean;
    /** Human-readable detail for the badge tooltip; empty when unflagged. */
    detail: string;
}

/**
 * Pure sanity computation — fixture-testable.
 *
 * @param recommendedQty  The recommended order quantity for the SKU.
 * @param recentOrderQtys Quantities of the SKU's recent ACTUAL orders, newest
 *                        first (order direction does not matter to the median).
 */
export function sanityFlagQty(
    recommendedQty: number | null | undefined,
    recentOrderQtys: Array<number | null | undefined>,
): SanityFlag {
    const qty = typeof recommendedQty === "number" && Number.isFinite(recommendedQty) && recommendedQty > 0
        ? recommendedQty
        : null;
    // Median is inherently robust: a single fill-in or one-off bulk order does
    // not skew it. Deliberate buy-ups still flag — but keep their quantity.
    const window = recentOrderQtys
        .filter((q): q is number => typeof q === "number" && Number.isFinite(q) && q > 0)
        .slice(0, SANITY_WINDOW)
        .sort((a, b) => a - b);
    if (qty == null || window.length === 0) return { flag: false, detail: "" };

    const mid = Math.floor(window.length / 2);
    const median = window.length % 2 === 1
        ? window[mid]
        : (window[mid - 1] + window[mid]) / 2;

    if (qty <= SANITY_FACTOR * median) return { flag: false, detail: "" };
    return {
        flag: true,
        detail: `Recommended ${Math.round(qty).toLocaleString()} is ${Math.round((qty / median) * 10) / 10}x the median of the last ${window.length} order${window.length === 1 ? "" : "s"} (${Math.round(median).toLocaleString()}). Verify before committing.`,
    };
}
