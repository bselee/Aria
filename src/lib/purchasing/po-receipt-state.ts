export interface POShipmentReceiptLike {
    status?: string | null;
    receiveDate?: string | null;
}

export interface POReceiptStateInput {
    status?: string | null;
    receiveDate?: string | null;
    shipments?: POShipmentReceiptLike[] | null;
}

function normalizeDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (isoPrefix) return isoPrefix[1];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().split("T")[0];
}

export function resolvePurchaseOrderReceiptDate(input: POReceiptStateInput): string | null {
    // PO-level receiveDate — Finale sets this when a reception is created.
    const poLevelDate = normalizeDateOnly(input.receiveDate);

    // Shipment receiveDates. Do NOT gate on the status string: Finale
    // auto-completes shipments when quantities match, so status is not proof
    // of receipt. The presence of a receiveDate is the concrete signal, which
    // keeps this consistent with hasPurchaseOrderReceipt().
    const shipmentDates = (input.shipments || [])
        .map(s => normalizeDateOnly(s.receiveDate))
        .filter((value): value is string => Boolean(value));

    const receiveDates: string[] = [];
    if (poLevelDate) receiveDates.push(poLevelDate);
    receiveDates.push(...shipmentDates);

    if (receiveDates.length === 0) return null;
    return receiveDates.sort().at(-1) || null;
}

export function hasPurchaseOrderReceipt(input: POReceiptStateInput): boolean {
    const normalizedStatus = String(input.status || "").toLowerCase();

    // Explicit staff action: changed PO status to "received"
    if (normalizedStatus === "received") return true;

    // Concrete evidence: Finale sets receiveDate when a receipt is created.
    // Unlike "Completed" status (which Finale auto-sets when quantities match),
    // receiveDate is only set by an actual reception — staff physically received goods.
    // Only trust past dates (future dates on Committed POs are planned ETAs).
    const receiptDate = resolvePurchaseOrderReceiptDate(input);
    if (receiptDate) {
        const today = new Date().toISOString().slice(0, 10);
        if (receiptDate <= today) return true;
    }

    // Shipment-level evidence: at least one shipment has a past receiveDate
    // (staff explicitly recorded receipt on this shipment). Status string alone
    // is NOT sufficient — Finale auto-completes shipments, so "Completed" doesn't
    // mean physical receipt. Only a past receiveDate is concrete proof.
    const shipments = input.shipments || [];
    if (shipments.length > 0) {
        const hasConcreteReceipt = shipments.some(s => {
            const date = normalizeDateOnly(s.receiveDate);
            if (!date) return false;
            const today = new Date().toISOString().slice(0, 10);
            return date <= today;
        });
        if (hasConcreteReceipt) return true;
    }

    return false;
}
