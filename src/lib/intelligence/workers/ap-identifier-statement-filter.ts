export interface StatementInvoicePageCandidate {
    page: number;
    type: string;
    invoiceNumber?: string | null;
    amount?: number | null;
    text?: string;
}

export interface StatementInvoiceFilterResult {
    invoicePages: StatementInvoicePageCandidate[];
    discardedCount: number;
}

function hasInvoiceHeading(text: string): boolean {
    return /\binvoice\b/i.test(text);
}

function hasBillingIdentifier(text: string): boolean {
    return /\b(invoice|pro)\s*number\b/i.test(text);
}

function hasBillingAmounts(text: string): boolean {
    return /\b(charges?|rate|total|amount due|balance due|due date|adv|beyond)\b/i.test(text) &&
        /\$[\d,]+\.\d{2}/.test(text);
}

function hasNonInvoicePaperworkMarkers(text: string): boolean {
    return /\b(bill of lading|delivery receipt|inspection correction notice|shipment exception)\b/i.test(text);
}

export function isAAACooperInvoicePage(text: string): boolean {
    if (!hasInvoiceHeading(text)) {
        return false;
    }

    if (!hasBillingIdentifier(text)) {
        return false;
    }

    if (!hasBillingAmounts(text)) {
        return false;
    }

    if (hasNonInvoicePaperworkMarkers(text)) {
        return false;
    }

    return true;
}

export function filterStatementInvoicePages(
    vendorLabel: string,
    pageCandidates: StatementInvoicePageCandidate[],
): StatementInvoiceFilterResult {
    if (!/aaa\s*cooper/i.test(vendorLabel)) {
        return {
            invoicePages: pageCandidates.filter((page) => page.type === "INVOICE"),
            discardedCount: 0,
        };
    }

    const invoicePages: StatementInvoicePageCandidate[] = [];
    let discardedCount = 0;

    for (const candidate of pageCandidates) {
        if (candidate.type !== "INVOICE") {
            continue;
        }

        if (candidate.text && isAAACooperInvoicePage(candidate.text)) {
            invoicePages.push(candidate);
            continue;
        }

        discardedCount++;
    }

    return { invoicePages, discardedCount };
}

export function buildStatementSplitSummary(
    vendorLabel: string,
    invoicePages: StatementInvoicePageCandidate[],
    discardedCount: number,
): string {
    return `✂️ ${vendorLabel} Statement Split\nSplit ${invoicePages.length} invoice(s); discarded ${discardedCount} non-invoice page(s)`;
}
