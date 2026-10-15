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

// ──────────────────────────────────────────────────────────────────────────
// AGED-PO ANOMALY
// ──────────────────────────────────────────────────────────────────────────

/**
 * An open PO this many days old is an anomaly regardless of lead time.
 * Bill (2026-10-15): "POs this old need to be assessed. Items rarely take this
 * long and should be treated as an anomaly."
 */
export const PO_ANOMALY_FLOOR_DAYS = 45;

/** Multiple of the vendor lead time past which an open PO stops being credible. */
export const PO_ANOMALY_LEAD_MULTIPLE = 2;

/**
 * Age of an order in days. Accepts BOTH date shapes this code sees: Finale's
 * `2026-02-11T18:00:00` and the scan's `2/11/2026`.
 *
 * @param orderDate Order date string, either shape.
 * @param now       Clock override for tests.
 * @returns         Whole days since the order, or null when unparseable.
 */
export function poAgeDays(orderDate: string | null | undefined, now: number = Date.now()): number | null {
    const raw = String(orderDate ?? "").trim();
    if (!raw) return null;
    let ms: number | null = null;
    // ISO shape (Finale): 2026-02-11T18:00:00
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const parsed = Date.parse(raw.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
        ms = Number.isFinite(parsed) ? parsed : null;
    } else {
        // M/D/YYYY shape (scan openPOs).
        const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) {
            const parsed = Date.parse(
                `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}T00:00:00Z`,
            );
            ms = Number.isFinite(parsed) ? parsed : null;
        }
    }
    if (ms === null) return null;
    return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

/**
 * Days past which an open PO for this product is no longer credible inbound
 * supply: the greater of the floor and twice the vendor's lead time, so a
 * genuinely long-lead bulk order (120d lead) is not flagged at 154 days.
 *
 * @param leadTimeDays Vendor lead time in days; 0/unknown falls back to the floor.
 */
export function poAnomalyThresholdDays(leadTimeDays?: number | null): number {
    const lead = Number.isFinite(leadTimeDays) ? Math.max(0, Number(leadTimeDays)) : 0;
    return Math.max(PO_ANOMALY_FLOOR_DAYS, PO_ANOMALY_LEAD_MULTIPLE * lead);
}

/**
 * Is this open PO an anomaly that must be assessed rather than counted as cover?
 *
 * THE PRINCIPLE: cover has to be evidenced. A PO still open long past the window
 * in which that item could plausibly arrive is not future supply, whatever
 * Finale's status says. DASH101's 125349 sat ORDER_LOCKED for 246 days and
 * suppressed a reorder while its shelf drained.
 *
 * An unparseable or missing order date is NOT treated as anomalous: absence of
 * evidence about age is not evidence of staleness.
 *
 * @param orderDate    PO order date.
 * @param leadTimeDays Vendor lead time for this product.
 * @param now          Clock override for tests.
 */
export function isAnomalousOpenPo(
    orderDate: string | null | undefined,
    leadTimeDays?: number | null,
    now: number = Date.now(),
): boolean {
    const age = poAgeDays(orderDate, now);
    if (age === null) return false;
    return age > poAnomalyThresholdDays(leadTimeDays);
}

/**
 * Split merged open POs into credible cover and anomalies.
 *
 * @param openPOs      Merged open POs (GraphQL + recent-coverage hits).
 * @param leadTimeDays Vendor lead time for this product.
 * @param now          Clock override for tests.
 * @returns            `credible` (usable as cover) and `anomalous` (assess).
 */
export function partitionOpenPOsByAnomaly<T extends { orderDate?: string }>(
    openPOs: T[] | null | undefined,
    leadTimeDays?: number | null,
    now: number = Date.now(),
): { credible: T[]; anomalous: Array<T & { ageDays: number }> } {
    const credible: T[] = [];
    const anomalous: Array<T & { ageDays: number }> = [];
    for (const po of openPOs ?? []) {
        if (isAnomalousOpenPo(po?.orderDate, leadTimeDays, now)) {
            anomalous.push({ ...po, ageDays: poAgeDays(po.orderDate, now) ?? 0 });
        } else {
            credible.push(po);
        }
    }
    return { credible, anomalous };
}

/**
 * One-line reason for a row whose cover was excluded as stale, or "" when none.
 * Wording is deliberately actionable: it names the PO and says what to do.
 *
 * @param anomalous Anomalous POs from partitionOpenPOsByAnomaly.
 */
export function anomalousCoverNote(anomalous: Array<{ orderId?: string; ageDays: number }>): string {
    if (!anomalous.length) return "";
    const ordered = [...anomalous].sort((a, b) => b.ageDays - a.ageDays);
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    if (ordered.length === 1) {
        return `Anomaly: PO #${oldest.orderId} open ${oldest.ageDays}d, never received; not counted as cover. Assess in Finale.`;
    }
    const span = newest.ageDays === oldest.ageDays
        ? `${oldest.ageDays}d`
        : `${newest.ageDays}-${oldest.ageDays}d`;
    return `Anomaly: ${ordered.length} POs open ${span} (oldest #${oldest.orderId}), never received; not counted as cover. Assess in Finale.`;
}
