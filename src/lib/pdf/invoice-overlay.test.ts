/**
 * @file    invoice-overlay.test.ts
 * @purpose Unit tests for stampInvoicePdf — invoice# stamp + customer-number
 *          redaction on page 1.
 * @author  Hermia
 * @created 2026-09-15
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inflateSync } from "zlib";
import { stampInvoicePdf } from "./invoice-overlay";

/** Build a valid single-page PDF at the AAA Cooper page size (614.39 x 781.2 pt). */
async function makePdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([614.39, 781.2]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Fake "CUSTOMER NUMBER 1159492" at the measured header position.
    page.drawText("CUSTOMER NUMBER", { x: 354, y: 781.2 - 31, size: 12, font });
    page.drawText("1159492", { x: 361, y: 781.2 - 42, size: 12, font });
    // A Pro# in the PRO NUMBER cell (right of the redaction box).
    page.drawText("64058449", { x: 490, y: 781.2 - 42, size: 12, font });
    return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * Decompress page 1's content stream and return it as text. pdf-lib writes
 * rectangles as `m … l … l … l h f` (moveto/lineto/close/fill), so the fill
 * count is how many solid shapes (redaction boxes) were drawn.
 */
async function pageContent(buf: Buffer): Promise<{ text: string; fillCount: number }> {
    const raw = buf.toString("latin1");
    // Find the (single) content stream and inflate it. pdf-lib Flate-compresses
    // content streams; the stamp/redaction output is small enough to scan.
    let text = "";
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(raw)) !== null) {
        let s = m[1];
        if (s.endsWith("\n")) s = s.slice(0, -1);
        if (s.endsWith("\r")) s = s.slice(0, -1);
        const chunk = Buffer.from(s, "latin1");
        try {
            const inflated = inflateSync(chunk).toString("latin1");
            // Content streams contain text operators (Tj) — pick that one.
            if (inflated.includes("Tj")) text = inflated;
        } catch {
            /* not a flate stream — ignore */
        }
    }
    // A rectangle is drawn as moveto + 3 lineto + close + fill. Count fills.
    const fillCount = (text.match(/\nf\n/g) || []).length;
    return { text, fillCount };
}

describe("stampInvoicePdf redaction", () => {
    it("stamps the invoice# AND draws white redaction boxes for AAA Cooper", async () => {
        const src = await makePdf();
        const out = await stampInvoicePdf(
            src,
            { invoiceNumber: "64058449", vendorName: "AAA Cooper Transportation" },
            "ACT.statement@aaacooper.com",
        );

        expect(out).not.toBe(src);
        const { text, fillCount } = await pageContent(out);
        // Stamp text embedded as a drawText call (Tj operator present).
        expect(text).toContain("Tj");
        // Exactly 4 redaction rectangles drawn (one per customer# occurrence).
        expect(fillCount).toBe(4);
    });

    it("does NOT redact non-AAA senders (no white boxes)", async () => {
        const src = await makePdf();
        const out = await stampInvoicePdf(
            src,
            { invoiceNumber: "12345", vendorName: "Some Vendor" },
            "billing@somevendor.com",
        );
        const { fillCount } = await pageContent(out);
        expect(fillCount).toBe(0);
    });

    it("throws on a corrupt buffer (caller falls back to original)", async () => {
        const garbage = Buffer.from("not a pdf");
        // stampInvoicePdf throws on a bad buffer; the caller (forwardInvoiceOnce)
        // catches this and forwards the original — a stamp must never block a
        // bill from reaching Bill.com.
        await expect(
            stampInvoicePdf(garbage, { invoiceNumber: "64058449" }, "ACT.statement@aaacooper.com"),
        ).rejects.toThrow();
    });
});
