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

function isShipmentMarkedReceived(shipment: POShipmentReceiptLike): boolean {
    const status = String(shipment.status || "").toLowerCase();
    return status.includes("received") || !!normalizeDateOnly(shipment.receiveDate);
}

export function resolvePurchaseOrderReceiptDate(input: POReceiptStateInput): string | null {
    const receiveDates = [
        normalizeDateOnly(input.receiveDate),
        ...((input.shipments || []).map((shipment) => normalizeDateOnly(shipment.receiveDate))),
    ].filter((value): value is string => Boolean(value));

    if (receiveDates.length === 0) return null;
    return receiveDates.sort().at(-1) || null;
}

export function hasPurchaseOrderReceipt(input: POReceiptStateInput): boolean {
    const normalizedStatus = String(input.status || "").toLowerCase();
    // Only trust explicit "received" status — Finale auto-populates shipment receiveDate
    // when items are booked into inventory, which does NOT mean physical receipt.
    return normalizedStatus === "received";
}
