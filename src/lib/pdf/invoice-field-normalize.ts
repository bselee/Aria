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

/**
 * AutoPot/QuickBooks prints the sales order as a STANDALONE 8-digit line with no
 * "P.O." label (APUS-248353: line "23581947"). Built from string parts, not a
 * regex literal, for the same CRLF-safety reason as SPLIT_LINE_RE.
 * Deliberately narrow: the line must contain nothing but the 8 digits. Results
 * are corroborated against purchase_orders downstream.
 */
const STANDALONE_SO_RE = new RegExp(
    "(?:^|" + String.fromCharCode(10) + ")[ \\t]*(2\\d{7})[ \\t]*(?=" + String.fromCharCode(13) + "?" + String.fromCharCode(10) + "|$)",
);

/**
 * Multi-PO list: two or more comma-separated standard Finale POs (1 + 5 digits).
 * Grassroots prints "…125332, 125341" glued onto the tracking line, so the refs
 * are not line-anchored. Captures the whole comma run, then callers validate each
 * member individually — a stray number in the list is dropped, not trusted.
 */
const MULTI_PO_RE = /1\d{5}(?: *, *1\d{5})+/g;

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
    /**
     * Every PO ref found, in document order. A single invoice can legitimately
     * cover several POs (Grassroots 34658: "125332, 125341" on one printed
     * line), and `poNumber` can only carry the first. Callers that allocate
     * money across POs must use this, not poNumber.
     */
    poNumbers: string[];
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
        // "INVOICE 34658" — bare label, no NO/NUM/# token. Grassroots prints
        // exactly this, so every one of their invoices missed its number here
        // and only survived via the subject-line fallback. Bounded digit run.
        /INVOICE\s+([0-9]{3,8})\b/i,
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
    // "-DropshipPO" row via validatePoRef/resolveDropshipPOByBase. The labeled
    // 8-digit arm is last so a standard 6-digit PO always wins on a document
    // carrying both, and digit runs are bounded so a longer run cannot capture
    // a prefix.
    //
    // The final arm covers AutoPot/QuickBooks, which prints the sales order as a
    // STANDALONE 8-digit line with no "P.O." label at all (APUS-248353 line 39:
    // "23581947"). It is deliberately narrow — the line must be nothing but the
    // 8 digits — and every candidate is corroborated against purchase_orders
    // downstream, so a stray number cannot become a PO ref.
    const poPatterns = [
        /P\.?\s*O\.?\s*(?:NUMBER|NUM|#|NO\.?)?\s*[:#\-]?\s*#?\s*(1\d{5})\b/i,
        /PURCHASE\s+ORDER\s*#?\s*[:#\-]?\s*(1\d{5})\b/i,
        /(?:^|\n)\s*#?(12\d{3,4})\b/, // Finale POs often 12xxxx
        /P\.?\s*O\.?\s*(?:NUMBER|NUM|#|NO\.?)?\s*[:#\-]?\s*#?\s*(2\d{7})\b/i,
        STANDALONE_SO_RE, // standalone sales-order line
    ];
    for (const re of poPatterns) {
        const m = text.match(re);
        if (m?.[1]) {
            poNumber = /^2\d{7}$/.test(m[1]) ? m[1] : m[1].padStart(5, "0");
            break;
        }
    }

    // Multi-PO documents. Grassroots prints both refs on one line, glued after
    // the tracking number: "...12 5332, 125341". Collect every comma-separated
    // ref that sits alongside a valid one so the split is never guessed. Only
    // runs when the document actually presents more than one ref.
    const poNumbers: string[] = [];
    if (poNumber) poNumbers.push(poNumber);
    for (const m of text.matchAll(MULTI_PO_RE)) {
        for (const raw of m[0].split(",")) {
            const t = raw.trim();
            if (!/^1\d{5}$/.test(t)) continue;
            if (!poNumbers.includes(t)) poNumbers.push(t);
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

    // Freight — read the printed SHIPPING line. Do not infer it.
    //
    // Two real layouts, both verified against live PDFs:
    //   AutoPot (pdf-parse): "SHIPPING32.00"      label glued straight to amount
    //   Evergreen (glued OCR): "Shipping-FedExS/H - FedEx Tracking #<n>1ea56.77…"
    //
    // The label must NOT carry a trailing \b: in "SHIPPING32.00" the G and the 3
    // are both word characters, so \bshipping\b never matches and freight came
    // back null on AutoPot invoices that print it plainly. Leading \b only.
    //
    // Then take the FIRST price-like amount after the label. Evergreen's
    // "Insulation" line can glue onto the same physical line, so LAST is wrong
    // (it returned 7.00 instead of 56.77). A `(?<![\d.])` lookbehind refuses an
    // amount that is really the tail of a longer digit run, so a tracking number
    // bleeding into the price yields null rather than a fabricated figure.
    //
    // No label, no freight: this feeds variance review, where a guess is worse
    // than a blank.
    let freight: number | null = null;
    const labelRe = /\b(?:shipping|freight|s\s*\/?\s*h)(?![a-z])/i;
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

    return { invoiceNumber, poNumber, poNumbers, total, invoiceDate, vendorHint, freight };
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

    // Subtotal is DEFINED as everything that is not freight or tax:
    //     subtotal + freight + tax == total
    // When the LLM's subtotal contradicts that identity the row is written
    // inconsistent, and an inconsistent row is worse than a derived one: it
    // silently corrupts variance/freight review. Two real Evergreen invoices
    // (151475, 151435 — 2026-11-11) landed that way: 151475 carried
    // subtotal == total with freight 60.46 on top (freight double-counted),
    // 151435 dropped the 7.00 insulation out of subtotal entirely.
    //
    // So: keep the parsed subtotal when it reconciles; otherwise re-derive it
    // from the printed total less freight and tax, which by definition
    // reconciles. The disagreement is surfaced rather than swallowed, so a
    // misread freight figure still shows up in the log instead of being hidden
    // inside a subtotal that happens to add up.
    const reconciles = (s: number) => Math.abs(s + freight + tax - total) < 0.005;
    if (total > 0) {
        if (!subtotal && total - freight - tax > 0) {
            subtotal = Math.round((total - freight - tax) * 100) / 100;
        } else if (subtotal > 0 && !reconciles(subtotal)) {
            const derived = Math.round((total - freight - tax) * 100) / 100;
            if (derived > 0) {
                console.warn(
                    `[invoice-field-normalize] subtotal does not reconcile ` +
                    `(subtotal=${subtotal} + freight=${freight} + tax=${tax} != total=${total}); ` +
                    `using derived subtotal ${derived} — check the freight/tax reading.`,
                );
                subtotal = derived;
            }
        }
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
