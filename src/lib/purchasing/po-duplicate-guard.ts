/**
 * @file    po-duplicate-guard.ts
 * @purpose Failsafe: block draft PO creation when open/draft POs already cover requested SKUs.
 * @author  Hermia
 * @created 2026-07-10
 * @deps    none (pure)
 * @env     none
 */

export interface OpenPoLine {
    orderId: string;
    quantity: number;
    orderDate?: string;
    status?: string;
}

export interface DuplicateGuardItem {
    productId: string;
    quantity: number;
    /** Committed/locked open POs for this SKU (from Finale activity / openPOs). */
    openPOs?: OpenPoLine[];
    /** Draft PO already holding this SKU (ORDER_CREATED). */
    draftPO?: { orderId: string; quantity: number } | null;
}

export interface DuplicateBlock {
    productId: string;
    requestedQty: number;
    coveringOrderId: string;
    coveringQty: number;
    kind: "open_po" | "draft_po";
    reason: string;
}

export interface DuplicateGuardResult {
    ok: boolean;
    blocks: DuplicateBlock[];
    /** SKUs that are safe to include (not fully covered). */
    allowedProductIds: string[];
    summary: string;
}

/**
 * Pure failsafe: if open or draft PO qty already covers the requested line qty,
 * block unless the caller opts into forceTopUp.
 *
 * Coverage rule (fail-closed for re-order):
 * - sum(openPOs.quantity) >= requested quantity → block (open_po)
 * - draftPO.quantity >= requested quantity → block (draft_po)
 * - partial open qty < requested is allowed (true residual reorder shortfall)
 */
export function evaluateOpenPoDuplicateGuard(
    items: DuplicateGuardItem[],
    opts: { forceTopUp?: boolean } = {},
): DuplicateGuardResult {
    const forceTopUp = opts.forceTopUp === true;
    const blocks: DuplicateBlock[] = [];
    const allowedProductIds: string[] = [];

    for (const item of items) {
        const productId = String(item.productId);
        const requestedQty = Math.max(0, Number(item.quantity) || 0);
        if (!productId || requestedQty <= 0) {
            continue;
        }

        const openQty = (item.openPOs ?? []).reduce(
            (sum, po) => sum + Math.max(0, Number(po.quantity) || 0),
            0,
        );
        const primaryOpen = (item.openPOs ?? []).find(po => (po.quantity || 0) > 0)
            ?? item.openPOs?.[0];

        if (openQty >= requestedQty && openQty > 0 && primaryOpen) {
            blocks.push({
                productId,
                requestedQty,
                coveringOrderId: String(primaryOpen.orderId),
                coveringQty: openQty,
                kind: "open_po",
                reason: `Already on PO #${primaryOpen.orderId} (qty ${openQty}) covers requested ${requestedQty}. Use forceTopUp only for intentional extra.`,
            });
            continue;
        }

        const draftQty = Math.max(0, Number(item.draftPO?.quantity) || 0);
        if (item.draftPO && draftQty >= requestedQty && draftQty > 0) {
            blocks.push({
                productId,
                requestedQty,
                coveringOrderId: String(item.draftPO.orderId),
                coveringQty: draftQty,
                kind: "draft_po",
                reason: `Draft PO #${item.draftPO.orderId} already has qty ${draftQty} for this SKU. Review/commit that draft instead of creating another.`,
            });
            continue;
        }

        allowedProductIds.push(productId);
    }

    if (forceTopUp) {
        return {
            ok: true,
            blocks,
            allowedProductIds: items.map(i => String(i.productId)),
            summary: blocks.length > 0
                ? `forceTopUp: allowing ${blocks.length} covered SKU(s) as intentional extra reorder`
                : "forceTopUp: no open/draft coverage conflicts",
        };
    }

    if (blocks.length === 0) {
        return {
            ok: true,
            blocks: [],
            allowedProductIds,
            summary: "No open/draft PO coverage conflicts",
        };
    }

    const preview = blocks
        .slice(0, 3)
        .map(b => `${b.productId}→PO#${b.coveringOrderId}`)
        .join(", ");
    const more = blocks.length > 3 ? ` +${blocks.length - 3} more` : "";

    return {
        ok: false,
        blocks,
        allowedProductIds,
        summary: `Blocked ${blocks.length} SKU(s) already on open/draft PO: ${preview}${more}`,
    };
}
