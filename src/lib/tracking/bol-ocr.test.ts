/**
 * @file    src/lib/tracking/bol-ocr.test.ts
 * @purpose Workstream 1 unit tests — scanned BOL vision OCR decision logic.
 *          extractPDF is fully mocked: no live vision APIs are ever hit here.
 *          Covers the plan's acceptance criteria:
 *            - sparse PDF text + BOL filename → vision path (mock extractPDF)
 *            - dense digital PDF → never calls vision
 *            - real BOL fixture text (PRO NUMBER / Bill of Lading) extracts
 *              without vision
 * @created 2026-08-05
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the whole extractor module before importing bol-ocr so no real vision
// client (OpenRouter/Gemini/tesseract) can ever be reached in tests.
vi.mock("../pdf/extractor", () => ({
    extractPDF: vi.fn(),
}));

import { extractPDF } from "../pdf/extractor";
import {
    extractBolText,
    isBOLFilename,
    shouldUseVisionForBol,
    SPARSE_TEXT_CHAR_THRESHOLD,
    MAX_VISION_PAGES,
} from "./bol-ocr";

const mockedExtractPDF = vi.mocked(extractPDF);

const VISION_TEXT =
    "BILL OF LADING\nShipper: BuildASoil\nPRO NUMBER: 714736261\nCarrier: AAA Cooper Transport\nPO #125100";

/** Dense digital-PDF text — over the 40 non-ws char sparse threshold. */
const DENSE_TEXT = `BILL OF LADING
Shipper: BuildASoil
Consignee: BuildASoil Soil Division
PRO NUMBER: 714736261
Carrier: AAA Cooper Transport
Freight collect, palletized, 4 skids 2000 lbs
PO #125100
BOL date 08/01/2026`;

const SPARSE_TEXT = "PRO NUMBER"; // ~10 non-ws chars → sparse candidate

beforeEach(() => {
    vi.clearAllMocks();
    mockedExtractPDF.mockResolvedValue({
        rawText: VISION_TEXT,
        pages: [],
        tables: [],
        metadata: { pageCount: 1, fileSize: 1024 },
        hasImages: true,
        ocrStrategy: "google/gemini-2.5-flash",
        ocrDurationMs: 500,
    } as any);
});

// ── isBOLFilename ──────────────────────────────────────────────────────────

describe("isBOLFilename", () => {
    it("matches BOL-style filenames", () => {
        expect(isBOLFilename("BOL-71473626.pdf")).toBe(true);
        expect(isBOLFilename("bill-of-lading.pdf")).toBe(true);
        expect(isBOLFilename("bill_of_lading.pdf")).toBe(true);
        expect(isBOLFilename("B/L 71473626.pdf")).toBe(true);
        expect(isBOLFilename("PRO NUMBER.pdf")).toBe(true);
        expect(isBOLFilename("ltl_estes.pdf")).toBe(true);
        expect(isBOLFilename("BL-71473626.pdf")).toBe(true);
    });

    it("rejects non-BOL filenames", () => {
        expect(isBOLFilename("invoice-12345.pdf")).toBe(false);
        expect(isBOLFilename("receipt.pdf")).toBe(false);
        expect(isBOLFilename("purchase-order.pdf")).toBe(false);
        expect(isBOLFilename("packing-slip.pdf")).toBe(false);
        expect(isBOLFilename("bluetooth-guide.pdf")).toBe(false);
        expect(isBOLFilename("proforma.pdf")).toBe(false);
        expect(isBOLFilename(null)).toBe(false);
        expect(isBOLFilename(undefined)).toBe(false);
    });
});

// ── shouldUseVisionForBol (pure decision) ─────────────────────────────────

describe("shouldUseVisionForBol", () => {
    it("never triggers vision for dense digital text, even with BOL filename", () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: DENSE_TEXT,
            filename: "BOL.pdf",
        });
        expect(decision.run).toBe(false);
        expect(decision.reason).toBeNull();
    });

    it("treats exactly SPARSE_TEXT_CHAR_THRESHOLD non-ws chars as dense", () => {
        const exactly = "x".repeat(SPARSE_TEXT_CHAR_THRESHOLD);
        expect(shouldUseVisionForBol({ pdfParseText: exactly }).run).toBe(false);
        const below = "x".repeat(SPARSE_TEXT_CHAR_THRESHOLD - 1);
        expect(shouldUseVisionForBol({ pdfParseText: below, emailContext: "freight" }).run).toBe(true);
    });

    it("triggers vision for sparse text with BOL filename", () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: SPARSE_TEXT,
            filename: "BOL-71473626.pdf",
        });
        expect(decision).toEqual({ run: true, reason: "bol_filename" });
    });

    it("triggers vision for sparse text when an LTL carrier is in the email context", () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: SPARSE_TEXT,
            filename: "document.pdf",
            emailContext: "Subject: Shipment from AAA Cooper Transport\nfrom: ops@aaacooper.com",
        });
        expect(decision).toEqual({ run: true, reason: "ltl_carrier" });
    });

    it("triggers vision for sparse text with shipping keywords in context", () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: SPARSE_TEXT,
            filename: "scan-0001.pdf",
            emailContext: "Your freight shipment bill of lading is attached",
        });
        expect(decision).toEqual({ run: true, reason: "sparse_shipping_keywords" });
    });

    it("does not trigger vision for sparse text with no BOL signals", () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: SPARSE_TEXT,
            filename: "scan-0001.pdf",
            emailContext: "Invoice payment reminder",
        });
        expect(decision.run).toBe(false);
    });

    it(`skips vision when pageCount exceeds MAX_VISION_PAGES (${MAX_VISION_PAGES})`, () => {
        const decision = shouldUseVisionForBol({
            pdfParseText: SPARSE_TEXT,
            pageCount: MAX_VISION_PAGES + 1,
            filename: "BOL.pdf",
            emailContext: "AAA Cooper freight",
        });
        expect(decision.run).toBe(false);
    });
});

