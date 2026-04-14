import type { PurchasingDecision } from "./policy-types";
import type { FinaleReorderMethod } from "../finale/client";

export type OrderingFocusBucket = "today" | "week" | "later";

export type OrderingMethodPolicy = {
  manualOnly?: boolean;
  disableDirectOrder?: boolean;
  neverAutoSelect?: boolean;
};

type FocusItem = {
  urgency: "critical" | "warning" | "watch" | "ok";
  runwayDays: number;
  leadTimeDays: number | null;
  reorderMethod?: FinaleReorderMethod;
  assessment?: {
    decision?: PurchasingDecision;
  };
};

export function getOrderingFocusBucket(item: FocusItem): OrderingFocusBucket {
  const runwayDays = Number.isFinite(item.runwayDays) ? item.runwayDays : Number.POSITIVE_INFINITY;
  const leadTimeDays = item.leadTimeDays && item.leadTimeDays > 0 ? item.leadTimeDays : 7;

  if (item.urgency === "critical" && runwayDays <= leadTimeDays) {
    return "today";
  }
  if (item.urgency === "warning" && runwayDays <= leadTimeDays + 7) {
    return "week";
  }
  return "later";
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
