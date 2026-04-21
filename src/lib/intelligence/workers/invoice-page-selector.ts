import type { PageContent } from "../../pdf/extractor";

export interface InvoicePageSelection {
    pageNumber: number | null;
    confidence: "none" | "weak" | "strong";
    reason: string;
    score: number;
}

interface PageScore {
    pageNumber: number;
    score: number;
    positiveHits: string[];
    negativeHits: string[];
}

const POSITIVE_RULES: Array<{ name: string; pattern: RegExp; score: number }> = [
    { name: "invoice_heading", pattern: /\binvoice\b/i, score: 4 },
    { name: "invoice_number", pattern: /\binvoice\s*(number|#|no\.?)\b/i, score: 3 },
    { name: "amount_due", pattern: /\bamount\s+due\b/i, score: 3 },
    { name: "bill_to", pattern: /\bbill\s+to\b/i, score: 2 },
    { name: "remit_to", pattern: /\bremit\s+to\b/i, score: 2 },
    { name: "po_number", pattern: /\bpo\s*#?\s*\d{3,}\b/i, score: 2 },
    { name: "total_due", pattern: /\b(total|balance)\s+(due|amount)\b/i, score: 2 },
    { name: "currency_total", pattern: /\$[\d,]+\.\d{2}/, score: 1 },
];

const NEGATIVE_RULES: Array<{ name: string; pattern: RegExp; score: number }> = [
    { name: "packing_slip", pattern: /\bpacking\s+slip\b/i, score: -6 },
    { name: "bill_of_lading", pattern: /\bbill\s+of\s+lading\b|\bBOL\b/i, score: -6 },
    { name: "shipment", pattern: /\bshipment\b|\btracking\b/i, score: -3 },
    { name: "statement", pattern: /\bstatement\b|\baging\b/i, score: -4 },
    { name: "quote", pattern: /\bquote\b|\bquotation\b|\bproposal\b/i, score: -4 },
    { name: "acknowledgement", pattern: /\border\s+acknowledg|\border\s+confirm/i, score: -4 },
    { name: "certificate", pattern: /\bcertificate\b|\bcoa\b|\banalysis\b/i, score: -5 },
    { name: "tax_form", pattern: /\bw-?9\b|\b1099\b|\btax\s+form\b/i, score: -5 },
    { name: "proof_of_delivery", pattern: /\bproof\s+of\s+delivery\b|\bdelivery\s+receipt\b/i, score: -5 },
];

function scoreInvoicePage(page: PageContent): PageScore {
    const text = page.text || "";
    const positiveHits = POSITIVE_RULES
        .filter((rule) => rule.pattern.test(text))
        .map((rule) => rule.name);
    const negativeHits = NEGATIVE_RULES
        .filter((rule) => rule.pattern.test(text))
        .map((rule) => rule.name);

    let score = 0;
    for (const rule of POSITIVE_RULES) {
        if (rule.pattern.test(text)) score += rule.score;
    }
    for (const rule of NEGATIVE_RULES) {
        if (rule.pattern.test(text)) score += rule.score;
    }

    // The invoice summary page is usually the earliest strongly-positive page.
    if (page.pageNumber === 1) score += 2;
    else if (page.pageNumber === 2) score += 1;

    return {
        pageNumber: page.pageNumber,
        score,
        positiveHits,
        negativeHits,
    };
}

export function pickPrimaryInvoicePage(pages: PageContent[]): InvoicePageSelection {
    if (pages.length === 0) {
        return {
            pageNumber: null,
            confidence: "none",
            reason: "no_pages_available",
            score: 0,
        };
    }

    const scoredPages = pages
        .map(scoreInvoicePage)
        .sort((left, right) => right.score - left.score || left.pageNumber - right.pageNumber);

    const best = scoredPages[0];
    const secondBest = scoredPages[1];

    if (!best) {
        return {
            pageNumber: null,
            confidence: "none",
            reason: "no_candidate_pages",
            score: 0,
        };
    }

    const bestHasCoreSignals = best.positiveHits.includes("invoice_heading")
        && (best.positiveHits.includes("invoice_number") || best.positiveHits.includes("amount_due"));
    const clearMargin = !secondBest || best.score - secondBest.score >= 2;
    const lowNoise = best.negativeHits.length === 0;
    const singlePage = pages.length === 1;

    if ((best.score >= 7 && bestHasCoreSignals && clearMargin)
        || (singlePage && best.score >= 5 && bestHasCoreSignals)
        || (best.score >= 8 && lowNoise)) {
        return {
            pageNumber: best.pageNumber,
            confidence: "strong",
            reason: `positive=${best.positiveHits.join(",") || "none"}; negative=${best.negativeHits.join(",") || "none"}`,
            score: best.score,
        };
    }

    if (best.score >= 5 && bestHasCoreSignals) {
        return {
            pageNumber: null,
            confidence: "weak",
            reason: `ambiguous_best_page_${best.pageNumber}`,
            score: best.score,
        };
    }

    return {
        pageNumber: null,
        confidence: "none",
        reason: "no_strong_invoice_page",
        score: best.score,
    };
}
