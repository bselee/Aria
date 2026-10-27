/**
 * @file    invoice-pool.ts
 * @purpose Shared eligibility guards for the invoice match pool. Phantom rows
 *          (packing slips / misclassified attachments ingested with vendor or
 *          invoice number literally "error", "PACKING SLIP", or blank) must
 *          never surface as review items, never count as a matched invoice
 *          leg, and never be auto-matched to a PO. Found 2026-10-27: a
 *          Commercial Packing List ingested as vendor "error" + invoice_number
 *          "error" was attached to PO 125411 and made the Receivings panel
 *          offer "Complete" on a partial receipt.
 * @author  Hermia
 * @created 2026-10-27
 * @deps    none (pure)
 */

/** Vendor names that mark a failed/misclassified ingest. Entries are
 *  whitespace-collapsed (norm strips all whitespace before lookup). */
const JUNK_VENDOR_NAMES = new Set([
    "",
    "error",
    "packingslip",
    "packinglist",
    "unknown",
    "invoice", // bare OCR garbage seen in the wild ("I N V O I C E" collapses to this)
]);

/** Invoice numbers that mark a failed extraction. Lowercased, trimmed. */
const JUNK_INVOICE_NUMBERS = new Set(["", "error", "unknown", "null", "nan"]);

function norm(value: string | null | undefined): string {
    return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * True when a vendor name is an ingest-failure marker (OCR/gateway wrote the
 * literal error string, or the document was classified as something that is
 * not an invoice — packing slip / packing list).
 */
export function isJunkVendorName(vendorName: string | null | undefined): boolean {
    return JUNK_VENDOR_NAMES.has(norm(vendorName));
}

/**
 * True when an invoice number is an extraction-failure marker.
 */
export function isJunkInvoiceNumber(invoiceNumber: string | null | undefined): boolean {
    return JUNK_INVOICE_NUMBERS.has(norm(invoiceNumber));
}

/** A vendor_invoices-shaped row (only the fields the pool cares about). */
export interface InvoicePoolRow {
    vendor_name?: string | null;
    invoice_number?: string | null;
}

/**
 * True when the row is a phantom document: it cannot act as an invoice leg,
 * a match candidate, or a review item.
 */
export function isPhantomInvoiceRow(row: InvoicePoolRow | null | undefined): boolean {
    if (!row) return true;
    return isJunkVendorName(row.vendor_name) || isJunkInvoiceNumber(row.invoice_number);
}

/**
 * First non-phantom row of a list — used when picking the "matched invoice"
 * for a PO, so a phantom can never satisfy the invoice leg.
 */
export function firstRealInvoice<T extends InvoicePoolRow>(rows: T[] | null | undefined): T | null {
    return (rows ?? []).find((r) => !isPhantomInvoiceRow(r)) ?? null;
}
