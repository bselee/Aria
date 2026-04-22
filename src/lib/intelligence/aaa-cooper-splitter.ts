import { extractPDF, extractPDFWithLLM } from "../pdf/extractor";

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
    bundlePages: number[];
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

interface SummaryInvoiceRow {
    invoiceNumber: string;
    date: string;
    amount: number | null;
}

interface BundleDraft {
    page: number;
    bundlePages: number[];
    invoiceNumber: string;
}

interface ParsedAttachmentResult {
    invoices: Array<Pick<AAASplitInvoice, "page" | "bundlePages" | "invoiceNumber" | "amount" | "date">>;
    discardedCount: number;
    weakReason?: string;
    retryRecommended?: boolean;
}

interface EvaluatedPass {
    invoices: AAASplitInvoice[];
    discardedCount: number;
    weakReason?: string;
    retryRecommended?: boolean;
    extractionStrategy: string;
}

const SUMMARY_MARKER = /customer statement summary/i;
const INVOICE_HEADER = /\binvoice\b/i;
const PRO_NUMBER_LABEL = /\bpro\s+number\b/i;
const NON_INVOICE_PAPERWORK_MARKERS = /\b(straight bill of lading|bill of lading|delivery receipt|inspection correction notice|shipment exception)\b/i;

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

        if (!firstPass.weakReason && firstPass.invoices.length > 0) {
            invoices.push(...firstPass.invoices);
            discardedCount += firstPass.discardedCount;
            latestWeakReason = undefined;
            continue;
        }

        if (!firstPass.retryRecommended) {
            latestWeakReason = firstPass.weakReason || "OCR confidence too weak";
            if (latestWeakReason) {
                sawNeedsReview = true;
            }
            continue;
        }

        const secondPass = await evaluateAttachmentPass(attachment, true);
        passUsed = 2;
        extractionStrategy = secondPass.extractionStrategy;

        if (!secondPass.weakReason && secondPass.invoices.length > 0) {
            invoices.push(...secondPass.invoices);
            discardedCount += secondPass.discardedCount;
            latestWeakReason = undefined;
            continue;
        }

        latestWeakReason = secondPass.weakReason || firstPass.weakReason || "OCR confidence too weak";
        if (latestWeakReason) {
            sawNeedsReview = true;
        }
    }

    const status: AAASplitStatus = sawNeedsReview
        ? "needs_review"
        : invoices.length > 0
            ? "split_ready"
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

    const parsed = parseAttachmentPages(extraction.pages);

    return {
        invoices: parsed.invoices.map((invoice) => ({
            attachmentId: attachment.attachmentId,
            attachmentName: attachment.filename,
            page: invoice.page,
            bundlePages: invoice.bundlePages,
            invoiceNumber: invoice.invoiceNumber,
            amount: invoice.amount,
            date: invoice.date,
        })),
        discardedCount: parsed.discardedCount,
        weakReason: parsed.weakReason,
        retryRecommended: parsed.retryRecommended,
        extractionStrategy: extraction.ocrStrategy || (forceLLM ? "forced-llm" : "unknown"),
    };
}

