import { extractPDF, extractPDFWithLLM, type PDFExtractionResult } from "../pdf/extractor";
import {
    filterStatementInvoicePages,
    type StatementInvoicePageCandidate,
} from "./workers/ap-identifier-statement-filter";

export type AAASplitStatus = "split_ready" | "no_invoice_pages" | "needs_review";

export interface AAASplitAttachmentInput {
    attachmentId?: string;
    filename: string;
    pdfBuffer: Buffer;
}

export interface AAASplitInvoice {
    attachmentId?: string;
    attachmentName: string;
    page: number;
    invoiceNumber: string | null;
    amount: number | null;
    date: string | null;
}

export interface AAASplitDiagnostics {
    passUsed: 1 | 2;
    extractionStrategy: string;
    weakReason?: string;
    processedAttachmentCount: number;
    processedAttachmentIds: string[];
}

export interface AAASplitResult {
    status: AAASplitStatus;
    invoices: AAASplitInvoice[];
    discardedCount: number;
    diagnostics: AAASplitDiagnostics;
}

interface EvaluatedPass {
    invoicePages: StatementInvoicePageCandidate[];
    discardedCount: number;
    weakReason?: string;
    extractionStrategy: string;
}

const BLANK_PAGE_RATIO_THRESHOLD = 0.5;
const MIN_STRONG_PAGE_TEXT_LENGTH = 40;

export async function splitAAACooperStatementAttachments(
    input: { attachments: AAASplitAttachmentInput[] },
): Promise<AAASplitResult> {
    const invoices: AAASplitInvoice[] = [];
    let discardedCount = 0;
    let passUsed: 1 | 2 = 1;
    let extractionStrategy = "unknown";
    const processedAttachmentIds: string[] = [];
    let latestWeakReason: string | undefined;
    let sawNeedsReview = false;

    for (const attachment of input.attachments) {
        processedAttachmentIds.push(attachment.attachmentId || attachment.filename);

        const firstPass = await evaluateAttachmentPass(attachment, false);
        extractionStrategy = firstPass.extractionStrategy;

        if (!firstPass.weakReason && firstPass.invoicePages.length > 0) {
            invoices.push(...mapInvoices(attachment, firstPass.invoicePages));
            discardedCount += firstPass.discardedCount;
            continue;
        }

        const secondPass = await evaluateAttachmentPass(attachment, true);
        passUsed = 2;
        extractionStrategy = secondPass.extractionStrategy;

        if (secondPass.invoicePages.length > 0 && !secondPass.weakReason) {
            invoices.push(...mapInvoices(attachment, secondPass.invoicePages));
            discardedCount += secondPass.discardedCount;
            latestWeakReason = undefined;
            continue;
        }

        latestWeakReason = secondPass.weakReason || firstPass.weakReason || "OCR confidence too weak";
        if ((firstPass.invoicePages.length === 0 && secondPass.invoicePages.length === 0) && latestWeakReason) {
            sawNeedsReview = true;
        }
    }

    const status: AAASplitStatus = invoices.length > 0
        ? "split_ready"
        : sawNeedsReview
            ? "needs_review"
            : "no_invoice_pages";

    return {
        status,
        invoices,
        discardedCount,
        diagnostics: {
            passUsed,
            extractionStrategy,
            weakReason: latestWeakReason,
            processedAttachmentCount: input.attachments.length,
            processedAttachmentIds,
        },
    };
}

async function evaluateAttachmentPass(
    attachment: AAASplitAttachmentInput,
    forceLLM: boolean,
): Promise<EvaluatedPass> {
    const extraction = forceLLM
        ? await extractPDFWithLLM(attachment.pdfBuffer)
        : await extractPDF(attachment.pdfBuffer);

    const pageCandidates = extraction.pages.map((page) => buildCandidate(page.pageNumber, page.text));
    const filtered = filterStatementInvoicePages("AAA Cooper", pageCandidates);
    const weakReason = getWeakReason(extraction, filtered.invoicePages);

    return {
        invoicePages: filtered.invoicePages,
        discardedCount: filtered.discardedCount,
        weakReason,
        extractionStrategy: extraction.ocrStrategy || (forceLLM ? "forced-llm" : "unknown"),
    };
}

function buildCandidate(pageNumber: number, text: string): StatementInvoicePageCandidate {
    const normalized = text || "";
    const upper = normalized.toUpperCase();
    const type = upper.includes("INVOICE") ? "INVOICE" : "OTHER";

    const invoiceNumberMatch =
        normalized.match(/\b(?:PRO|INVOICE)\s*NUMBER\b[:#\s-]*([A-Z0-9-]{5,})/i) ||
        normalized.match(/\b(\d{6,10})\b/);
    const amountMatch =
        normalized.match(/\b(?:TOTAL|AMOUNT DUE|BALANCE DUE|CHARGES?)\b[^$\n]*\$([\d,]+\.\d{2})/i) ||
        normalized.match(/\$([\d,]+\.\d{2})/);
    const dateMatch = normalized.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/);

    return {
        page: pageNumber,
        type,
        invoiceNumber: invoiceNumberMatch?.[1] || null,
        amount: amountMatch?.[1] ? Number(amountMatch[1].replace(/,/g, "")) : null,
        date: dateMatch?.[0] || null,
        text: normalized,
    };
}

function getWeakReason(
    extraction: PDFExtractionResult,
    invoicePages: StatementInvoicePageCandidate[],
): string | undefined {
    if (!extraction.pages.length) {
        return "No pages extracted from OCR";
    }

    const blankPages = extraction.pages.filter((page) => page.text.trim().length < MIN_STRONG_PAGE_TEXT_LENGTH).length;
    if (blankPages / extraction.pages.length >= BLANK_PAGE_RATIO_THRESHOLD) {
        return "OCR returned too many weak pages";
    }

    if (invoicePages.length === 0) {
        return "No invoice pages identified with enough confidence";
    }

    return undefined;
}

function mapInvoices(
    attachment: AAASplitAttachmentInput,
    invoicePages: StatementInvoicePageCandidate[],
): AAASplitInvoice[] {
    return invoicePages.map((invoicePage) => ({
        attachmentId: attachment.attachmentId,
        attachmentName: attachment.filename,
        page: invoicePage.page,
        invoiceNumber: invoicePage.invoiceNumber || null,
        amount: invoicePage.amount ?? null,
        date: null,
    }));
}
