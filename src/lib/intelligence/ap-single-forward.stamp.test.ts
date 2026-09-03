/**
 * @file    ap-single-forward.stamp.test.ts
 * @purpose Prove the invoice# stamp actually rides the AP forward path:
 *          forwardInvoiceOnce, when given a stamp-listed sender (AAA Cooper)
 *          and a subject-derived invoice number, must send the STAMPED PDF
 *          under the <Pro#>_<Vendor>.pdf name, mark the row FORWARDED with
 *          the stamped filename, and set verified=1 via verify-in-Sent.
 * @author  Hermia
 * @created 2026-08-18
 * @deps    better-sqlite3 (in-memory), pdf-lib, pdf-parse
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";

const mem = new Database(":memory:");
mem.exec(`
  CREATE TABLE ap_local_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT NOT NULL,
    email_from TEXT,
    email_subject TEXT,
    pdf_filename TEXT NOT NULL,
    pdf_content_hash TEXT NOT NULL,
    billcom_sent_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'FORWARDED',
    error_message TEXT,
    forwarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reconciliation_status TEXT,
    matched_po_number TEXT,
    reconciliation_notes TEXT,
    vendor_routing_action TEXT,
    ocr_raw_text TEXT,
    ocr_vendor_name TEXT,
    ocr_invoice_number TEXT,
    ocr_total TEXT,
    verified INTEGER DEFAULT 0,
    UNIQUE(gmail_message_id, pdf_filename)
  );
  CREATE TABLE billcom_bills_ref (
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    UNIQUE(invoice_number, vendor_name)
  );
`);

vi.mock("@/lib/storage/local-db", () => ({
    getLocalDb: () => mem,
}));

vi.mock("@/lib/gmail/auth", () => ({
    getAuthenticatedClient: async () => ({}),
}));

import { forwardInvoiceOnce } from "./ap-single-forward";
import { stampInvoicePdf } from "@/lib/pdf/invoice-overlay";

/** Minimal one-page PDF; label makes bytes unique (content-hash dedup). */
async function makePdf(label: string): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText(`AAA COOPER TEST ${label}`, { x: 50, y: 700, size: 12, font });
    return Buffer.from(await pdf.save());
}

/** Capture the raw MIME a mocked send receives. */
let capturedSend: any = null;
vi.mock("@googleapis/gmail", () => ({
    gmail: () => ({
        users: {
            messages: {
                send: async (params: any) => {
                    capturedSend = params;
                    return { data: { id: "sent-stamp-test" } };
                },
                get: async () => ({
                    data: {
                        payload: {
                            mimeType: "multipart/mixed",
                            parts: [{ mimeType: "application/pdf", filename: "irrelevant.pdf" }],
                        },
                    },
                }),
            },
        },
    }),
}));

/** Decode the raw MIME captured by the send mock. */
function decodeMime(): { filename: string; pdfBuffer: Buffer } {
    const raw = Buffer.from(capturedSend.requestBody.raw, "base64url").toString("utf8");
    const filename = (raw.match(/filename="([^"]+)"/) || [])[1] || "";
    // Content-Disposition sits between the encoding header and the body.
    const b64 = (raw.match(/Content-Disposition: attachment; filename="[^"]+"\r?\n\r?\n([\s\S]+?)\r?\n--/) || [])[1] || "";
    const pdfBuffer = Buffer.from(b64.replace(/\r?\n/g, ""), "base64");
    return { filename, pdfBuffer };
}

describe("forwardInvoiceOnce stamp wiring", () => {
    it("sends the STAMPED PDF under <Pro#>_<Vendor>.pdf for AAA Cooper", async () => {
        const original = await makePdf("aaa");
        const result = await forwardInvoiceOnce({
            gmailMessageId: "msg-aaa-1",
            emailFrom: "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>",
            emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 64058435",
            pdfFilename: "ACT_STMD_ID_1.PDF",
            pdfBuffer: original,
            vendorName: "AAA Cooper Transportation",
            invoiceNumber: "64058435",
            source: "local-forwarder",
        });

        expect(result.status).toBe("forwarded");

        const { filename, pdfBuffer } = decodeMime();
        expect(filename).toBe("64058435_AAA_Cooper_Transportation.pdf");

        // The bytes actually sent must be EXACTLY the stamped output — nothing
        // less (unstamped original) or different. (Byte-for-byte equality; the
        // OCR-readability of the stamp itself is proven in invoice-overlay.test.)
        const expected = await stampInvoicePdf(
            original,
            { invoiceNumber: "64058435", vendorName: "AAA Cooper Transportation" },
            "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>",
        );
        expect(pdfBuffer.equals(expected)).toBe(true);

        // Row: FORWARDED, stamped filename, sent id, verified=1.
        const row = mem
            .prepare(
                `SELECT pdf_filename, status, billcom_sent_message_id, verified,
                        ocr_invoice_number
                 FROM ap_local_forwards WHERE gmail_message_id = ?`,
            )
            .get("msg-aaa-1") as any;
        expect(row.pdf_filename).toBe("64058435_AAA_Cooper_Transportation.pdf");
        expect(row.status).toBe("FORWARDED");
        expect(row.billcom_sent_message_id).toBe("sent-stamp-test");
        expect(row.verified).toBe(1);
        // Claim stored the subject-derived Pro# (not OCR junk).
        expect(row.ocr_invoice_number).toBe("64058435");
    });

    it("forwards non-stamped invoices byte-identical (no tampering outside the stamp list)", async () => {
        const original = await makePdf("uline");
        const result = await forwardInvoiceOnce({
            gmailMessageId: "msg-uline-1",
            emailFrom: "Uline <orders@uline.com>",
            emailSubject: "Uline Invoice 211897049 ID# 16",
            pdfFilename: "Uline_Invoice.pdf",
            pdfBuffer: original,
            vendorName: "Uline",
            invoiceNumber: "211897049",
            source: "local-forwarder",
        });

        expect(result.status).toBe("forwarded");
        const { filename, pdfBuffer } = decodeMime();
        expect(filename).toBe("Uline_Invoice.pdf");
        // THE invariant Bill cares about: outside the stamp list the bytes sent
        // are EXACTLY the original attachment — no re-encode, no OCR rewrite,
        // no pdf-lib resave. Only the explicitly-listed stamp vendors (AAA
        // Cooper) may alter the PDF. Filename sanitize is metadata, not content.
        expect(pdfBuffer.equals(original)).toBe(true);
    });
});
