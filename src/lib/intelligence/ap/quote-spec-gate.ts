/**
 * @file    src/lib/intelligence/ap/quote-spec-gate.ts
 * @purpose Detect quote / spec-sheet / estimate documents so they never reach
 *          Bill.com as bills. A quote is not a payable: forwarding it creates
 *          an unmatched Bill.com bill that reconcile-billcom then flags forever.
 *
 *          Observed 2026-09-21 on the Century Equipment (peter.capone@centuryeq.com)
 *          thread: 8 of 9 forwarded attachments were equipment quotes and spec
 *          sheets ("Nick Schwab 2024 CX50 quote 9-10.pdf", "CX37C specs.pdf",
 *          "580SN spec.pdf", …). Only one was a real invoice
 *          ("Build A Soil invoice 9-17-26.pdf", GJ17176-1, $9,638.89) and it
 *          must keep forwarding.
 *
 *          Safety rule: any filename/subject/text that also carries an invoice
 *          signal ("invoice", "bill", "statement of charges") is NEVER skipped —
 *          vendors routinely title real bills "Quote conversion invoice".
 *
 * @author  Hermia
 * @created 2026-09-21
 * @deps    none (pure)
 */

/** Words that mark a document as a pre-sale / informational artifact. */
const QUOTE_SPEC_RE =
    /\b(?:quote|quotation|spec(?:s|sheet)?|specification|specifications)\b/i;

/** Words that mark a document as an actual bill — never skip when present. */
const INVOICE_RE = /\b(?:invoice|inv\s*#?\s*\d|bill(?:ing)?|statement|tax\s*invoice|final\s*price)\b/i;

/** Monetary signal: a payable document states a total due / amount due. */
const TOTAL_DUE_RE = /\b(?:total\s*due|amount\s*due|balance\s*due|please\s*pay|remit\s*(?:to|payment))\b/i;

/**
 * True when the filename or subject alone marks this as a quote/spec document.
 *
 * @param args.subject  email subject (optional)
 * @param args.filename attachment filename (optional)
 * @returns true when it reads as a quote/spec and carries no invoice signal
 */
export function isQuoteOrSpecName(args: {
    subject?: string | null;
    filename?: string | null;
}): boolean {
    const filename = String(args.filename || "");
    const subject = String(args.subject || "");
    const hay = `${filename} ${subject}`.trim();
    if (!hay || !QUOTE_SPEC_RE.test(hay)) return false;
    // Real invoice wins: "Invoice for quote 1234" still forwards.
    if (INVOICE_RE.test(filename) || INVOICE_RE.test(subject)) return false;
    return true;
}

/**
 * True when the document text reads as a quote/spec sheet rather than a bill.
 *
 * Used only when the name is ambiguous (e.g. "Nick Schwab 2025 Open Rops
 * CX37C.pdf"). Requires BOTH a quote/spec signal and the ABSENCE of any
 * payable signal (invoice word or total-due phrase), so real invoices are
 * never blocked.
 *
 * @param args.pdfText  OCR/extracted PDF text (optional)
 * @returns true when the text is a quote/spec with no payable signal
 */
export function isQuoteOrSpecText(args: { pdfText?: string | null }): boolean {
    const text = String(args.pdfText || "");
    if (text.trim().length < 40) return false; // too little text to judge (scans)
    if (!QUOTE_SPEC_RE.test(text)) return false;
    if (INVOICE_RE.test(text) || TOTAL_DUE_RE.test(text)) return false;
    return true;
}

/**
 * Combined document-level verdict: name signal OR text signal.
 *
 * @param args.subject  email subject (optional)
 * @param args.filename attachment filename (optional)
 * @param args.pdfText  OCR/extracted PDF text (optional)
 * @returns true when the attachment must NOT be forwarded as a bill
 */
export function isQuoteOrSpecDocument(args: {
    subject?: string | null;
    filename?: string | null;
    pdfText?: string | null;
}): boolean {
    if (isQuoteOrSpecName(args)) return true;
    return isQuoteOrSpecText(args);
}
