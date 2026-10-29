/**
 * @file    src/lib/finale/shipment-status.ts
 * @purpose One predicate for "this shipment leg was canceled", shared by every
 *          surface that sums or lists Finale shipment legs.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    none (pure)
 *
 * WHY(2026-10-29): PO 125394 carries two legs — 125394-1 Canceled and 125394-2
 * Received 10/29. A canceled leg is not a receipt: it has no DELIVERED event and
 * no receiveDate, so receipt-date helpers fall back to createdDate and the leg
 * shows up as a receipt row; its line quantities inflate received totals and let
 * a short PO pass Complete; its (possibly stale) date poisons the cached
 * receive_date.
 *
 * Live shapes observed on 2026-10-29 (PO 125394):
 *   GraphQL `shipmentList` (feeds FullPO.shipments / the po cache):
 *     { shipmentId: "125394-1", status: "Canceled", receiveDate: null }
 *   REST `getShipmentDetails` (feeds receipt sums + receiptHistory):
 *     { shipmentId: "622959", status: undefined, statusId: "SHIPMENT_CANCELLED",
 *       cancelDate: "...", statusIdHistoryList: [..., {statusId:"SHIPMENT_CANCELLED"}] }
 * So the check reads status / statusId / statusLabel, never one fixed casing.
 */

const CANCEL_RE = /CANCEL/i;

function isCancelToken(value: unknown): boolean {
    return typeof value === "string" && CANCEL_RE.test(value);
}

/**
 * True when a shipment leg is canceled in any of Finale's shapes:
 * `status: "Canceled"`, `statusId: "SHIPMENT_CANCELLED"`, or a status history
 * whose latest event is a cancel. Accepts the raw leg or a bare status string.
 */
export function isCanceledShipmentLeg(leg: unknown): boolean {
    if (leg === null || leg === undefined) return false;
    if (typeof leg === "string") return isCancelToken(leg);
    if (typeof leg !== "object") return false;

    const record = leg as Record<string, unknown>;
    if (isCancelToken(record.statusId)) return true;
    if (isCancelToken(record.status)) return true;
    if (isCancelToken(record.statusLabel)) return true;

    // Backstop: the newest recorded status event is authoritative when the
    // top-level status fields are absent (REST docs omit `status` entirely).
    const history = record.statusIdHistoryList;
    if (Array.isArray(history) && history.length > 0) {
        const events = history as Array<Record<string, unknown>>;
        const newest = events.reduce((a, b) =>
            Number(b?.txStamp || 0) > Number(a?.txStamp || 0) ? b : a,
        );
        if (isCancelToken(newest?.statusId)) return true;
    }

    return false;
}
