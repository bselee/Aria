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
