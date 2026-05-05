import type { PurchasingDecision } from "./policy-types";
import type { FinaleReorderMethod } from "../finale/client";

/**
 * v2 ordering focus filter (2026-05-06): replaces the confusing
 * `today / week / later` taxonomy with planning windows that match how
 * purchasing actually thinks. Filters are cumulative — `60` includes
 * everything in `30` plus more — and counts use a single unit (item
 * count), not the prior item-vs-vendor mix.
 */
export type OrderingFocusFilter = "order_now" | "30" | "60" | "90" | "all";
export type OrderingFocusBucket = "order_now" | "30" | "60" | "90" | "later";

export type OrderingMethodPolicy = {
  manualOnly?: boolean;
  disableDirectOrder?: boolean;
  neverAutoSelect?: boolean;
};

type FocusItem = {
  urgency: "critical" | "warning" | "watch" | "ok";
  runwayDays: number;
  adjustedRunwayDays?: number;
  finaleStockoutDays?: number | null;
  leadTimeDays: number | null;
  reorderMethod?: FinaleReorderMethod;
  assessment?: {
    decision?: PurchasingDecision;
  };
};

/**
 * Effective shortage = "when does this SKU actually run out, given everything we
 * know?" Replaces raw `runwayDays` as the primary ordering score because
 * raw runway shows scary `0d` even when an open PO covers the gap. Precedence:
 *
 *   1. finaleStockoutDays (Finale's own projection — most authoritative)
 *   2. adjustedRunwayDays (on-hand + on-order)
 *   3. runwayDays (on-hand only)
 *   4. Infinity (no signal)
 */
export function getEffectiveShortageDays(item: FocusItem): number {
  const candidates = [
    item.finaleStockoutDays,
    item.adjustedRunwayDays,
    item.runwayDays,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** True when the recommender's policy engine flagged this row as actionable. */
function isActionable(item: FocusItem): boolean {
  const decision = item.assessment?.decision;
  return decision === "order" || decision === "reduce";
}

/**
 * Returns the ordering bucket this item belongs in. Used for *count display*
 * — what number sits on each filter pill. The cumulative match for a given
 * filter goes through `itemMatchesOrderingFocus`.
 */
export function getOrderingFocusBucket(item: FocusItem): OrderingFocusBucket {
  if (!isActionable(item)) return "later";

  const shortageDays = getEffectiveShortageDays(item);
  const leadTimeDays = item.leadTimeDays && item.leadTimeDays > 0 ? item.leadTimeDays : 7;

  if (item.urgency === "critical" || shortageDays <= leadTimeDays) return "order_now";
  if (shortageDays <= 30) return "30";
  if (shortageDays <= 60) return "60";
  if (shortageDays <= 90) return "90";
  return "later";
}

/**
 * True when the item belongs in the given filter window. Cumulative:
 * `90` includes `60`/`30`/`order_now`. `all` accepts every actionable
 * item. Non-actionable items (decision=hold, manual_review, etc.) are
 * excluded from every window — they belong on Other-Holds tab in the
 * lifecycle filter.
 */
export function itemMatchesOrderingFocus(item: FocusItem, filter: OrderingFocusFilter): boolean {
  if (!isActionable(item)) return false;
  if (filter === "all") return true;

  const shortageDays = getEffectiveShortageDays(item);
  const leadTimeDays = item.leadTimeDays && item.leadTimeDays > 0 ? item.leadTimeDays : 7;

  if (filter === "order_now") {
    return item.urgency === "critical" || shortageDays <= leadTimeDays;
  }
  return shortageDays <= Number(filter);
}

export function shouldAutoSelectItem(
  item: FocusItem,
  policy: OrderingMethodPolicy = {},
): boolean {
  if (!canIncludeInDraftPO(item.reorderMethod)) {
    return false;
  }
  if (policy.manualOnly || policy.neverAutoSelect) {
    return false;
  }

  const decision = item.assessment?.decision;
  return decision === "order" || decision === "reduce";
}

export function canIncludeInDraftPO(
  reorderMethod?: FinaleReorderMethod,
): boolean {
  return reorderMethod !== "do_not_reorder";
}

export function canUseDirectOrdering(
  vendorName: string,
  reorderMethod?: FinaleReorderMethod,
  policy: OrderingMethodPolicy = {},
): boolean {
  if (reorderMethod === "manual" || reorderMethod === "do_not_reorder" || reorderMethod === "on_site_order") {
    return false;
  }
  if (policy.manualOnly || policy.disableDirectOrder) {
    return false;
  }

  return vendorName.toLowerCase().includes("uline");
}
