import type {
    ArchivedVendorInvoice,
    NormalizedStatement,
    StatementReconciliationLineResult,
    StatementReconciliationRunSummary,
} from "./types";

function normalizeText(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function dateDistanceDays(a: string | null | undefined, b: string | null | undefined): number {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const aMs = new Date(a).getTime();
    const bMs = new Date(b).getTime();
    if (Number.isNaN(aMs) || Number.isNaN(bMs)) return Number.POSITIVE_INFINITY;
    return Math.abs(aMs - bMs) / 86_400_000;
}

function amountDistance(a: number | null | undefined, b: number | null | undefined): number {
    if (a == null || b == null) return Number.POSITIVE_INFINITY;
    return Math.abs(a - b);
}

function buildSummary(lines: StatementReconciliationLineResult[]): StatementReconciliationRunSummary {
    const matchedCount = lines.filter((line) => line.status === "verified").length;
    const missingCount = lines.filter((line) => line.status === "missing").length;
    const mismatchCount = lines.filter((line) => line.status === "amount_mismatch").length;
    const duplicateCount = lines.filter((line) => line.status === "duplicate_candidate").length;
    const needsReviewCount = lines.filter((line) => line.status === "needs_review").length;

    let confidence: StatementReconciliationRunSummary["confidence"] = "high";
    if (needsReviewCount > 0 || duplicateCount > 0) confidence = "medium";
    if (missingCount > 0 || mismatchCount > 0) confidence = "low";

    return {
        matchedCount,
        missingCount,
        mismatchCount,
        duplicateCount,
        needsReviewCount,
        confidence,
    };
}

export function reconcileStatementAgainstInvoices(
    statement: NormalizedStatement,
    invoices: ArchivedVendorInvoice[],
): {
    lines: StatementReconciliationLineResult[];
    summary: StatementReconciliationRunSummary;
} {
    const vendorInvoices = invoices.filter(
        (invoice) => normalizeText(invoice.vendor_name) === normalizeText(statement.vendorName),
    );

    const lines = statement.lines
        .filter((line) => line.documentType === "invoice")
        .map<StatementReconciliationLineResult>((line) => {
            const exactMatches = line.referenceNumber
                ? vendorInvoices.filter(
                    (invoice) => normalizeText(invoice.invoice_number) === normalizeText(line.referenceNumber),
                )
                : [];

            const invoiceIds = (matches: ArchivedVendorInvoice[]) => matches.map((invoice) => invoice.id);
            const invoiceNumbers = (matches: ArchivedVendorInvoice[]) =>
                matches.map((invoice) => invoice.invoice_number ?? "").filter(Boolean);
            const poNumbers = (matches: ArchivedVendorInvoice[]) =>
                matches.map((invoice) => invoice.po_number ?? "").filter(Boolean);

            if (exactMatches.length > 1) {
                return {
                    referenceNumber: line.referenceNumber,
                    status: "duplicate_candidate",
                    amount: line.amount,
                    matchedInvoiceIds: invoiceIds(exactMatches),
                    matchedInvoiceNumbers: invoiceNumbers(exactMatches),
                    matchedPoNumbers: poNumbers(exactMatches),
                    vendorAmount: line.amount,
                    ourAmount: exactMatches[0]?.total ?? null,
                    delta: exactMatches[0]?.total == null ? null : line.amount - Number(exactMatches[0].total),
                    notes: ["Multiple archived invoices share this invoice number."],
                };
            }

            if (exactMatches.length === 1) {
                const matched = exactMatches[0];
                const ourAmount = matched.total == null ? null : Number(matched.total);
                const delta = ourAmount == null ? null : line.amount - ourAmount;
                return {
                    referenceNumber: line.referenceNumber,
                    status: delta != null && Math.abs(delta) >= 0.01 ? "amount_mismatch" : "verified",
                    amount: line.amount,
                    matchedInvoiceIds: [matched.id],
                    matchedInvoiceNumbers: invoiceNumbers([matched]),
                    matchedPoNumbers: poNumbers([matched]),
                    vendorAmount: line.amount,
                    ourAmount,
                    delta,
                    notes: delta != null && Math.abs(delta) >= 0.01
                        ? ["Invoice number matched, but amount differs from vendor archive."]
                        : ["Exact invoice match found in vendor archive."],
                };
            }

            const weakMatches = vendorInvoices.filter((invoice) => {
                const poMatch = line.poNumber && invoice.po_number && normalizeText(invoice.po_number) === normalizeText(line.poNumber);
                const dateClose = dateDistanceDays(line.date, invoice.invoice_date) <= 7;
                const amountClose = amountDistance(line.amount, invoice.total) < 0.01;
                return Boolean((poMatch && amountClose) || (dateClose && amountClose));
            });

            if (weakMatches.length > 0) {
                return {
                    referenceNumber: line.referenceNumber,
                    status: "needs_review",
                    amount: line.amount,
                    matchedInvoiceIds: invoiceIds(weakMatches),
                    matchedInvoiceNumbers: invoiceNumbers(weakMatches),
                    matchedPoNumbers: poNumbers(weakMatches),
                    vendorAmount: line.amount,
                    ourAmount: null,
                    delta: null,
                    notes: ["Partial matches found; human review required."],
                };
            }

            return {
                referenceNumber: line.referenceNumber,
                status: "missing",
                amount: line.amount,
                matchedInvoiceIds: [],
                matchedInvoiceNumbers: [],
                matchedPoNumbers: [],
                vendorAmount: line.amount,
                ourAmount: null,
                delta: null,
                notes: ["No archived invoice matched this statement line."],
            };
        });

    return {
        lines,
        summary: buildSummary(lines),
    };
}
