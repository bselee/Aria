import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pdf/extractor", () => ({
    extractPDF: vi.fn(),
    extractPDFWithLLM: vi.fn(),
}));

vi.mock("./workers/ap-identifier-statement-filter", () => ({
    filterStatementInvoicePages: vi.fn(),
}));

import { extractPDF, extractPDFWithLLM } from "../pdf/extractor";
import { filterStatementInvoicePages } from "./workers/ap-identifier-statement-filter";
import { splitAAACooperStatementAttachments } from "./aaa-cooper-splitter";

const mockedExtractPDF = vi.mocked(extractPDF);
const mockedExtractPDFWithLLM = vi.mocked(extractPDFWithLLM);
const mockedFilterStatementInvoicePages = vi.mocked(filterStatementInvoicePages);

describe("splitAAACooperStatementAttachments", () => {
    const makeAttachment = (attachmentId: string, filename: string) => ({
        attachmentId,
        filename,
        pdfBuffer: Buffer.from(`${attachmentId}-${filename}`),
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns split_ready on a strong first-pass OCR result", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581",
            pages: [
                { pageNumber: 1, text: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581", hasTable: false },
                { pageNumber: 2, text: "AAA COOPER TRANSPORTATION\nBILL OF LADING", hasTable: false },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "anthropic",
            ocrDurationMs: 100,
        });
        mockedFilterStatementInvoicePages.mockReturnValue({
            invoicePages: [{ page: 1, type: "INVOICE", invoiceNumber: "64471581", amount: 508.0 }],
            discardedCount: 1,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(mockedExtractPDFWithLLM).not.toHaveBeenCalled();
        expect(result.status).toBe("split_ready");
        expect(result.invoices).toHaveLength(1);
        expect(result.diagnostics.passUsed).toBe(1);
        expect(result.diagnostics.processedAttachmentCount).toBe(1);
    });

    it("escalates to a second OCR pass when the first pass is weak", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA COOPER\nSCAN",
            pages: [{ pageNumber: 1, text: "AAA COOPER\nSCAN", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 20,
        });
        mockedExtractPDFWithLLM.mockResolvedValue({
            rawText: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581\nTOTAL $508.00",
            pages: [{ pageNumber: 1, text: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581\nTOTAL $508.00", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "anthropic",
            ocrDurationMs: 120,
        });
        mockedFilterStatementInvoicePages
            .mockReturnValueOnce({
                invoicePages: [],
                discardedCount: 0,
            })
            .mockReturnValueOnce({
                invoicePages: [{ page: 1, type: "INVOICE", invoiceNumber: "64471581", amount: 508.0 }],
                discardedCount: 0,
            });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(mockedExtractPDFWithLLM).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("split_ready");
        expect(result.diagnostics.passUsed).toBe(2);
    });

    it("returns needs_review when the second OCR pass is still ambiguous", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA COOPER\nSCAN",
            pages: [{ pageNumber: 1, text: "AAA COOPER\nSCAN", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 20,
        });
        mockedExtractPDFWithLLM.mockResolvedValue({
            rawText: "AAA COOPER\nSTILL TOO WEAK",
            pages: [{ pageNumber: 1, text: "AAA COOPER\nSTILL TOO WEAK", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "anthropic",
            ocrDurationMs: 120,
        });
        mockedFilterStatementInvoicePages.mockReturnValue({
            invoicePages: [],
            discardedCount: 0,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(mockedExtractPDFWithLLM).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("needs_review");
        expect(result.diagnostics.weakReason).toMatch(/weak|ocr|confidence|invoice/i);
    });

    it("processes every attachment instead of only the first PDF", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581",
            pages: [{ pageNumber: 1, text: "AAA COOPER TRANSPORTATION\nINVOICE\nPRO NUMBER 64471581", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "anthropic",
            ocrDurationMs: 100,
        });
        mockedFilterStatementInvoicePages.mockReturnValue({
            invoicePages: [{ page: 1, type: "INVOICE", invoiceNumber: "64471581", amount: 508.0 }],
            discardedCount: 0,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [
                makeAttachment("att-1", "ACT_STMD_001.pdf"),
                makeAttachment("att-2", "ACT_STMD_002.pdf"),
            ],
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(2);
        expect(mockedFilterStatementInvoicePages).toHaveBeenCalledTimes(2);
        expect(result.diagnostics.processedAttachmentCount).toBe(2);
        expect(result.invoices).toHaveLength(2);
    });
});
