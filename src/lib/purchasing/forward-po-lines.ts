/**
 * @file    forward-po-lines.ts
 * @purpose Pick meaningful draft-PO lines from the visible ordering window.
 *          TODAY-only "decision === order" missed 30/60/90 items you already
 *          opened the vendor to buy. Qty honors the operator override.
 * @author  Hermia
 * @created 2026-08-14
 * @deps    dashboard-focus
 */

import {
    canIncludeInDraftPO,
    itemMatchesOrderingFocus,
    type OrderingFocusFilter,
} from "./dashboard-focus";

export interface ForwardPoCandidate {
    productId: string;
    suggestedQty: number;
    unitPrice: number;
    orderIncrementQty?: number | null;
    isBulkDelivery?: boolean;
    leadTimeDays?: number | null;
    effectiveLeadTimeDays?: number | null;
    reorderMethod?: Parameters<typeof canIncludeInDraftPO>[0];
    draftPO?: { orderId?: string } | null;
    assessment?: { decision?: string; recommendedQty?: number } | null;
    runwayDays?: number;
    adjustedRunwayDays?: number;
    finaleStockoutDays?: number | null;
    urgency?: "critical" | "warning" | "watch" | "ok";
}

export interface ForwardPoLine {
    productId: string;
    quantity: number;
    unitPrice: number;
    orderIncrementQty: number | null;
    isBulkDelivery: boolean;
    leadTimeDays: number | null;
}

export interface SelectForwardPoLinesArgs {
    items: ForwardPoCandidate[];
    focus: OrderingFocusFilter;
    qtyOverrides?: Record<string, number>;
    isSnoozed?: (productId: string) => boolean;
    isCovered?: (item: ForwardPoCandidate) => boolean;
    checked?: Record<string, boolean>;
    requireChecked?: boolean;
}

function lineQty(item: ForwardPoCandidate, overrides?: Record<string, number>): number {
    const override = overrides?.[item.productId];
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
        return Math.round(override);
    }
    const assessed = item.assessment?.recommendedQty;
    if (typeof assessed === "number" && assessed > 0) return Math.round(assessed);
    if (item.suggestedQty > 0) return Math.round(item.suggestedQty);
    return 0;
}

/**
 * Lines that belong on a forward-looking vendor draft.
 * Prefers the visible window. If the operator checked rows, those win
 * (even reduce). Otherwise include order + reduce in the window.
 */
export function selectForwardPoLines(args: SelectForwardPoLinesArgs): ForwardPoLine[] {
    const {
        items,
        focus,
        qtyOverrides,
        isSnoozed,
        isCovered,
        checked,
        requireChecked,
    } = args;

    const eligible = items.filter(item => {
        if (isSnoozed?.(item.productId)) return false;
        if (!canIncludeInDraftPO(item.reorderMethod)) return false;
        if (item.draftPO) return false;
        if (isCovered?.(item)) return false;
        return true;
    });

    const checkedIds = eligible.filter(i => checked?.[i.productId]);
    const pool = requireChecked || checkedIds.length > 0 ? checkedIds : eligible.filter(item => {
        const decision = item.assessment?.decision;
        if (decision !== "order" && decision !== "reduce") return false;
        return itemMatchesOrderingFocus({
            urgency: item.urgency ?? "ok",
            runwayDays: item.runwayDays ?? Number.POSITIVE_INFINITY,
            adjustedRunwayDays: item.adjustedRunwayDays,
            finaleStockoutDays: item.finaleStockoutDays,
            leadTimeDays: item.effectiveLeadTimeDays ?? item.leadTimeDays ?? null,
            assessment: { decision: decision as "order" | "reduce" },
        }, focus);
    });

    return pool
        .map(item => {
            const quantity = lineQty(item, qtyOverrides);
            return {
                productId: item.productId,
                quantity,
                unitPrice: item.unitPrice,
                orderIncrementQty: item.orderIncrementQty ?? null,
                isBulkDelivery: item.isBulkDelivery ?? false,
                leadTimeDays: item.effectiveLeadTimeDays ?? item.leadTimeDays ?? null,
            };
        })
        .filter(line => line.quantity > 0);
}

/**
 * Single-SKU vendor: use the truck size. Multi-SKU: leave window qtys.
 */
export function applyTruckQty(lines: ForwardPoLine[], truckQty?: number | null): ForwardPoLine[] {
    if (!truckQty || truckQty <= 0 || lines.length !== 1) return lines;
    return [{ ...lines[0], quantity: Math.round(truckQty) }];
}
