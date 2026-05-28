/**
 * @file    src/lib/intelligence/ap/retry-policy.ts
 * @purpose Pure functions for evaluating parsed invoice data quality
 *          and deciding whether OCR retry is warranted.
 * @author  Will / Antigravity / Hermia
 * @created 2026-05-28
 * @deps    none (pure logic, no side effects)
 * @extracted-from src/lib/intelligence/ap-agent.ts lines 99-200
 */

/** Minimal interface — just the fields retry-policy needs */
interface InvoiceDataLite {
    poNumber?: string | null;
    vendorName?: string;
    total?: number;
    confidence?: string;
    freight?: number | null;
    tax?: number | null;
    lineItems?: Array<{
        description?: string;
        total?: number | null;
        qty?: number | null;
        unitPrice?: number | null;
    }>;
}

/**
 * Count line items that have meaningful content (non-empty description + positive amount).
 */
export function countMeaningfulLineItems(invoice: InvoiceDataLite): number {
    return (invoice.lineItems || []).filter((li) => {
        const description = (li.description || "").trim();
        const amount = (li.total && li.total > 0)
            ? li.total
            : (li.qty ?? 0) * (li.unitPrice ?? 0);
        return description.length > 0 && amount >= 0;
    }).length;
}

/**
 * Sum the line item subtotals.
 */
export function getInvoiceLineSubtotal(invoice: InvoiceDataLite): number {
    return (invoice.lineItems || []).reduce((sum, li) => {
        if (li.total && li.total > 0) return sum + li.total;
        return sum + ((li.qty ?? 0) * (li.unitPrice ?? 0));
    }, 0);
}

/**
 * Check whether an invoice has the core signals needed for reconciliation.
 */
export function hasCoreReconciliationSignals(invoice: InvoiceDataLite): boolean {
    return Boolean(
        invoice.poNumber?.trim() &&
        invoice.vendorName !== "UNKNOWN" &&
        (invoice.total ?? 0) > 0 &&
        countMeaningfulLineItems(invoice) > 0
    );
}

/**
 * Score the parse quality of an invoice (0-10).
 * Higher = better OCR extraction quality.
 */
export function getInvoiceParseScore(invoice: InvoiceDataLite): number {
    let score = 0;
    if (invoice.poNumber?.trim()) score += 3;
    if (invoice.vendorName !== "UNKNOWN") score += 2;
    if ((invoice.total ?? 0) > 0) score += 2;
    if (countMeaningfulLineItems(invoice) > 0) score += 2;
    if (invoice.confidence !== "low") score += 1;
    return score;
}

/**
 * Determine why OCR should be retried and whether it's worth retrying.
 */
export function getOCRRetryReasons(invoice: InvoiceDataLite): string[] {
    const reasons: string[] = [];
    const lineItemCount = countMeaningfulLineItems(invoice);
    const hasCore = hasCoreReconciliationSignals(invoice);

    if (!invoice.poNumber) reasons.push("po_missing");
    if (lineItemCount === 0) reasons.push("zero_line_items");
    if (invoice.vendorName === "UNKNOWN") reasons.push("vendor_unknown");
    if ((invoice.total ?? 0) === 0) reasons.push("total_zero");
    if (invoice.confidence === "low" && !hasCore) reasons.push("low_confidence");

    if (!invoice.poNumber && lineItemCount > 0 && (invoice.total ?? 0) > 0) {
        const lineSubtotal = getInvoiceLineSubtotal(invoice);
        const knownCharges =
            (invoice.freight ?? 0) +
            (invoice.tax ?? 0) +
            lineSubtotal;
        if (Math.abs(knownCharges - (invoice.total ?? 0)) > 1) {
            reasons.push("subtotal_mismatch");
        }
    }

    return reasons;
}

/**
 * Full OCR retry decision: should we retry, and why?
 */
export function evaluateOCRRetry(invoice: InvoiceDataLite): {
    shouldRetry: boolean;
    reasons: string[];
    parseScore: number;
    hasCoreSignals: boolean;
} {
    const reasons = getOCRRetryReasons(invoice);
    const parseScore = getInvoiceParseScore(invoice);
    const hasCore = hasCoreReconciliationSignals(invoice);
    const shouldRetry = reasons.length > 0 && parseScore < 6 && !hasCore;

    return { shouldRetry, reasons, parseScore, hasCoreSignals: hasCore };
}
