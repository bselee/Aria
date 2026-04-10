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
    // Only trust receiveDate if the PO is actually marked as received
    const normalizedStatus = String(input.status || "").toLowerCase();
    const isPOReceived = normalizedStatus === "received";

    // For shipments, only trust dates from shipments that are actually marked "Received"
    const receivedShipmentDates = (input.shipments || [])
        .filter(s => {
            const sStatus = String(s.status || "").toLowerCase();
            return sStatus.includes("received") && s.receiveDate;
        })
        .map(s => normalizeDateOnly(s.receiveDate))
        .filter((value): value is string => Boolean(value));

    const receiveDates: string[] = [];

    // Only include PO-level receiveDate if PO status is "received"
    if (isPOReceived && input.receiveDate) {
        const d = normalizeDateOnly(input.receiveDate);
        if (d) receiveDates.push(d);
    }

    // Include shipment receiveDates only for shipments marked "Received"
    receiveDates.push(...receivedShipmentDates);

    if (receiveDates.length === 0) return null;
    return receiveDates.sort().at(-1) || null;
}

export function hasPurchaseOrderReceipt(input: POReceiptStateInput): boolean {
    const normalizedStatus = String(input.status || "").toLowerCase();

    // Manual confirmation: user changed PO status to "received"
    if (normalizedStatus === "received") return true;

    // Staff receptions: at least one shipment shows "Received" status
    const shipments = input.shipments || [];
    if (shipments.length > 0) {
        const hasReceivedShipment = shipments.some(s =>
            String(s.status || '').toLowerCase().includes('received')
        );
        if (hasReceivedShipment) return true;
    }

    return false;
}
