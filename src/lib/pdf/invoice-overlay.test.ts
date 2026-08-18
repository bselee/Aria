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
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
    buildStampedFilename,
    shouldStampInvoice,
    stampInvoicePdf,
} from "./invoice-overlay";
// @ts-expect-error - No types available for pdf-parse
import pdfParse from "pdf-parse";

/** Minimal one-page PDF with a line of text, so pdf-parse has content. */
async function makeSamplePdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText("AAA COOPER TRANSPORTATION", { x: 50, y: 700, size: 12, font });
    return Buffer.from(await pdf.save());
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

        const parsed = await pdfParse(stamped, { max: 0 });
        const text = parsed.text || "";
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
