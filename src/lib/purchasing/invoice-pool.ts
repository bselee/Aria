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
    "unknownvendor",
    "invoice", // bare OCR garbage seen in the wild ("I N V O I C E" collapses to this)
]);

/** Invoice numbers that mark a failed extraction. EMPTY is deliberately NOT
 *  here — see isJunkInvoiceNumber. */
const JUNK_INVOICE_NUMBERS = new Set([
    "error",
    "unknown",
    "null",
    "nan",
]);

const JUNK_INVOICE_LABELS = new Set([
    "berinvoice",
    "invoice",
    "number",
    "invoicenumber",
    "unknown",
    "error",
    "null",
    "nan",
]);

/** Header-word invoice numbers ("BERINVOICE") are OCR jams, not documents. */
export function isJunkInvoiceLabel(invoiceNumber: string | null | undefined): boolean {
    const n = String(invoiceNumber ?? "").replace(/\s+/g, "").toLowerCase();
    if (!n) return true;
    return JUNK_INVOICE_LABELS.has(n);
}

/**
 * Recover a real invoice number from an attachment id when OCR stored a
 * header word. `apfwd:…:Uline_Invoice_215047605_216827642_1.pdf` → 215047605.
 */
export function invoiceNumberFromAttachment(
    attachmentId: string | null | undefined,
    current: string | null | undefined,
): string | null {
    const cur = String(current ?? "").trim();
    if (cur && !isJunkInvoiceLabel(cur)) return cur;
    const id = String(attachmentId ?? "");
    const named = id.match(/Invoice[_-](\d{6,})/i);
    return named ? named[1] : null;
}

function norm(value: string | null | undefined): string {
    return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * True when a vendor name is an ingest-failure marker (OCR/gateway wrote the
 * literal error string, or the document was classified as something that is
 * not an invoice — packing slip / packing list). NULL / missing vendor name
 * is NOT junk: the enrichment queries often omit the column, and an unknown
 * vendor must never hide a real invoice (2026-10-27 regression: null-vendor
 * rows with real invoice numbers were rejected, blanking the whole panel).
 */
export function isJunkVendorName(vendorName: string | null | undefined): boolean {
    if (vendorName == null) return false;
    return JUNK_VENDOR_NAMES.has(norm(vendorName));
}

/**
 * True when an invoice number is an extraction-failure marker. An EMPTY
 * invoice number is not junk by itself — a photo invoice with an unreadable
 * number is still a real document; its vendor name decides.
 */
export function isJunkInvoiceNumber(invoiceNumber: string | null | undefined): boolean {
    if (invoiceNumber == null) return false;
    return JUNK_INVOICE_NUMBERS.has(norm(invoiceNumber));
}

/** A vendor_invoices-shaped row (only the fields the pool cares about). */
export interface InvoicePoolRow {
    vendor_name?: string | null;
    invoice_number?: string | null;
    source?: string | null;
    source_ref?: string | null;
}

/**
 * FedEx / Billtrust CSV archives are carrier freight, not goods invoices.
 * They belong on the freight reconcile path (reconcile-billtrust-freight /
 * reconcile-fedex), never in the PO match pool. source_ref is
 * `FEDEX_*.csv` (Billtrust archive) or `fedex-csv-*` (FBO archive).
 */
export function isCarrierFreightArchive(row: InvoicePoolRow | null | undefined): boolean {
    if (!row) return false;
    const ref = String(row.source_ref ?? "");
    return /^FEDEX_/i.test(ref) || /^fedex-csv-/i.test(ref);
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
