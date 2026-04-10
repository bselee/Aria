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
    // Trust PO-level receiveDate as a fallback — Finale sets it when any reception is created
    // (even if the PO status stays "Committed"/"Completed" rather than "Received")
    const poLevelDate = normalizeDateOnly(input.receiveDate);

    // For shipments, only trust dates from shipments that are actually marked "Received"
    const receivedShipmentDates = (input.shipments || [])
        .filter(s => {
            const sStatus = String(s.status || "").toLowerCase();
            return sStatus.includes("received") && s.receiveDate;
        })
        .map(s => normalizeDateOnly(s.receiveDate))
        .filter((value): value is string => Boolean(value));

    const receiveDates: string[] = [];

    // Always trust PO-level receiveDate (Finale sets it when reception is created)
    if (poLevelDate) {
        receiveDates.push(poLevelDate);
    }

    // Also include shipment receiveDates for shipments marked "Received"
    receiveDates.push(...receivedShipmentDates);

    if (receiveDates.length === 0) return null;
    return receiveDates.sort().at(-1) || null;
}

export function hasPurchaseOrderReceipt(input: POReceiptStateInput): boolean {
    const normalizedStatus = String(input.status || "").toLowerCase();

    // Manual confirmation: user changed PO status to "received"
    if (normalizedStatus === "received") return true;

    // Staff receptions: at least one shipment has EXACT status "received"
    // Be strict - don't match "Partially Received", "Received into Stock", etc.
    const shipments = input.shipments || [];
    if (shipments.length > 0) {
        const hasReceivedShipment = shipments.some(s => {
            const sStatus = String(s.status || "").toLowerCase().trim();
            return sStatus === "received";
        });
        if (hasReceivedShipment) return true;
    }

    return false;
}
