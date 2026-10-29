/**
 * @file    uline-invoice-repair.ts
 * @purpose Recover a Uline invoice's true identity from its OCR text: the
 *          invoice number ("INVOICE #: 215047605") and the Finale PO jammed
 *          into the "CUSTOMER NO. / PURCHASE ORDER NO." header line
 *          ("9897269125429" = customer 9897269 + PO 125429).
 *
 *          Why this exists (2026-10-29): 5 of 6 recent Uline forwards stored
 *          ocr_invoice_number = "BERINVOICE" and matched_po_number = the
 *          8-digit Uline web-order number, so no Uline receipt ever linked to
 *          its Finale PO and three receipts sat at "awaiting invoice" with
 *          their invoices at match-score 70.
 *
 *          Pure functions only — no I/O, no DB. Callers own the writes
 *          (src/cli/repair-uline-invoices.ts, ap-local-forwarder.ts).
 * @author  Hermia
 * @created 2026-10-29
 * @deps    ./invoice-pool (attachment filename fallback only)
 */

import { invoiceNumberFromAttachment } from "./invoice-pool";

/**
 * BAS's Uline customer number. Confirmed by Bill 2026-10-29. It is printed as
 * `CUSTOMER NO.` on every Uline invoice and sits immediately before the PO
 * number in the jammed header string, so it is the strip-prefix.
 */
export const ULINE_CUSTOMER_NO = "9897269";

/** Finale internal PO shape (6 digits, 12-prefixed). Uline web-order numbers
 *  are 8 digits and must never be treated as a PO. */
const FINALE_PO_RE = /^12\d{4}$/;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a vendor name is Uline in any of its OCR/Finale spellings
 * ("ULINE", "Uline", "Uline, Inc.").
 */
export function isUlineVendorName(vendorName: string | null | undefined): boolean {
    const letters = String(vendorName ?? "").toLowerCase().replace(/[^a-z]/g, "");
    return letters.includes("uline");
}

/**
 * Recover the Finale PO from a Uline invoice's raw OCR text.
 *
 * The header line reads
 *   `CUSTOMER NO.PURCHASE ORDER NO.SHIP VIA...`
 *   `9897269125429FEDEX FRT C1...`
 * i.e. the customer number and the PO are jammed into one digit run. Strip
 * the customer number and accept the following 6 digits ONLY when they are
 * 12xxxx-shaped: the same digit run also carries the invoice number
 * (`BUILDASOIL LLC9897269215047605...`), so a looser rule would return
 * "215047" and invent a PO that does not exist.
 *
 * @param rawText    OCR text of the Uline invoice PDF.
 * @param customerNo Strip prefix — defaults to the confirmed BAS account.
 * @returns          e.g. "125429", or null when no 12xxxx-shaped remainder.
 */
export function ulinePoFromRaw(
    rawText: string | null | undefined,
    customerNo: string = ULINE_CUSTOMER_NO,
): string | null {
    const raw = String(rawText ?? "");
    const cust = String(customerNo ?? "").trim();
    if (!raw || !cust) return null;

    const re = new RegExp(`${escapeRegExp(cust)}(\\d{6})`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
        const candidate = match[1];
        if (FINALE_PO_RE.test(candidate)) return candidate;
    }
    return null;
}

/**
 * Recover the Uline invoice number.
 *
 * Order: the labeled field in the raw text (`INVOICE #: 215047605`), then the
 * attachment filename (`Uline_Invoice_215047605_216827642_1.pdf`) via the
 * shared `invoiceNumberFromAttachment` reader.
 */
export function ulineInvoiceNumber(
    rawText: string | null | undefined,
    pdfFilename?: string | null,
): string | null {
    const raw = String(rawText ?? "");
    const labeled = raw.match(/INVOICE\s*#\s*:?\s*(\d{6,})/i);
    if (labeled?.[1]) return labeled[1];

    const name = String(pdfFilename ?? "").trim();
    if (name) {
        const fromName = invoiceNumberFromAttachment(name, null);
        if (fromName) return fromName;
    }
    return null;
}

/**
 * Normalize a SKU for EXACT comparison. Case/whitespace only — never strip
 * characters: `S-4738` and `S-473824` are different products and a substring
 * rule would link the wrong PO.
 */
export function normalizeSkuKey(sku: string | null | undefined): string | null {
    const s = String(sku ?? "").trim().toUpperCase();
    if (s.length < 3) return null;
    return s;
}

/**
 * Exact SKU intersection between invoice lines and a PO's line items.
 * Exact string equality only (after case/whitespace normalization) — the
 * `S-4738` vs `S-473824` trap depends on it.
 *
 * @returns sorted unique SKUs present on both sides (empty when no overlap).
 */
export function exactSkuOverlap(
    invoiceSkus: Iterable<string | null | undefined>,
    poProductIds: Iterable<string | null | undefined>,
): string[] {
    const poKeys = new Set<string>();
    for (const id of poProductIds) {
        const k = normalizeSkuKey(id);
        if (k) poKeys.add(k);
    }
    const hits = new Set<string>();
    for (const sku of invoiceSkus) {
        const k = normalizeSkuKey(sku);
        if (k && poKeys.has(k)) hits.add(k);
    }
    return [...hits].sort();
}

/**
 * Pull Uline SKUs out of invoice line items as the forwarder / repair CLI
 * receives them (OCR shape: `{ sku, qty, ... }`).
 */
export function skusFromInvoiceLines(
    lineItems: Array<{ sku?: string | null }> | null | undefined,
): string[] {
    const out: string[] = [];
    for (const li of lineItems ?? []) {
        const k = normalizeSkuKey(li?.sku ?? null);
        if (k && !out.includes(k)) out.push(k);
    }
    return out;
}

/**
 * Pull productIds out of a purchase_orders.line_items array (Finale shape:
 * `{ productId, quantity, unitPrice }`).
 */
export function productIdsFromPoLines(
    lineItems: unknown,
): string[] {
    let lines = lineItems;
    if (typeof lines === "string") {
        try {
            lines = JSON.parse(lines);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(lines)) return [];
    const out: string[] = [];
    for (const li of lines as Array<Record<string, unknown>>) {
        const k = normalizeSkuKey(li?.productId as string | undefined);
        if (k && !out.includes(k)) out.push(k);
    }
    return out;
}
