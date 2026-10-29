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
 * Date-shaped "invoice numbers": OCR of `10/22/2026` collapsed into
 * `10,222,026`. A date is not an invoice identity — two different invoices
 * from the same vendor in the same month would both read as "10,222,026".
 */
const DATE_SHAPED_INVOICE_RE = /^\d{1,2},\d{3},\d{3}$/;

/**
 * True when an invoice number is an extraction-failure marker. An EMPTY
 * invoice number is not junk by itself — a photo invoice with an unreadable
 * number is still a real document; its vendor name decides.
 *
 * Header-word rule (2026-10-29): a value with ZERO digits is a form label the
 * OCR jammed into the number field — live evidence `BERINVOICE`, `SALES`,
 * `NO`, `PAGE`, `error`. Alphanumeric invoice cores that DO carry digits
 * (`KM-098970`, `APUS-248361`) are real identities and stay.
 */
export function isJunkInvoiceNumber(invoiceNumber: string | null | undefined): boolean {
    if (invoiceNumber == null) return false;
    const n = norm(invoiceNumber);
    // Empty stays non-junk — a photo invoice with an unreadable number is real.
    if (!n) return false;
    if (JUNK_INVOICE_NUMBERS.has(n)) return true;
    if (DATE_SHAPED_INVOICE_RE.test(n)) return true;
    if (!/\d/.test(n) && n.length < 12) return true;
    return false;
}

/** A vendor_invoices-shaped row (only the fields the pool cares about). */
export interface InvoicePoolRow {
    vendor_name?: string | null;
    invoice_number?: string | null;
    source?: string | null;
    source_ref?: string | null;
    /** Bill amount. Reads `total` (vendor_invoices) — used by the shape guard. */
    total?: number | string | null;
    /** Line items, when selected. A document with lines is a document. */
    line_items?: unknown;
}

/**
 * Carrier freight archives are not goods invoices. They belong on the freight
 * reconcile path (reconcile-billtrust-freight / reconcile-fedex), never in the
 * PO match pool. source_ref shapes seen live:
 *   - `FEDEX_*.csv`     (Billtrust archive)
 *   - `fedex-csv-*`     (FBO archive)
 *   - `ltlselect-*`     (LTL Select carrier invoice export — 2026-10-29:
 *                        PO 125393 was named by 300093120787, an LTL Select
 *                        freight bill, as its matched invoice)
 *   - `billcom:*`       (Bill.com-native bill ref; carrier lane, not a PO bill)
 */
export function isCarrierFreightArchive(row: InvoicePoolRow | null | undefined): boolean {
    if (!row) return false;
    const ref = String(row.source_ref ?? "");
    return /^FEDEX_/i.test(ref) || /^fedex-csv-/i.test(ref)
        || /^ltlselect-/i.test(ref) || /^billcom:/i.test(ref);
}

/**
 * True when the row is a phantom document: it cannot act as an invoice leg,
 * a match candidate, or a review item.
 *
 * Two independent failure shapes:
 *   1. Identity junk — vendor name or invoice number is an ingest/OCR marker.
 *   2. Empty document — no invoice number AND no positive total AND no line
 *      items. Live phantoms of this shape: vendor `Jax` (no number, $0, no
 *      lines) and `Federal ID# 36-3684738` (the Uline FED ID line parsed as a
 *      vendor). A named vendor alone is NOT enough to keep a row: those two
 *      carry a vendor string and nothing else. A legitimate named vendor with
 *      a real number or a positive total passes.
 */
export function isPhantomInvoiceRow(row: InvoicePoolRow | null | undefined): boolean {
    if (!row) return true;
    if (isJunkVendorName(row.vendor_name) || isJunkInvoiceNumber(row.invoice_number)) return true;
    const hasNumber = !!(row.invoice_number && String(row.invoice_number).trim().length > 0);
    const totalNum = Number(row.total ?? 0);
    const hasTotal = Number.isFinite(totalNum) && totalNum > 0;
    const hasLines = Array.isArray(row.line_items) && row.line_items.length > 0;
    if (!hasNumber && !hasTotal && !hasLines) return true;
    return false;
}

/**
 * First non-phantom row of a list — used when picking the "matched invoice"
 * for a PO, so a phantom can never satisfy the invoice leg.
 */
export function firstRealInvoice<T extends InvoicePoolRow>(rows: T[] | null | undefined): T | null {
    return (rows ?? []).find((r) => !isPhantomInvoiceRow(r)) ?? null;
}