// ── extractBolText (integration of decision + mocked extractPDF) ──────────

describe("extractBolText", () => {
    it("sparse PDF text + BOL filename triggers the vision path and tags email_ingest_bol_vision", async () => {
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4 scanned"),
            filename: "BOL-71473626.pdf",
            pdfParseText: SPARSE_TEXT,
            pageCount: 1,
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(result.visionUsed).toBe(true);
        expect(result.source).toBe("email_ingest_bol_vision");
        expect(result.text).toContain("PRO NUMBER: 714736261");
        expect(result.decision.reason).toBe("bol_filename");
    });

    it("dense digital PDF never calls vision (pdf-parse text returned untouched)", async () => {
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4 digital"),
            filename: "BOL-71473626.pdf", // BOL name alone is NOT enough when dense
            emailContext: "AAA Cooper Transport",
            pdfParseText: DENSE_TEXT,
            pageCount: 1,
        });

        expect(mockedExtractPDF).not.toHaveBeenCalled();
        expect(result.visionUsed).toBe(false);
        expect(result.source).toBe("pdf-parse");
        expect(result.text).toBe(DENSE_TEXT.trim());
    });

    it("digital BOL fixture (PRO NUMBER / Bill of Lading) extracts without vision", async () => {
        // Acceptance: real fixture text still extracts on pdf-parse only.
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4"),
            filename: "bill-of-lading.pdf",
            pdfParseText: DENSE_TEXT,
        });

        expect(mockedExtractPDF).not.toHaveBeenCalled();
        expect(result.source).toBe("pdf-parse");
        expect(result.visionUsed).toBe(false);
    });

    it("sparse text + LTL carrier in email context triggers vision", async () => {
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4 scanned"),
            filename: "scan.pdf",
            emailContext: "Estes Express Lines — shipment confirmation",
            pdfParseText: SPARSE_TEXT,
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(result.visionUsed).toBe(true);
        expect(result.source).toBe("email_ingest_bol_vision");
    });

    it("sparse text with no BOL signals stays on pdf-parse (no vision cost)", async () => {
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4"),
            filename: "scan.pdf",
            emailContext: "Invoice payment reminder from QuickBooks",
            pdfParseText: SPARSE_TEXT,
        });

        expect(mockedExtractPDF).not.toHaveBeenCalled();
        expect(result.visionUsed).toBe(false);
        expect(result.source).toBe("pdf-parse");
        expect(result.text).toBe(SPARSE_TEXT.trim());
    });

    it("falls back to sparse pdf-parse text when vision throws (never crashes ingest)", async () => {
        mockedExtractPDF.mockRejectedValueOnce(new Error("All OpenRouter strategies failed for PDF OCR"));

        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4 scanned"),
            filename: "BOL.pdf",
            pdfParseText: SPARSE_TEXT,
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(result.visionUsed).toBe(false);
        expect(result.source).toBe("pdf-parse");
        expect(result.text).toBe(SPARSE_TEXT.trim());
    });

    it("does not tag visionUsed when extractPDF itself stayed on pdf-parse", async () => {
        mockedExtractPDF.mockResolvedValueOnce({
            rawText: DENSE_TEXT,
            pages: [],
            tables: [],
            metadata: { pageCount: 1, fileSize: 1024 },
            hasImages: false,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 10,
        } as any);

        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4"),
            filename: "BOL.pdf",
            pdfParseText: SPARSE_TEXT,
        });

        expect(result.visionUsed).toBe(false);
        expect(result.source).toBe("pdf-parse");
        expect(result.text).toBe(DENSE_TEXT);
    });

    it("runs pdf-parse itself when no pre-parsed text is provided", async () => {
        // No pdfParseText arg → module parses the buffer. With a BOL filename and
        // a parse that yields sparse text, vision should still run.
        const result = await extractBolText({
            buffer: Buffer.from("%PDF-1.4 scanned BOL"),
            filename: "BOL.pdf",
        });

        expect(mockedExtractPDF).toHaveBeenCalledTimes(1);
        expect(result.visionUsed).toBe(true);
    });
});
