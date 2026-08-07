export interface POShipmentReceiptLike {
    status?: string | null;
    receiveDate?: string | null;
}

export interface POReceiptStateInput {
    status?: string | null;
    receiveDate?: string | null;
    shipments?: POShipmentReceiptLike[] | null;
}

/**
 * High-confidence "goods are here" signals used to DROP a PO from Active Purchases.
 * Active = open goods still tracking. Once high-conf received, leave Active —
 * Receivings / invoice-match / shipping-match own the rest (Bill 2026-08-06).
 *
 * STRICTER than carrier-delivered (delivered stays on Active as
 * DELIVERED·need receive until Finale receipt). BROADER than bare Finale
 * status=Completed (auto-set on qty match is NOT receipt proof alone).
 */
export interface HighConfidenceReceiptInput extends POReceiptStateInput {
    /** Canonical lifecycle stage if known (RECEIVED / RECONCILED / …) */
    lifecycleStage?: string | null;
    /** Matched invoice total (vendor_invoices / invoices), if any */
    matchedInvoiceTotal?: number | null;
    /** Invoice status: received | reconciled | matched | paid | … */
    matchedInvoiceStatus?: string | null;
    /** PO goods total for ±2% amount check */
    poTotal?: number | null;
    /** ISO date of order (YYYY-MM-DD) */
    orderDate?: string | null;
    /** ISO expected arrival used for "past ETA" gate */
    expectedDate?: string | null;
    /** True when pollPOReceivings / staff logged Finale receipt activity */
    finaleReceiptActivity?: boolean;
}

function normalizeDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (isoPrefix) return isoPrefix[1];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().split("T")[0];
}

function todayISO(): string {
    // Denver business day — Active Purchases is a Denver ops surface
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

/**
 * Drop far-future "receive" dates that are clearly planned ETAs mis-stored
 * in receive_date (observed: Oct 31 on a July order). Keep plausible dates.
 */
function sanitizeReceiveDate(
    value: string | null | undefined,
    orderDate: string | null | undefined,
): string | null {
    const d = normalizeDateOnly(value);
    if (!d) return null;
    const ord = normalizeDateOnly(orderDate);
    if (ord) {
        const ms = Date.parse(d) - Date.parse(ord);
        const days = ms / 86_400_000;
        // > 75 days after order as "receive" is almost never a real reception
        // for BAS lead times; treat as junk planned date.
        if (days > 75) return null;
    }
    return d;
}

export function resolvePurchaseOrderReceiptDate(input: POReceiptStateInput & { orderDate?: string | null }): string | null {
    // PO-level receiveDate — Finale sets this when a reception is created.
    // Guard: absurd far-future dates (planned ETAs misfiled as receiveDate)
    // are ignored. Real receptions land near order+lead, not +90d fantasies.
    const poLevelDate = sanitizeReceiveDate(input.receiveDate, input.orderDate ?? null);

    // Shipment receiveDates. Do NOT gate on the status string: Finale
    // auto-completes shipments when quantities match, so status is not proof
    // of receipt. The presence of a receiveDate is the concrete signal.
    const shipmentDates = (input.shipments || [])
        .map(s => sanitizeReceiveDate(s.receiveDate, input.orderDate ?? null))
        .filter((value): value is string => Boolean(value));

    const receiveDates: string[] = [];
    if (poLevelDate) receiveDates.push(poLevelDate);
    receiveDates.push(...shipmentDates);

    if (receiveDates.length === 0) return null;
    return receiveDates.sort().at(-1) || null;
}

export function hasPurchaseOrderReceipt(input: POReceiptStateInput & { orderDate?: string | null }): boolean {
    const normalizedStatus = String(input.status || "").toLowerCase();

    // Explicit staff action: changed PO status to "received"
    if (normalizedStatus === "received") return true;

    // Concrete evidence: Finale sets receiveDate when a receipt is created.
    // Unlike "Completed" status (which Finale auto-sets when quantities match),
    // receiveDate is only set by an actual reception — staff physically received goods.
    // Only trust past dates (future dates on Committed POs are planned ETAs).
    const receiptDate = resolvePurchaseOrderReceiptDate(input);
    if (receiptDate && receiptDate <= todayISO()) return true;

    // Shipment-level evidence:
    // 1) past receiveDate on any shipment, OR
    // 2) shipment status === Received (Finale marks this when staff received
    //    the shipment — Stock Bag 124895: status Completed, PO.receiveDate null,
    //    shipment status Received + receiveDate 2026-06-12).
    const shipments = input.shipments || [];
    if (shipments.length > 0) {
        const hasConcreteReceipt = shipments.some(s => {
            const st = String(s.status || "").toLowerCase();
            if (st === "received") return true;
            const date = sanitizeReceiveDate(s.receiveDate, input.orderDate ?? null);
            if (!date) return false;
            return date <= todayISO();
        });
        if (hasConcreteReceipt) return true;
    }

    return false;
}

/**
 * High-confidence goods-received decision for Active Purchases exit.
 *
 * true  → DROP from Active (hand off to Receivings / AP match)
 * false → keep on Active (still tracking or need Finale receive)
 */
export function isHighConfidenceReceived(input: HighConfidenceReceiptInput): boolean {
    // Hard signals first
    if (hasPurchaseOrderReceipt(input)) return true;

    const stage = String(input.lifecycleStage || "").toUpperCase();
    if (stage === "RECEIVED" || stage === "RECONCILED" || stage === "COMPLETED") {
        return true;
    }

    // Staff/Finale receipt activity (pollPOReceivings writes kind=finale_receipt)
    if (input.finaleReceiptActivity) return true;

    // Accurate matched invoice + past expected arrival:
    // goods are almost certainly on the dock; remaining work is AP, not tracking.
    const invStatus = String(input.matchedInvoiceStatus || "").toLowerCase();
    const invOk = ["received", "reconciled", "matched", "paid", "matched_review"].some(s =>
        invStatus.includes(s),
    );
    const invTotal = Number(input.matchedInvoiceTotal);
    const poTotal = Number(input.poTotal);
    const amountOk =
        Number.isFinite(invTotal) &&
        Number.isFinite(poTotal) &&
        poTotal > 0 &&
        invTotal > 0 &&
        Math.abs(invTotal - poTotal) / poTotal <= 0.02; // Bill ±2%

    const exp = normalizeDateOnly(input.expectedDate);
    const pastEta = exp ? exp <= todayISO() : false;

    if (invOk && amountOk && pastEta) return true;

    // Completed + accurate invoice (even without past ETA) — Completed alone is
    // weak, but Completed + amount-accurate invoice is high confidence.
    const finStatus = String(input.status || "").toLowerCase();
    if (finStatus === "completed" && invOk && amountOk) return true;

    return false;
}
