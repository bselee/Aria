import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pdf/extractor", () => ({
    extractPDF: vi.fn(),
    extractPDFWithLLM: vi.fn(),
}));

import { extractPDF, extractPDFWithLLM } from "../pdf/extractor";
import { splitAAACooperStatementAttachments } from "./aaa-cooper-splitter";

const mockedExtractPDF = vi.mocked(extractPDF);
const mockedExtractPDFWithLLM = vi.mocked(extractPDFWithLLM);

describe("splitAAACooperStatementAttachments", () => {
    const makeAttachment = (attachmentId: string, filename: string) => ({
        attachmentId,
        filename,
        pdfBuffer: Buffer.from(`${attachmentId}-${filename}`),
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns split_ready from the statement summary and preserves bundle pages", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: "AAA Cooper Transportation\nCover letter for customer statement",
                    hasTable: false,
                },
                {
                    pageNumber: 2,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "PRO DATE CHARGES",
                        "64471581 04/15/26 508.00",
                        "64471582 04/16/26 509.25",
                        "LOCATION/AMOUNT DUE 1,017.25",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 3,
                    text: "AAA Cooper Transportation\nINVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
                {
                    pageNumber: 4,
                    text: "STRAIGHT BILL OF LADING\nPRO 64471581",
                    hasTable: false,
                },
                {
                    pageNumber: 5,
                    text: "DELIVERY RECEIPT\nPRO 64471581",
                    hasTable: false,
                },
                {
                    pageNumber: 6,
                    text: "AAA Cooper Transportation\nINVOICE\nPRO NUMBER\n64471582\nTOTAL CHARGES $509.25",
                    hasTable: false,
                },
                {
                    pageNumber: 7,
                    text: "INSPECTION CORRECTION NOTICE\nPRO 64471582",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 7, fileSize: 10 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 12,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(mockedExtractPDFWithLLM).not.toHaveBeenCalled();
        expect(result.status).toBe("split_ready");
        expect(result.discardedCount).toBe(2);
        expect(result.invoices).toEqual([
            expect.objectContaining({
                attachmentId: "att-1",
                attachmentName: "ACT_STMD_001.pdf",
                page: 3,
                bundlePages: [3, 4, 5],
                invoiceNumber: "64471581",
                amount: 508,
                date: "2026-04-15",
            }),
            expect.objectContaining({
                attachmentId: "att-1",
                attachmentName: "ACT_STMD_001.pdf",
                page: 6,
                bundlePages: [6, 7],
                invoiceNumber: "64471582",
                amount: 509.25,
                date: "2026-04-16",
            }),
        ]);
        expect(result.diagnostics.passUsed).toBe(1);
    });

    it("escalates to the second OCR pass when the first pass cannot parse the summary", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "weak scan",
            pages: [
                { pageNumber: 1, text: "AAA Cooper scan", hasTable: false },
            ],
            tables: [],
            metadata: { pageCount: 1, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 20,
        });
        mockedExtractPDFWithLLM.mockResolvedValue({
            rawText: "better scan",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471581 04/15/26 508.00",
                        "LOCATION/AMOUNT DUE 508.00",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "google/gemini-2.5-flash",
            ocrDurationMs: 120,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(mockedExtractPDFWithLLM).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("split_ready");
        expect(result.diagnostics.passUsed).toBe(2);
        expect(result.invoices[0]).toEqual(expect.objectContaining({
            bundlePages: [2],
            invoiceNumber: "64471581",
            date: "2026-04-15",
            amount: 508,
        }));
    });

    it("returns needs_review when the summary count does not match the detected bundles", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471581 04/15/26 508.00",
                        "64471582 04/16/26 509.25",
                        "LOCATION/AMOUNT DUE 1,017.25",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 10 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 15,
        });
        mockedExtractPDFWithLLM.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471581 04/15/26 508.00",
                        "64471582 04/16/26 509.25",
                        "LOCATION/AMOUNT DUE 1,017.25",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "google/gemini-2.5-flash",
            ocrDurationMs: 120,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(result.status).toBe("needs_review");
        expect(result.diagnostics.weakReason).toMatch(/summary.*2/i);
        expect(result.diagnostics.weakReason).toMatch(/1 bundle/i);
    });

    it("returns needs_review when the summary charges do not match the statement total", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471581 04/15/26 508.00",
                        "64471582 04/16/26 509.25",
                        "LOCATION/AMOUNT DUE 999.25",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
                {
                    pageNumber: 3,
                    text: "INVOICE\nPRO NUMBER\n64471582\nTOTAL CHARGES $509.25",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 3, fileSize: 10 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 15,
        });
        mockedExtractPDFWithLLM.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471581 04/15/26 508.00",
                        "64471582 04/16/26 509.25",
                        "LOCATION/AMOUNT DUE 999.25",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471581\nTOTAL CHARGES $508.00",
                    hasTable: false,
                },
                {
                    pageNumber: 3,
                    text: "INVOICE\nPRO NUMBER\n64471582\nTOTAL CHARGES $509.25",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 3, fileSize: 10 },
            hasImages: true,
            ocrStrategy: "google/gemini-2.5-flash",
            ocrDurationMs: 120,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(result.status).toBe("needs_review");
        expect(result.diagnostics.weakReason).toMatch(/amount due|summary charges|999\.25/i);
    });

    it("recovers a summary row when header noise separates the PRO and date", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "PRO",
                        "64471588",
                        "DATE",
                        "P/C",
                        "BOL",
                        "PCS",
                        "WGT",
                        "CHARGES",
                        "03/25/26 P",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nPRO NUMBER\n64471588\nTOTAL CHARGES $334.10",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 10 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 10,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(result.status).toBe("split_ready");
        expect(result.invoices[0]).toEqual(expect.objectContaining({
            invoiceNumber: "64471588",
            date: "2026-03-25",
            amount: 334.1,
        }));
    });

    it("does not treat companion paperwork pages with invoice footer text as new bundles", async () => {
        mockedExtractPDF.mockResolvedValue({
            rawText: "AAA Cooper statement",
            pages: [
                {
                    pageNumber: 1,
                    text: [
                        "CUSTOMER STATEMENT SUMMARY",
                        "64471588 03/25/26 334.10",
                        "LOCATION/AMOUNT DUE 334.10",
                    ].join("\n"),
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "INVOICE\nCUSTOMER NUMBER 1159492\nBILL TO BUILDASOIL\nPRO NUMBER 64471588\nTOTAL CHARGES $334.10",
                    hasTable: false,
                },
                {
                    pageNumber: 3,
                    text: "DELIVERY RECEIPT\nINVOICE CUSTOMER NUMBER 1159492\nPRO NUMBER 64471588",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 3, fileSize: 10 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 10,
        });

        const result = await splitAAACooperStatementAttachments({
            attachments: [makeAttachment("att-1", "ACT_STMD_001.pdf")],
        });

        expect(result.status).toBe("split_ready");
        expect(result.invoices).toHaveLength(1);
        expect(result.invoices[0]).toEqual(expect.objectContaining({
            bundlePages: [2, 3],
            invoiceNumber: "64471588",
        }));
    });
});
