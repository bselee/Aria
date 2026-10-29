/**
 * @file    src/lib/pdf/invoice-field-normalize.ts
 * @purpose Sanitize parsed invoice fields before DB write. Never store sentinel
 *          values like "UNKNOWN" as invoice_number (unique constraint poison).
 *          Regex fallbacks for OCR text when LLM parse is thin (photo invoices).
 * @author  Hermia
 * @created 2026-07-17
 * @deps    none
 *
 * CONTEXT: Down to Earth Worms phone-photo invoices OCR well as text but
 * parseInvoice often returns invoiceNumber="UNKNOWN", leaving ocr_* null and
 * vendor_invoices upserts colliding on (vendor, UNKNOWN).
 */
import type { InvoiceData } from "./invoice-parser";
import { extractGoodsLinesFromInvoiceText } from "./invoice-text-lines";

/**
 * Line splitter. Built from char codes rather than a regex literal so an
 * editor/patcher that folds a literal CRLF cannot silently break this module —
 * a real newline inside a regex literal is a SyntaxError that takes out every
 * import of this file, including the tests of unrelated modules.
 * Matches CRLF, CR, or LF runs.
 */
const SPLIT_LINE_RE = new RegExp("[" + String.fromCharCode(13) + String.fromCharCode(10) + "]+");

const BAD_SENTINELS = new Set([
    "",
    "unknown",
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "-",
    "—",
    // A parse failure falls back to invoice-parser's literal "error" values
    // (see parseInvoice catch-all). Those are sentinels, never real identity:
    // storing them poisons the (vendor_name, invoice_number) conflict key and
    // routes real bills into the phantom/junk filters. Clean them so the
    // regex/email fallbacks get their chance.
    "error",
    "failed",
    "parse error",
    "ocr error",
]);

/** Treat model/schema sentinels as missing. */
export function cleanInvoiceField(value: string | null | undefined): string | null {
    if (value == null) return null;
    const t = String(value).trim();
    if (!t) return null;
    if (BAD_SENTINELS.has(t.toLowerCase())) return null;
    return t;
}

/**
 * Regex fallbacks for common invoice headers in OCR text (esp. QuickBooks-style
 * paper invoices photographed by vendors like Down to Earth Worms).
 */
