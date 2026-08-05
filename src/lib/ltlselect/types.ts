/**
 * @file    types.ts
 * @purpose Type definitions for the LTL Select Invoice Center API
 *          (FedEx TMS at www.ltlselect.com, Auth0-protected k8s API).
 *          Shapes mirror the live API response — verified 2026-08-05.
 * @author  Hermia
 * @created 2026-08-05
 * @deps    none
 */

/**
 * Identifier block on an invoice row. All fields nullable in practice —
 * PRO/BOL are the reliable anchors; orderNumber/referenceNumber are often
 * absent and are the carriers of an embedded Finale PO# when present.
 */
export interface LtlSelectIdentifiers {
    proNumber?: string | null;
    bolNumber?: string | null;
    orderNumber?: string | null;
    referenceNumber?: string | null;
    pickupNumber?: string | null;
    internalTrackingNumber?: string | null;
    [key: string]: unknown;
}

/** Origin / destination location block. */
export interface LtlSelectLocation {
    name?: string | null;
    date?: string | null;
    address?: {
        city?: string | null;
        state?: string | null;
        postal_code?: string | null;
        postalCode?: string | null;
        [key: string]: unknown;
    } | null;
    [key: string]: unknown;
}

/** Quoted rate block (pre-carrier-invoice estimate). */
export interface LtlSelectRate {
    paymentType?: string | null;        // COLLECT | PREPAID
    direction?: string | null;          // CONSIGNEE | SHIPPER
    rateQuoteDetail?: { total?: number | null; [key: string]: unknown } | null;
    [key: string]: unknown;
}

/** Scanned carrier invoice total — the amount-of-record for PO freight. */
export interface LtlSelectScannedTotal {
    invoiceTotal?: number | null;
    currencyCode?: string | null;
    subTotalCharges?: Array<{
        description?: string | null;
        category?: string | null;
        amount?: string | number | null;
        [key: string]: unknown;
    }> | null;
    discrepancyAnalysis?: { analysisSummary?: string | null; [key: string]: unknown } | null;
    [key: string]: unknown;
}

/** One row from GET /shipments/invoice. */
export interface LtlSelectInvoice {
    _id?: string;
    identifiers?: LtlSelectIdentifiers | null;
    shipment?: {
        origin?: LtlSelectLocation | null;
        destination?: LtlSelectLocation | null;
        carrier?: string | null;
        booked_at?: string | null;
        pickupDateTime?: string | null;
        rate?: LtlSelectRate | null;
        [key: string]: unknown;
    } | null;
    scannedInvoiceTotal?: LtlSelectScannedTotal | null;
    status?: {
        currentStatus?: { code?: string | null; description?: string | null; [key: string]: unknown } | null;
        [key: string]: unknown;
    } | null;
    [key: string]: unknown;
}

/** Paged response envelope from /shipments/invoice. */
export interface LtlSelectInvoicePage {
    list: LtlSelectInvoice[];
    totalCount: number;
}