function parseAttachmentPages(
    pages: Array<{ pageNumber: number; text: string }>,
): ParsedAttachmentResult {
    if (!pages.length) {
        return {
            invoices: [],
            discardedCount: 0,
            weakReason: "No pages extracted from OCR",
            retryRecommended: true,
        };
    }

    const summaryPage = pages.find((page) => isSummaryPage(page.text));
    if (!summaryPage) {
        return {
            invoices: [],
            discardedCount: 0,
            weakReason: "Customer Statement Summary page not found",
            retryRecommended: true,
        };
    }

    let summaryRows = parseSummaryRows(summaryPage.text);
    const statementTotal = parseStatementAmountDue(summaryPage.text);
    const summaryAmounts = summaryRows
        .map((row) => row.amount)
        .filter((amount): amount is number => amount != null);
    const canValidateSummaryTotal = statementTotal != null && summaryAmounts.length === summaryRows.length;
    if (canValidateSummaryTotal) {
        const summaryAmountTotal = roundCurrency(summaryAmounts.reduce((sum, amount) => sum + amount, 0));
        if (!amountsMatch(summaryAmountTotal, statementTotal!)) {
            return {
                invoices: [],
                discardedCount: 0,
                weakReason: `Summary charges total $${summaryAmountTotal.toFixed(2)} does not match LOCATION/AMOUNT DUE $${statementTotal!.toFixed(2)}`,
            };
        }
    }

    const bundlePageText = new Map<number, string>();

    for (const page of pages) {
        bundlePageText.set(page.pageNumber, page.text);
    }

    const bundles: BundleDraft[] = [];
    let discardedCount = 0;
    let activeBundle: BundleDraft | null = null;

    for (const page of pages) {
        if (page.pageNumber === summaryPage.pageNumber || isSummaryPage(page.text)) {
            discardedCount++;
            continue;
        }

        if (isInvoicePage(page.text)) {
            const invoiceNumber = extractInvoiceNumber(page.text);
            if (!invoiceNumber) {
                return {
                    invoices: [],
                    discardedCount,
                    weakReason: `Invoice page ${page.pageNumber} is missing a PRO number`,
                };
            }

            if (activeBundle) bundles.push(activeBundle);
            activeBundle = {
                page: page.pageNumber,
                bundlePages: [page.pageNumber],
                invoiceNumber,
            };
            continue;
        }

        if (activeBundle) {
            activeBundle.bundlePages.push(page.pageNumber);
            continue;
        }

        discardedCount++;
    }

    if (activeBundle) bundles.push(activeBundle);

    if (bundles.length !== summaryRows.length) {
        const recoveredRows = recoverMissingSummaryRows(summaryPage.text, bundles, summaryRows);
        if (recoveredRows.length > 0) {
            summaryRows = [...summaryRows, ...recoveredRows];
        }
    }

    if (summaryRows.length === 0) {
        return {
            invoices: [],
            discardedCount,
            weakReason: "Customer Statement Summary did not yield any invoice rows",
            retryRecommended: true,
        };
    }

    if (bundles.length !== summaryRows.length) {
        return {
            invoices: [],
            discardedCount,
            weakReason: `Statement summary listed ${summaryRows.length} invoices but detected ${bundles.length} bundle(s)`,
        };
    }

    const summaryMap = new Map(summaryRows.map((row) => [normalizeInvoiceNumber(row.invoiceNumber), row]));
    const seenInvoiceNumbers = new Set<string>();
    const invoices: ParsedAttachmentResult["invoices"] = [];

    for (const bundle of bundles) {
        const normalizedBundleNumber = normalizeInvoiceNumber(bundle.invoiceNumber);
        if (seenInvoiceNumbers.has(normalizedBundleNumber)) {
            return {
                invoices: [],
                discardedCount,
                weakReason: `Duplicate bundle found for PRO ${bundle.invoiceNumber}`,
            };
        }
        seenInvoiceNumbers.add(normalizedBundleNumber);

        const summaryRow = summaryMap.get(normalizedBundleNumber);
        if (!summaryRow) {
            return {
                invoices: [],
                discardedCount,
                weakReason: `Bundle PRO ${bundle.invoiceNumber} was not present in the statement summary`,
            };
        }

        invoices.push({
            page: bundle.page,
            bundlePages: bundle.bundlePages,
            invoiceNumber: bundle.invoiceNumber,
            amount: summaryRow.amount ?? extractInvoiceAmount(bundlePageText.get(bundle.page) || ""),
            date: summaryRow.date,
        });
    }

    if (statementTotal != null) {
        const invoiceAmounts = invoices
            .map((invoice) => invoice.amount)
            .filter((amount): amount is number => amount != null);
        if (invoiceAmounts.length === invoices.length) {
            const invoiceAmountTotal = roundCurrency(invoiceAmounts.reduce((sum, amount) => sum + amount, 0));
            if (!amountsMatch(invoiceAmountTotal, statementTotal)) {
                return {
                    invoices: [],
                    discardedCount,
                    weakReason: `Bundle amounts total $${invoiceAmountTotal.toFixed(2)} does not match LOCATION/AMOUNT DUE $${statementTotal.toFixed(2)}`,
                };
            }
        }
    }

    return {
        invoices,
        discardedCount,
    };
}

function isSummaryPage(text: string): boolean {
    return SUMMARY_MARKER.test(text || "");
}

function isInvoicePage(text: string): boolean {
    if (!text || isSummaryPage(text)) return false;
    if (NON_INVOICE_PAPERWORK_MARKERS.test(text)) return false;
    return INVOICE_HEADER.test(text) && PRO_NUMBER_LABEL.test(text);
}