export function extractInvoiceFieldsFromOcrText(rawText: string): {
    invoiceNumber: string | null;
    poNumber: string | null;
    total: number | null;
    invoiceDate: string | null;
    vendorHint: string | null;
    freight: number | null;
} {
    const text = rawText || "";
    let invoiceNumber: string | null = null;
    let poNumber: string | null = null;
    let total: number | null = null;
    let invoiceDate: string | null = null;
    let vendorHint: string | null = null;

    // INVOICE # 1682  /  Invoice No. 1682  /  Invoice Number:\n1682
    // DTE paper layout: "INVOICE #\n4/24/2026\n1682" — date then number.
    // Miles template layout: "Invoice ID Issue Date Terms\n\nMiles Filippelli
    // Fermented Plant Extracts\n10,272,026 10.27.2026" — label is Invoice ID,
    // the number sits on the next line and carries a thousands comma. Both ID
    // patterns capture a digit-run ONLY, so header prose ("Issue Date Terms")
    // can never be captured as an invoice number.
    const invPatterns = [
        /INVOICE\s*#\s*\n\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\n\s*([0-9]{3,8})\b/i,
        /INVOICE\s+ID(?:ENTIFICATION)?[\s\S]{0,120}?\n\s*([0-9][0-9,\-]{2,18})/i,
        /INVOICE\s*ID(?:ENTIFICATION)?\s*[:.]?\s*([0-9][0-9,\-]{2,18})/i,
        /INVOICE\s*(?:NO|NUM|NUMBER)\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i,
        /INVOICE\s*#\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i,
        /\bINV[#\s\-]*([0-9]{3,8})\b/i,
    ];
    for (const re of invPatterns) {
        const m = text.match(re);
        const raw = m?.[1]?.trim();
        if (raw && !/^unknown$/i.test(raw) && !looksLikeDate(raw)) {
            invoiceNumber = raw;
            break;
        }
    }
    // Last resort: first 3–5 digit token after "INVOICE #" block
    if (!invoiceNumber) {
        const block = text.match(/INVOICE\s*#([\s\S]{0,80})/i);
        if (block) {
            const nums = [...block[1].matchAll(/\b(\d{3,5})\b/g)].map((x) => x[1]);
            // Prefer numbers that aren't years (202x) or pure month/day
            const cand = nums.find((n) => !/^202\d$/.test(n) && Number(n) >= 100);
            if (cand) invoiceNumber = cand;
        }
    }

    // PO: dedicated field, bare Finale-style after P.O. NUMBER, or a dropship
    // 8-digit sales-order base ("2" + 7 digits) that resolves to a
    // "-DropshipPO" row via validatePoRef/resolveDropshipPOByBase. The 8-digit
    // arm is last so a standard 6-digit PO always wins on a document carrying
    // both, and digit runs are bounded so a longer run cannot capture a prefix.
    const poPatterns = [
        /P\.?\s*O\.?\s*(?:NUMBER|NUM|#|NO\.?)?\s*[:#\-]?\s*#?\s*(1\d{5})\b/i,
        /PURCHASE\s+ORDER\s*#?\s*[:#\-]?\s*(1\d{5})\b/i,
        /(?:^|\n)\s*#?(12\d{3,4})\b/, // Finale POs often 12xxxx
        /P\.?\s*O\.?\s*(?:NUMBER|NUM|#|NO\.?)?\s*[:#\-]?\s*#?\s*(2\d{7})\b/i,
    ];
    for (const re of poPatterns) {
        const m = text.match(re);
        if (m?.[1]) {
            poNumber = /^2\d{7}$/.test(m[1]) ? m[1] : m[1].padStart(5, "0");
            break;
        }
    }

    // Total: $7,875.00 / Total\n$7,875.00 / AMOUNT DUE
    const totalPatterns = [
        /\bTOTAL\s*[:.]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
        /AMOUNT\s+DUE\s*[:.]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
        /\$\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\s*(?:$|\n)/,
    ];
    for (const re of totalPatterns) {
        const m = text.match(re);
        if (m?.[1]) {
            total = Number(m[1].replace(/,/g, ""));
            if (!Number.isNaN(total) && total > 0) break;
            total = null;
        }
    }

    // Date near INVOICE / DATE
    const datePatterns = [
        /(?:INVOICE\s*)?DATE\s*[:.]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /\b(\d{1,2}\/\d{1,2}\/202\d)\b/,
        /\b(202\d-\d{2}-\d{2})\b/,
    ];
    for (const re of datePatterns) {
        const m = text.match(re);
        if (m?.[1]) {
            invoiceDate = normalizeLooseDate(m[1]);
            if (invoiceDate) break;
        }
    }

    if (/down\s*to\s*earth\s*worms/i.test(text) || /ambriole/i.test(text)) {
        vendorHint = "Down to Earth Worms";
    }

    // Freight: a shipping/S&H line with a money amount. Evergreen prints
    // "Shipping-FedExS/H - FedEx Tracking #<n>1ea56.7756.77" — glued OCR with
    // no spaces — and their "Insulation" line can glue onto the same physical
    // line, so the LAST amount is NOT the freight (it is the insulation, $7.00).
    //
    // Rule: anchor on the shipping LABEL, slice everything after it, then take
    // the FIRST price-like amount. A `(?<!\d)` lookbehind rejects amounts that
    // are really the tail of a longer digit run — that is how a tracking number
    // bleeding into the price ("...9104156.77") is refused outright rather than
    // silently read as freight.
    //
    // No label, no freight: this feeds variance review, and a guessed number is
    // worse than a blank.
    let freight: number | null = null;
    const labelRe = /\b(?:shipping|freight|s\s*\/?\s*h)\b/i;
    const lines = text.split(SPLIT_LINE_RE);
    const freightLine = lines.find((l) => labelRe.test(l) && /\d+\.\d{2}/.test(l));
    if (freightLine) {
        const at = freightLine.search(labelRe);
        const tail = at >= 0 ? freightLine.slice(at) : freightLine;
        const amounts = [...tail.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})*\.\d{2})/g)].map((m) =>
            Number(m[1].replace(/,/g, "")),
        );
        const first = amounts.find((n) => n > 0 && n < 100000);
        if (first != null) freight = first;
    }

    return { invoiceNumber, poNumber, total, invoiceDate, vendorHint, freight };
}

