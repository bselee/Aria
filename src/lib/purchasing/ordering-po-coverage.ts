/**
 * @file    ordering-po-coverage.ts
 * @purpose Overlay fresh Finale recent-PO coverage onto stale Ordering SWR rows.
 * @author  Hermia
 * @created 2026-08-06
 * @deps    none
 * @env     none
 *
 * DECISION(2026-08-06, Bill): After Order / draft+commit, SKUs must leave the
 * Ordering pane immediately. The full purchasing SWR rescan takes 12–15 min and
 * keeps serving pre-order need math. Every GET already fetches getRecentPurchaseOrders
 * fresh — use that as authoritative open-PO coverage for draft AND committed/
 * locked/sent POs (not drafts only). Once a PO is no longer draft, the old
 * draft-only overlay dropped coverage and the row "hung around".
 */

export type RecentPOLine = {
    productId: string;
    quantity: number;
};

export type RecentPOForCoverage = {
    orderId: string;
    status: string;
    orderDate?: string;
    receiveDate?: string | null;
    vendorName?: string;
    finaleUrl?: string;
    items?: RecentPOLine[];
};

export type OpenPOCoverageHit = {
    orderId: string;
    quantity: number;
    orderDate: string;
    status: string;
    isDraft: boolean;
    vendorName?: string;
    finaleUrl?: string;
};

export type ProductOpenCoverage = {
    totalQty: number;
    /** Best draft PO for this product (for "review/commit that draft" UI). */
    draft: OpenPOCoverageHit | null;
    /** Non-draft open hits (committed/locked/sent) for openPOs merge. */
    openHits: OpenPOCoverageHit[];
    /** All open hits (draft + committed). */
    allHits: OpenPOCoverageHit[];
};

/**
 * Terminal PO statuses — goods are done or void; do not suppress Ordering.
 */
export function isTerminalOrderingStatus(status: string): boolean {
    const s = (status || "").toLowerCase();
    return s.includes("cancel") || s.includes("complete");
}

/**
 * Draft / created — still needs commit, but counts as coverage so we don't double-order.
 */
export function isDraftOrderingStatus(status: string): boolean {
    const s = (status || "").toLowerCase();
    return s.includes("draft") || s.includes("created") || s === "order_created";
}

/**
 * Any non-terminal PO that still represents open inbound supply for Ordering.
 * Includes draft, committed, locked, sent, acknowledged, partial.
 */
export function isOpenOrderingStatus(status: string): boolean {
    if (isTerminalOrderingStatus(status)) return false;
    const s = (status || "").toLowerCase();
    if (!s) return true;
    return (
        isDraftOrderingStatus(status)
        || s.includes("commit")
        || s.includes("locked")
        || s.includes("sent")
        || s.includes("acknowledg")
        || s.includes("partial")
        || s.includes("open")
        || s.includes("pending")
    );
}

/**
 * Qty of a product on one recent PO line list.
 */
export function findProductQtyOnPO(po: RecentPOForCoverage, productId: string): number {
    const line = (po.items ?? []).find((i) => i.productId === productId);
    return Math.max(0, Number(line?.quantity) || 0);
}

/**
 * Index recent Finale POs by productId → open coverage qty + hits.
 * Skips terminal statuses. Does not require receiveDate null (blanket POs
 * can have a receiveDate while still open for remaining legs).
 */
export function buildRecentOpenCoverageByProduct(
    recentPOs: RecentPOForCoverage[],
): Map<string, ProductOpenCoverage> {
    const map = new Map<string, ProductOpenCoverage>();

    for (const po of recentPOs) {
        if (!po?.orderId || !isOpenOrderingStatus(po.status ?? "")) continue;
        const isDraft = isDraftOrderingStatus(po.status ?? "");
        for (const line of po.items ?? []) {
            if (!line?.productId) continue;
            const qty = Math.max(0, Number(line.quantity) || 0);
            if (qty <= 0) continue;

            const hit: OpenPOCoverageHit = {
                orderId: String(po.orderId),
                quantity: qty,
                orderDate: po.orderDate ?? "",
                status: po.status ?? "",
                isDraft,
                vendorName: po.vendorName,
                finaleUrl: po.finaleUrl,
            };

            let entry = map.get(line.productId);
            if (!entry) {
                entry = { totalQty: 0, draft: null, openHits: [], allHits: [] };
                map.set(line.productId, entry);
            }
            entry.totalQty += qty;
            entry.allHits.push(hit);
            if (isDraft) {
                // Prefer the newest/largest draft if multiple
                if (!entry.draft || hit.quantity >= entry.draft.quantity) {
                    entry.draft = hit;
                }
            } else {
                entry.openHits.push(hit);
            }
        }
    }

    return map;
}

/**
 * Merge GraphQL openPOs with recent-PO hits so the ribbon + coverage math
 * see the PO even when the slow product-activity scan is still stale.
 */
export function mergeOpenPOsWithRecentCoverage(
    existing: Array<{ orderId: string; quantity: number; orderDate: string }> | null | undefined,
    coverage: ProductOpenCoverage | undefined,
): Array<{ orderId: string; quantity: number; orderDate: string }> {
    const byId = new Map<string, { orderId: string; quantity: number; orderDate: string }>();
    for (const po of existing ?? []) {
        if (!po?.orderId) continue;
        byId.set(String(po.orderId), {
            orderId: String(po.orderId),
            quantity: Math.max(0, Number(po.quantity) || 0),
            orderDate: po.orderDate ?? "",
        });
    }
    for (const hit of coverage?.allHits ?? []) {
        const prev = byId.get(hit.orderId);
        if (!prev || hit.quantity > prev.quantity) {
            byId.set(hit.orderId, {
                orderId: hit.orderId,
                quantity: hit.quantity,
                orderDate: hit.orderDate,
            });
        }
    }
    return Array.from(byId.values());
}