function parseSummaryRows(text: string): SummaryInvoiceRow[] {
    const rows: SummaryInvoiceRow[] = [];
    const seen = new Set<string>();

    for (const rawLine of (text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const match = line.match(/\b(\d{6,10})\b.*?\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b.*?(-?[\d,]+\.\d{2})\s*$/);
        if (!match) continue;

        const date = normalizeStatementDate(match[2]);
        const amount = parseCurrency(match[3]);
        if (!date || amount == null) continue;

        const invoiceNumber = normalizeInvoiceNumber(match[1]);
        if (seen.has(invoiceNumber)) continue;
        seen.add(invoiceNumber);
        rows.push({
            invoiceNumber,
            date,
            amount,
        });
    }

    if (rows.length > 0) {
        return rows;
    }

    const tokenRegex = /\b(\d{6,10})\b\s+(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+[A-Z])?/g;
    const matches = [...text.matchAll(tokenRegex)];
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const invoiceNumber = normalizeInvoiceNumber(match[1]);
        const date = normalizeStatementDate(match[2]);
        if (!date || seen.has(invoiceNumber)) continue;
        seen.add(invoiceNumber);

        const startIdx = match.index ?? 0;
        const endIdx = matches[i + 1]?.index ?? text.length;
        const window = text.slice(startIdx, endIdx);
        const amountMatch = window.match(/\$([\d,]+\.\d{2})/);

        rows.push({
            invoiceNumber,
            date,
            amount: amountMatch?.[1] ? parseCurrency(amountMatch[1]) : null,
        });
    }

    return rows;
}

function recoverMissingSummaryRows(
    summaryText: string,
    bundles: BundleDraft[],
    existingRows: SummaryInvoiceRow[],
): SummaryInvoiceRow[] {
    const existing = new Set(existingRows.map((row) => normalizeInvoiceNumber(row.invoiceNumber)));
    const recovered: SummaryInvoiceRow[] = [];

    for (const bundle of bundles) {
        const invoiceNumber = normalizeInvoiceNumber(bundle.invoiceNumber);
        if (existing.has(invoiceNumber)) continue;

        const row = recoverSummaryRow(summaryText, invoiceNumber);
        if (!row) continue;

        existing.add(invoiceNumber);
        recovered.push(row);
    }

    return recovered;
}

function recoverSummaryRow(summaryText: string, invoiceNumber: string): SummaryInvoiceRow | null {
    const idx = summaryText.indexOf(invoiceNumber);
    if (idx < 0) return null;

    const window = summaryText.slice(idx, idx + 220);
    const dateMatch = window.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    const date = dateMatch ? normalizeStatementDate(dateMatch[1]) : null;
    if (!date) return null;

    const amountMatch = window.match(/\$([\d,]+\.\d{2})/);
    const amount = amountMatch?.[1] ? parseCurrency(amountMatch[1]) : null;

    return {
        invoiceNumber,
        date,
        amount,
    };
}

function parseStatementAmountDue(text: string): number | null {
    const patterns = [
        /LOCATION\/AMOUNT DUE[^\n]*?(-?[\d,]+\.\d{2})/i,
        /AMOUNT DUE[^\n]*?(-?[\d,]+\.\d{2})/i,
        /TOTAL DUE[^\n]*?(-?[\d,]+\.\d{2})/i,
    ];

    for (const pattern of patterns) {
        const match = (text || "").match(pattern);
        if (match) {
            return parseCurrency(match[1]);
        }
    }

    return null;
}

function extractInvoiceNumber(text: string): string | null {
    const patterns = [
        /\bPRO\s+NUMBER\b\s*[:#]?\s*([A-Z0-9-]{5,})/i,
        /\bPRO\s+NUMBER\b[\s\r\n]+([A-Z0-9-]{5,})/i,
        /\bPRO\b\s*#?\s*[:#]?\s*([A-Z0-9-]{5,})/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return normalizeInvoiceNumber(match[1]);
    }

    return null;
}

function normalizeStatementDate(raw: string): string | null {
    const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!match) return null;

    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;

    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
        return null;
    }

    return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function normalizeInvoiceNumber(value: string): string {
    return value.replace(/[^A-Z0-9]/gi, "");
}

function parseCurrency(raw: string): number | null {
    const value = Number(raw.replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
}

function extractInvoiceAmount(text: string): number | null {
    const patterns = [
        /\bTOTAL CHARGES\b[^$\n]*\$([\d,]+\.\d{2})/i,
        /\bTOTAL\b[^$\n]*\$([\d,]+\.\d{2})/i,
        /\bAMOUNT DUE\b[^$\n]*\$([\d,]+\.\d{2})/i,
        /\$([\d,]+\.\d{2})/,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return parseCurrency(match[1]);
    }

    return null;
}

function roundCurrency(value: number): number {
    return Math.round(value * 100) / 100;
}

function amountsMatch(left: number, right: number): boolean {
    return Math.abs(left - right) < 0.01;
}
