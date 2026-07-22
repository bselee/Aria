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
} {
    const text = rawText || "";
    let invoiceNumber: string | null = null;
    let poNumber: string | null = null;
    let total: number | null = null;
    let invoiceDate: string | null = null;
    let vendorHint: string | null = null;

    // INVOICE # 1682  /  Invoice No. 1682  /  Invoice Number:\n1682
    // DTE paper layout: "INVOICE #\n4/24/2026\n1682" — date then number.
    const invPatterns = [
        /INVOICE\s*#\s*\n\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\n\s*([0-9]{3,8})\b/i,
        /INVOICE\s*(?:NO|NUM|NUMBER)\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i,
        /INVOICE\s*#\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i,
        /\bINV[#\s\-]*([0-9]{3,8})\b/i,
    ];
    for (const re of invPatterns) {
        const m = text.match(re);
        if (m?.[1] && !/^unknown$/i.test(m[1]) && !looksLikeDate(m[1])) {
            invoiceNumber = m[1].trim();
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

    // PO: dedicated field or bare 5–6 digit Finale-style after P.O. NUMBER
    const poPatterns = [
        /P\.?\s*O\.?\s*(?:NUMBER|NUM|#|NO\.?)?\s*[:#\-]?\s*#?\s*(\d{4,6})\b/i,
        /PURCHASE\s+ORDER\s*#?\s*[:#\-]?\s*(\d{4,6})\b/i,
        /(?:^|\n)\s*#?(12\d{3,4})\b/, // Finale POs often 12xxxx
    ];
    for (const re of poPatterns) {
        const m = text.match(re);
        if (m?.[1]) {
            poNumber = m[1].padStart(5, "0");
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

    return { invoiceNumber, poNumber, total, invoiceDate, vendorHint };
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
    const po = cleanInvoiceField(parsed?.poNumber ?? null) || fb.poNumber;
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

    const freight = Number(parsed?.freight) || 0;
    const tax = Number(parsed?.tax) || 0;
    const subtotal = Number(parsed?.subtotal) || 0;
    const lineItems = Array.isArray(parsed?.lineItems)
        ? parsed!.lineItems!.map((li: any) => ({
              sku: String(li.sku || ""),
              description: String(li.description || ""),
              qty: Number(li.qty) || 0,
              unit_price: Number(li.unitPrice ?? li.unit_price) || 0,
              ext_price: Number(li.total ?? li.ext_price ?? li.extPrice) || 0,
          }))
        : [];

    return {
        vendorName,
        invoiceNumber: inv,
        poNumber: po,
        invoiceDate,
        total,
        freight,
        tax,
        subtotal,
        lineItems,
    };
}
