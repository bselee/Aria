/**
 * @file    active-po-status.ts
 * @purpose Shared Active Purchases status gate. Accepts BOTH Finale live
 *          vocab (committed/completed/partial) and po-sync normalized vocab
 *          (open/partial). Never admits normalized `received` or `closed`.
 * @author  Hermia
 * @created 2026-09-21
 * @deps    none
 */

/** Lowercased statuses that belong on the Active Purchases panel. */
export const ACTIVE_PO_STATUSES = new Set([
    "committed",
    "completed",
    "open",
    "partial",
]);

/**
 * Mixed-case values that actually sit in purchase_orders.status.
 * cacheFinalePos writes raw Finale (`Committed`); po-sync writes `open`.
 */
export const CACHE_ACTIVE_STATUS_VALUES = [
    "open",
    "partial",
    "Partial",
    "committed",
    "Committed",
    "completed",
    "Completed",
] as const;

/**
 * True when a PO status should appear in Active Purchases.
 * Case-insensitive. `received` is terminal — do not treat it as active.
 */
export function isActivePoStatus(status: string | null | undefined): boolean {
    return ACTIVE_PO_STATUSES.has((status || "").toLowerCase());
}
