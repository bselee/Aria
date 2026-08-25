/**
 * @file    src/lib/purchasing/ordering-row-copy.ts
 * @purpose Compact Ordering-row copy: discreet draft labels and a one-line
 *          justification for why a draft PO would be (or was) created.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    none (pure)
 * @env     none
 */

export interface DraftPoRef {
    orderId: string;
    orderDate?: string | null;
    quantity?: number | null;
    autoDrafted?: boolean;
}

export interface OrderDraftJustificationInput {
    suggestedQty: number;
    lastPurchaseQty?: number | null;
    runwayDays: number;
    leadTimeDays: number;
    dailyRate?: number | null;
    draftPO?: DraftPoRef | null;
    recommendation?: {
        provenance?: Array<{ step: string; detail?: string }>;
    } | null;
}

/**
 * Discreet draft token. PO 125192 → "PO125192 Draft".
 */
export function formatPoDraftLabel(orderId: string | null | undefined): string {
    const n = String(orderId ?? "").replace(/^PO[-\s]?/i, "").trim();
    return n ? `PO${n} Draft` : "Draft";
}

function shortDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

function floorTag(provenance: Array<{ step: string }> | undefined): string | null {
    const steps = new Set((provenance ?? []).map((p) => p.step));
    if (steps.has("freight_sizing")) return "FTL";
    if (steps.has("last_purchase_floor") || steps.has("cover_floor")) {
        if (steps.has("last_purchase_floor")) return "last-order floor";
        return "30d floor";
    }
    if (steps.has("historical_floor") || steps.has("standard_order_floor")) return "history floor";
    return null;
}

/**
 * One-line reason to draft. Existing draft wins; otherwise qty + last order +
 * runway vs lead. No essays.
 */
export function orderDraftJustification(input: OrderDraftJustificationInput): string {
    const draft = input.draftPO;
    if (draft?.orderId) {
        const bits = [formatPoDraftLabel(draft.orderId)];
        if (draft.quantity != null && draft.quantity > 0) {
            bits.push(Math.round(draft.quantity).toLocaleString());
        }
        const when = shortDate(draft.orderDate);
        if (when) bits.push(when);
        return bits.join(" · ");
    }

    const qty = Math.round(input.suggestedQty);
    const bits: string[] = [];
    if (qty > 0) bits.push(`order ${qty}`);
    if (input.lastPurchaseQty != null && input.lastPurchaseQty > 0) {
        bits.push(`last ${Math.round(input.lastPurchaseQty)}`);
    }
    const runway = Number.isFinite(input.runwayDays) ? Math.round(input.runwayDays) : null;
    const lead = Number.isFinite(input.leadTimeDays) ? Math.round(input.leadTimeDays) : null;
    if (runway != null && lead != null) {
        bits.push(`${runway}d vs ${lead}d lead`);
    } else if (runway != null) {
        bits.push(`${runway}d on hand`);
    }
    const tag = floorTag(input.recommendation?.provenance);
    if (tag) bits.push(tag);
    return bits.join(" · ");
}

/** Vendors that must never receive autonomy_level >= 1. */
export const NEVER_AUTONOMOUS_VENDORS = [
    "organics alive",
    "asle",
    "colorful",
    "pacific bioproducts",
    "surepack",
    "alaska sea",
] as const;

/**
 * True when the vendor is on the hard exclusion list (prepay / foreign /
 * long-lead / co-pack). CYC is matched as a word so "bicycle" does not lock.
 */
export function isNeverAutonomous(vendorName: string | null | undefined): boolean {
    const n = (vendorName ?? "").toLowerCase();
    if (!n.trim()) return false;
    if (/(^|[^a-z])cyc([^a-z]|$)/.test(n)) return true;
    return NEVER_AUTONOMOUS_VENDORS.some((needle) => n.includes(needle));
}

export function denverYmd(now: Date = new Date()): string {
    return now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

export function isDateTodayDenver(iso: string | null | undefined, now: Date = new Date()): boolean {
    if (!iso) return false;
    return iso.slice(0, 10) === denverYmd(now);
}

export function isAutoDraftToday(
    draftPO: DraftPoRef | null | undefined,
    now: Date = new Date(),
): boolean {
    return Boolean(draftPO?.autoDrafted && draftPO.orderId && isDateTodayDenver(draftPO.orderDate, now));
}

export interface OrderingListItem {
    draftPO?: DraftPoRef | null;
    openPOs?: Array<unknown> | null;
    stockOnOrder?: number | null;
    assessment?: { decision?: string; reasonCodes?: string[] } | null;
}

/**
 * Ordering lists need-to-order lines, plus auto-drafts created today.
 * Already on order (committed, old drafts, topping) is hidden.
 */
export function shouldListOnOrdering(item: OrderingListItem, now: Date = new Date()): boolean {
    if (isAutoDraftToday(item.draftPO, now)) return true;
    const reasons = item.assessment?.reasonCodes ?? [];
    if (reasons.includes("on_order_already_covers_need") || reasons.includes("recent_draft_exists")) {
        return false;
    }
    if (item.draftPO) return false;
    if ((item.openPOs?.length ?? 0) > 0) return false;
    if ((item.stockOnOrder ?? 0) > 0) return false;
    const decision = item.assessment?.decision;
    return decision === "order" || decision === "reduce";
}

