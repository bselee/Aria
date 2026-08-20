/**
 * @file    invoice-overlay.test.ts
 * @purpose Unit tests for the Bill.com invoice# stamp (invoice-overlay.ts):
 *          vendor gating, filename building, and — critically — that the
 *          stamped number is actually READABLE as text in the output PDF
 *          (that is what Bill.com's OCR will extract).
 * @author  Hermia
 * @created 2026-08-18
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, decodePDFRawStream, PDFRawStream } from "pdf-lib";
import {
    buildStampedFilename,
    shouldStampInvoice,
    stampInvoicePdf,
} from "./invoice-overlay";

/** Minimal one-page PDF with a line of text. */
async function makeSamplePdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText("AAA COOPER TRANSPORTATION", { x: 50, y: 700, size: 12, font });
    return Buffer.from(await pdf.save());
}

/**
 * Extract readable text drawn on page 1 via pdf-lib's own stream decoder.
 * pdf-parse (pdf.js v1.10.100) cannot parse pdf-lib ObjStm/xref streams
 * (InvalidPDFException) — tooling limit, not a stamp bug (2026-08-19).
 * Helvetica draws use hex Tj operands (`<2320…>`), so we decode those too.
 */
async function pageTextLayer(buffer: Buffer): Promise<string> {
    const pdf = await PDFDocument.load(buffer);
    const contents = pdf.getPage(0).node.Contents();
    if (!contents) return "";
    const streams: PDFRawStream[] = [];
    if (typeof (contents as { size?: unknown }).size === "function") {
        const arr = contents as { size: () => number; lookup: (i: number) => unknown };
        for (let i = 0; i < arr.size(); i++) {
            const s = arr.lookup(i);
            if (s instanceof PDFRawStream) streams.push(s);
        }
    } else if (contents instanceof PDFRawStream) {
        streams.push(contents);
    }
    const raw = streams
        .map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()))
        .join("\n");
    const decoded: string[] = [];
    for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const hex = m[1];
        let s = "";
        for (let i = 0; i + 1 < hex.length; i += 2) {
            s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
        decoded.push(s);
    }
    for (const m of raw.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        decoded.push(m[0].slice(1, -1).replace(/\\(.)/g, "$1"));
    }
    return decoded.join("\n");
}

describe("shouldStampInvoice", () => {
    it("stamps AAA Cooper when a clean invoice number is present", () => {
        expect(
            shouldStampInvoice(
                "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>",
                "64058435",
            ),
        ).toBe(true);
    });

    it("does NOT stamp AAA Cooper without an invoice number", () => {
        expect(
            shouldStampInvoice("act.statement@aaacooper.com", ""),
        ).toBe(false);
        expect(
            shouldStampInvoice("act.statement@aaacooper.com", null),
        ).toBe(false);
        expect(
            shouldStampInvoice("act.statement@aaacooper.com", "UNKNOWN"),
        ).toBe(false);
    });

    it("does NOT stamp other vendors", () => {
        expect(
            shouldStampInvoice("Uline <orders@uline.com>", "211897049"),
        ).toBe(false);
        expect(shouldStampInvoice("noreply@fedex.com", "9-416-41699")).toBe(false);
    });
});

describe("buildStampedFilename", () => {
    it("builds <inv#>_<vendor>.pdf", () => {
        expect(
            buildStampedFilename("64058435", "AAA Cooper Transportation"),
        ).toBe("64058435_AAA_Cooper_Transportation.pdf");
    });

    it("sanitizes weird characters", () => {
        const name = buildStampedFilename("9-416/41699", "FedEx, Inc.");
        expect(name).toBe("9-416_41699_FedEx_Inc..pdf");
        expect(name.endsWith(".pdf")).toBe(true);
    });
});

describe("stampInvoicePdf", () => {
    it("produces a PDF whose text layer contains the invoice number", async () => {
        const original = await makeSamplePdf();
        const stamped = await stampInvoicePdf(
            original,
            {
                invoiceNumber: "64058435",
                vendorName: "AAA Cooper Transportation",
            },
            "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>",
        );

        expect(stamped.length).toBeGreaterThan(original.length);

        const text = await pageTextLayer(stamped);
        // The stamp line must be extractable as REAL text — this is exactly
        // what Bill.com's OCR/extractor reads. The template prefix is just
        // "# " because the page's own "INVOICE" title carries the label.
        expect(text).toContain("# 64058435");
        expect(text).not.toContain("INVOICE #");
    });

    it("keeps the original pages intact", async () => {
        const original = await makeSamplePdf();
        const stamped = await stampInvoicePdf(
            original,
            { invoiceNumber: "64058435" },
            "act.statement@aaacooper.com",
        );
        const out = await PDFDocument.load(stamped);
        expect(out.getPageCount()).toBe(1);
    });
});
