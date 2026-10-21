/**
 * @file    no-freight-invoice-text.ts
 * @purpose Parse vendor invoice / packing-list text for the no-freight close.
 *          These vendors email PDFs that often never land on vendor_invoices.po_number.
 * @author  Hermia
 * @created 2026-09-28
 * @deps    none
 * @env     none
 */

export interface ParsedVendorInvoiceText {
    poNumber: string | null;
    invoiceNumber: string | null;
    subtotal: number;
    freight: number;
    total: number;
    /** qty * unit price pairs, when the PDF smashed columns together. */
    lineTotals: number[];
}

function money(raw: string | undefined): number {
    if (!raw) return 0;
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
}

function firstMoney(text: string, pattern: RegExp): number {
    const m = pattern.exec(text);
    return money(m?.[1]);
}

/**
 * Pull PO, goods, shipping, and total out of extracted invoice text.
 * Covers Stock Bag Depot, Miles Filippelli, and Colorado Worm packing slips.
 */
export function parseVendorInvoiceText(raw: string): ParsedVendorInvoiceText {
    const text = raw.replace(/\s+/g, " ").trim();

    const poMatch = /(?:Customer PO(?: No\.?)?|PO|JOB)\s*#?\s*(1\d{5})/i.exec(text)
        || /\bPO\s*(1\d{5})/i.exec(text)
        || /ORDER DATE\s+(1\d{5})/i.exec(text)
        || /P\.?\s*O\.?\s*(?:Number|#|No\.?)?\s*:?\s*(1\d{5})/i.exec(text);
    const invoiceMatch = /INVOICE\s+#?\s*(\d{5,})/i.exec(text)
        || /Invoice ID\s*([\d,]+)/i.exec(text);

    const salesAmount = firstMoney(text, /Sales Amount\s*\$?\s*([\d,]+\.\d{2})/i);
    const subtotalWord = firstMoney(text, /SUBTOTAL\s*\$?\s*([\d,]+\.\d{2})/i);
    const shipping = firstMoney(text, /Shipping Amount\s*\$?\s*([\d,]+\.\d{2})/i);
    const freight = firstMoney(text, /(?:^| )Freight\s*\$?\s*([\d,]+\.\d{2})/i);
    const totalInvoice = firstMoney(text, /Total Invoice Amount\s*\$?\s*([\d,]+\.\d{2})/i);
    const totalDue = firstMoney(text, /Total Amount Due\s*\$?\s*([\d,]+\.\d{2})/i);
    const totalLabel = firstMoney(text, /TOTAL:\s*\$?\s*([\d,]+\.\d{2})/i);

    const lineTotals: number[] = [];
    const lineRe = /\$(\d+\.\d{2})\$[\d,]+\.\d{2}/g;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(text))) {
        const unit = Number(line[1]);
        if (unit > 0 && unit < 10000) {
            const qtyRe = new RegExp(`(\\d+\\.\\d{2})\\$${line[1]}`);
            const qtyM = qtyRe.exec(text.slice(Math.max(0, line.index - 12), line.index + line[0].length));
            const qty = qtyM ? Number(qtyM[1]) : 0;
            if (qty > 0) lineTotals.push(Math.round(qty * unit * 100) / 100);
        }
    }

    const subtotal = salesAmount || subtotalWord || (totalLabel && !totalInvoice ? totalLabel : 0);
    const ship = shipping || freight;
    const total = totalInvoice || totalDue || totalLabel || (subtotal > 0 ? subtotal + ship : 0);

    return {
        poNumber: poMatch?.[1] || null,
        invoiceNumber: invoiceMatch?.[1]?.replace(/,/g, "") || null,
        subtotal,
        freight: ship,
        total,
        lineTotals,
    };
}

/**
 * True when an invoice that does not name a PO is still this order:
 * its goods total equals the PO, or a subset of the PO line totals, and
 * the invoice is not dated before the PO.
 */
export function invoiceMatchesPoLines(
    invoiceSubtotal: number,
    poLineTotals: number[],
    invoiceDate: string | null,
    orderDate: string | null,
): boolean {
    if (!(invoiceSubtotal > 0) || poLineTotals.length === 0) return false;
    if (invoiceDate && orderDate && invoiceDate.slice(0, 10) < orderDate.slice(0, 10)) return false;

    const target = Math.round(invoiceSubtotal * 100);
    const cents = poLineTotals.map(n => Math.round(n * 100)).filter(n => n > 0);
    const n = cents.length;
    if (n > 16) return false;
    for (let mask = 1; mask < (1 << n); mask++) {
        let sum = 0;
        for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cents[i];
        if (Math.abs(sum - target) <= 50) return true;
    }
    return false;
}
