/**
 * @file    src/lib/purchasing/vendor-sku-bundle.ts
 * @purpose When a vendor is being ordered, scan every SKU of that vendor
 *          (Amazon excluded) and add near-term drips so we do not ship
 *          many tiny POs. Grassroots is the canonical case.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    ordering-row-copy
 * @env     none
 */

import { autoDraftQtyOk } from "./ordering-row-copy";

/** Remaining cover at or below this is pulled onto the open PO. */
export const CONSOLIDATE_WITHIN_DAYS = 90;

/** Preempt qty must not create more than this many days of supply. */
export const MAX_PREEMPT_COVER_DAYS = 90;

/** Floor days for a preempt qty (matches cover-floor target). */
export const PREEMPT_COVER_DAYS = 45;

/** No 1- and 5-each noise even when 30d math is tiny. */
export const MIN_PREEMPT_EACHES = 10;

export interface VendorBundleCandidate {
    productId: string;
    unitPrice: number;
    suggestedQty?: number | null;
    orderIncrementQty?: number | null;
    isBulkDelivery?: boolean;
    dailyRate?: number | null;
    runwayDays?: number | null;
    adjustedRunwayDays?: number | null;
    leadTimeDays?: number | null;
    stockOnOrder?: number | null;
    draftPO?: { orderId?: string } | null;
    openPOs?: Array<unknown> | null;
    assessment?: {
        decision?: string;
        recommendedQty?: number | null;
        reasonCodes?: string[] | null;
    } | null;
}

export interface VendorBundleLine {
    productId: string;
    quantity: number;
    unitPrice: number;
    orderIncrementQty: number | null;
    isBulkDelivery: boolean;
    leadTimeDays?: number | null;
    preempt?: boolean;
}

export function isAmazonVendor(vendorName: string | null | undefined): boolean {
    return /\bamazon\b/i.test(vendorName ?? "");
}

function remainingDays(item: VendorBundleCandidate): number {
    const values = [item.adjustedRunwayDays, item.runwayDays];
    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    }
    return Number.POSITIVE_INFINITY;
}

function dailyRateOf(item: VendorBundleCandidate): number {
    const r = Number(item.dailyRate);
    return Number.isFinite(r) && r > 0 ? r : 0;
}

function alreadyCovered(item: VendorBundleCandidate): boolean {
    if (item.draftPO?.orderId) return true;
    if ((item.openPOs?.length ?? 0) > 0) return true;
    if ((item.stockOnOrder ?? 0) > 0) return true;
    const reasons = item.assessment?.reasonCodes ?? [];
    return reasons.includes("on_order_already_covers_need") || reasons.includes("recent_draft_exists");
}

function roundIncrement(qty: number, increment: number | null | undefined): number {
    if (!increment || increment <= 1) return Math.ceil(qty);
    return Math.ceil(qty / increment) * increment;
}

function preemptQty(item: VendorBundleCandidate): number | null {
    const recommended = item.assessment?.recommendedQty ?? item.suggestedQty ?? 0;
    const rate = dailyRateOf(item);
    let qty = Number(recommended) > 0 ? Number(recommended) : 0;
    if (qty <= 0 && rate > 0) qty = rate * PREEMPT_COVER_DAYS;
    qty = roundIncrement(qty, item.orderIncrementQty);
    if (qty < MIN_PREEMPT_EACHES) return null;
    if (rate > 0 && qty / rate < 30) {
        qty = roundIncrement(rate * 30, item.orderIncrementQty);
    }
    if (rate > 0 && qty / rate > MAX_PREEMPT_COVER_DAYS) return null;
    if (!autoDraftQtyOk(qty, rate > 0 ? rate : 0)) return null;
    return qty;
}

/**
 * Amazon: leave the trigger lines alone, never add siblings.
 * Empty trigger: do not open a PO just to preempt.
 * Otherwise add every uncovered vendor SKU whose remaining cover is
 * within 90 days and whose qty is a real 30d buy (not 1/5 eaches).
 */
export function bundleVendorDraftLines(args: {
    vendorName: string;
    allItems: VendorBundleCandidate[];
    selected: VendorBundleLine[];
    allowPreempt?: boolean;
}): VendorBundleLine[] {
    const { vendorName, allItems, selected, allowPreempt = true } = args;
    if (isAmazonVendor(vendorName)) return selected.map((l) => ({ ...l, preempt: false }));
    if (selected.length === 0) return [];
    if (!allowPreempt) return selected.map((l) => ({ ...l, preempt: false }));

    const have = new Set(selected.map((l) => l.productId));
    const out: VendorBundleLine[] = selected.map((l) => ({ ...l, preempt: false }));

    for (const item of allItems) {
        if (have.has(item.productId)) continue;
        if (alreadyCovered(item)) continue;
        if (remainingDays(item) > CONSOLIDATE_WITHIN_DAYS) continue;
        const qty = preemptQty(item);
        if (qty == null) continue;
        have.add(item.productId);
        out.push({
            productId: item.productId,
            quantity: qty,
            unitPrice: item.unitPrice ?? 0,
            orderIncrementQty: item.orderIncrementQty ?? null,
            isBulkDelivery: item.isBulkDelivery ?? false,
            leadTimeDays: item.leadTimeDays ?? null,
            preempt: true,
        });
    }
    return out;
}

/** Drop preempt lines first if the running total would exceed cap. */
export function capBundledLines(lines: VendorBundleLine[], capUsd: number): VendorBundleLine[] {
    if (!(capUsd > 0)) return lines;
    const triggers = lines.filter((l) => !l.preempt);
    const preempts = lines.filter((l) => l.preempt);
    const triggerTotal = triggers.reduce((s, l) => s + l.quantity * (l.unitPrice || 0), 0);
    if (triggerTotal > capUsd) return triggers;
    const kept = [...triggers];
    let total = triggerTotal;
    for (const line of preempts) {
        const add = line.quantity * (line.unitPrice || 0);
        if (total + add > capUsd) continue;
        kept.push(line);
        total += add;
    }
    return kept;
}
