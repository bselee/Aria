/**
 * @file    ap-single-forward.fedex-dedup.test.ts
 * @purpose Lock in the FedEx dedup fix: once the filename-derived packet number
 *          is passed into forwardInvoiceOnce, the claim gate's invoice# layers
 *          must catch FedEx re-sends that hash/message dedup can't see
 *          (re-rendered PDF, new Gmail thread). Proves BOTH the armed layers
 *          and the pre-fix blind spot (no invoiceNumber → no hit).
 * @author  Hermia
 * @created 2026-08-18
 * @deps    better-sqlite3 (in-memory)
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

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

vi.mock("@googleapis/gmail", () => ({
    gmail: () => ({
        users: {
            messages: {
                send: async () => ({ data: { id: "sent-total-test" } }),
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

import { isAlreadyClaimedOrForwarded, forwardInvoiceOnce } from "./ap-single-forward";

const FEDEX_FROM = "FedEx Billing Online <noreply@fedex.com>";
const FEDEX_SUBJECT = "Your New FedEx Billing Online invoice is attached";

describe("FedEx re-send protection via invoice# layers", () => {
    it("Layer 4: prior FORWARDED row with the same dashed packet# blocks a re-send", () => {
        mem.prepare(
            `INSERT INTO ap_local_forwards
             (gmail_message_id, email_from, email_subject, pdf_filename,
              pdf_content_hash, status, ocr_invoice_number)
             VALUES (?, ?, ?, ?, ?, 'FORWARDED', ?)`,
        ).run(
            "old-msg",
            FEDEX_FROM,
            FEDEX_SUBJECT,
            "FedEx_Express_9-426-52443.pdf",
            "hash-aaa",
            "9-426-52443",
        );

        // Same invoice re-emailed as a NEW message with DIFFERENT bytes —
        // hash + message+filename layers miss; the dashed invoice# must catch.
        const hit = isAlreadyClaimedOrForwarded(
            "new-msg",
            "FedEx_Express_9-426-52443.pdf",
            "hash-bbb-different-bytes",
            "FedEx",
            "9-426-52443",
        );
        expect(hit.hit).toBe(true);
        expect(hit.reason).toContain("ocr invoice#");
    });

    it("Layer 6: invoice already in billcom_bills_ref blocks the forward", () => {
        mem.prepare(
            "INSERT INTO billcom_bills_ref (invoice_number, vendor_name) VALUES (?, ?)",
        ).run("9-408-25620", "FedEx");

        const hit = isAlreadyClaimedOrForwarded(
            "msg-408-25620",
            "FedEx_Ground_9-408-25620.pdf",
            "hash-ccc",
            "FedEx",
            "9-408-25620",
        );
        expect(hit.hit).toBe(true);
        expect(hit.reason).toContain("billcom_bills_ref");
    });

    it("PRE-FIX regression lock: without an invoiceNumber the same ref row is invisible", () => {
        // Exactly what the local forwarder did before this fix — null subject
        // number for FedEx → the ref-layer dedup could never fire.
        const miss = isAlreadyClaimedOrForwarded(
            "msg-408-25620-bis",
            "FedEx_Ground_9-408-25620.pdf",
            "hash-ddd",
            "FedEx",
            undefined,
        );
        expect(miss.hit).toBe(false);
    });

    it("no false positive: an unseen FedEx invoice# still forwards", () => {
        const miss = isAlreadyClaimedOrForwarded(
            "msg-fresh",
            "FedEx_Express_9-426-52444.pdf",
            "hash-eee",
            "FedEx",
            "9-426-52444",
        );
        expect(miss.hit).toBe(false);
    });

    it("claim persists ocr_total from invoiceTotal (FedEx amount capture)", async () => {
        const result = await forwardInvoiceOnce({
            gmailMessageId: "msg-fedex-total",
            emailFrom: "FedEx Billing Online <noreply@fedex.com>",
            emailSubject: "Your New FedEx Billing Online invoice is attached",
            pdfFilename: "FedEx_Ground_9-426-52442.pdf",
            pdfBuffer: Buffer.from("fake-fedex-packet-bytes"),
            vendorName: "FedEx",
            invoiceNumber: "9-426-52442",
            invoiceTotal: 15287.1,
            source: "local-forwarder",
        });
        expect(result.status).toBe("forwarded");
        const row = mem
            .prepare("SELECT ocr_total FROM ap_local_forwards WHERE gmail_message_id = ?")
            .get("msg-fedex-total") as any;
        expect(row.ocr_total).toBe("15287.1");
    });
});