function looksLikeDate(s: string): boolean {
    return /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(s.trim()) || /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function normalizeLooseDate(s: string): string | null {
    const t = s.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
}

/**
 * Merge LLM parse + OCR regex fallbacks. Never returns invoiceNumber "UNKNOWN".
 */
export function normalizeInvoiceForDb(
    parsed: Partial<InvoiceData> | null | undefined,
    rawText: string,
    opts?: { vendorHint?: string },
): {
    vendorName: string;
    invoiceNumber: string | null;
    poNumber: string | null;
    invoiceDate: string | null;
    total: number;
    freight: number;
    tax: number;
    subtotal: number;
    lineItems: Array<{ sku: string; description: string; qty: number; unit_price: number; ext_price: number }>;
} {
    const fb = extractInvoiceFieldsFromOcrText(rawText);
    const inv = cleanInvoiceField(parsed?.invoiceNumber ?? null) || fb.invoiceNumber;
    let po = cleanInvoiceField(parsed?.poNumber ?? null) || fb.poNumber;
    let total = Number(parsed?.total) || 0;
    if (!total && fb.total) total = fb.total;
    let invoiceDate = cleanInvoiceField(parsed?.invoiceDate ?? null) || fb.invoiceDate;
    let vendorName =
        cleanInvoiceField(parsed?.vendorName ?? null) ||
        opts?.vendorHint ||
        fb.vendorHint ||
        "Unknown Vendor";
    // Normalize DTE naming
    if (/earth\s*worms|ambriole/i.test(vendorName) || fb.vendorHint) {
        vendorName = "Down to Earth Worms";
    }

    // Freight / tax / subtotal: the LLM parse wins when it produced a value;
    // the OCR line-scan is the fallback. Without this wiring `fb.freight` was
    // dead code — extractInvoiceFieldsFromOcrText computed a freight figure
    // that normalizeInvoiceForDb never read, which is why every Evergreen
    // vendor_invoices row carried freight=0 and the dropship variance
    // ($56.77 S/H + $7.00 insulation) was invisible to review.
    let freight = Number(parsed?.freight) || 0;
    if (!freight && fb.freight != null) freight = fb.freight;
    const tax = Number(parsed?.tax) || 0;
    let subtotal = Number(parsed?.subtotal) || 0;
    // Derive subtotal only when the pieces are present and it reconciles —
    // never to make a number look tidy.
    if (!subtotal && total > 0 && freight > 0 && total - freight - tax > 0) {
        subtotal = Math.round((total - freight - tax) * 100) / 100;
    }
    const lineItems = Array.isArray(parsed?.lineItems)
        ? parsed!.lineItems!.map((li: any) => ({
              sku: String(li.sku || ""),
              description: String(li.description || ""),
              qty: Number(li.qty) || 0,
              unit_price: Number(li.unitPrice ?? li.unit_price) || 0,
              ext_price: Number(li.total ?? li.ext_price ?? li.extPrice) || 0,
          }))
        : [];
    const priced = lineItems.filter((li) => li.qty > 0 && li.unit_price > 0);
    const fromPdf = extractGoodsLinesFromInvoiceText(rawText, total || null);
    // The forward already has this text. A set that adds up to the printed total
    // wins over a model parse that dropped the lines.
    const storedLines = fromPdf.balanced
        ? fromPdf.lines.map((li) => ({
              sku: li.sku,
              description: li.description,
              qty: li.qty,
              unit_price: li.unitPrice,
              ext_price: li.total,
          }))
        : priced;
    if (!po && fromPdf.poNumber) po = fromPdf.poNumber;

    return {
        vendorName,
        invoiceNumber: inv,
        poNumber: po,
        invoiceDate,
        total,
        freight,
        tax,
        subtotal,
        lineItems: storedLines,
    };
}
