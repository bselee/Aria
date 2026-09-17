/**
 * @file    ap-single-forward.weight-ticket.test.ts
 * @purpose Prove the pre-send OCR gate BLOCKS a weight ticket / BOL (a
 *          non-invoice document) instead of forwarding it, while a pass and a
 *          customer-number flag still forward. Mirrors the statement gate's
 *          block semantics so Bill.com never mints a phantom bill off a
 *          ticket# (the CR Minerals $23.56 class).
 * @author  Hermia
 * @created 2026-09-15
 * @deps    vitest, better-sqlite3, ./ap-single-forward, ./ap/invoice-ocr-gate
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
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
    UNIQUE(gmail_message_id, pdf_filename)
  );
  CREATE TABLE billcom_bills_ref (
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    UNIQUE(invoice_number, vendor_name)
  );
`);

vi.mock("@/lib/storage/local-db", () => ({ getLocalDb: () => mem }));
vi.mock("@/lib/gmail/auth", () => ({ getAuthenticatedClient: async () => ({}) }));

let lastRaw: string | null = null;
vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({
    users: {
      messages: {
        send: async (req: any) => {
          lastRaw = req.requestBody.raw;
          return { data: { id: "sent-msg-1" } };
        },
      },
    },
  }),
}));

// Mock the OCR gate's dynamic import. Each test sets `gateResult` first.
let gateResult: any = {
  verdict: "pass",
  reason: "invoice# 123",
  invoiceNumbers: ["123"],
  ticketDetected: false,
  customerNumbers: [],
  rawText: "",
  ocrRan: true,
};
vi.mock("./ap/invoice-ocr-gate", () => ({
  verifyInvoiceForBillCom: async () => gateResult,
}));

import { forwardInvoiceOnce } from "./ap-single-forward";

const TICKET_PDF = Buffer.from("%PDF-1.4 minimal ticket pdf");

describe("forwardInvoiceOnce OCR-gate weight-ticket block", () => {
  beforeEach(() => {
    lastRaw = null;
    mem.prepare("DELETE FROM ap_local_forwards").run();
    mem.prepare("DELETE FROM billcom_bills_ref").run();
    gateResult = {
      verdict: "pass",
      reason: "invoice# 123",
      invoiceNumbers: ["123"],
      ticketDetected: false,
      customerNumbers: [],
      rawText: "",
      ocrRan: true,
    };
  });

  it("BLOCKS a weight ticket / BOL (ticket label, no invoice number)", async () => {
    gateResult = {
      verdict: "no_invoice_number",
      reason: "weight ticket / BOL / non-invoice (no invoice#, ticket label present)",
      invoiceNumbers: [],
      ticketDetected: true,
      customerNumbers: [],
      rawText: "Ticket #: NMM000003464 ...",
      ocrRan: true,
    };

    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-ticket",
      emailFrom: "accounting@crminerals.com",
      emailSubject: "RE: Payment Application",
      pdfFilename: "image002.pdf",
      pdfBuffer: TICKET_PDF,
      source: "local-forwarder",
    });

    expect(r.status).toBe("blocked");
    // No send happened.
    expect(lastRaw).toBeNull();
    // Row flipped to BLOCKED with a reason.
    const row = mem.prepare("SELECT status, error_message FROM ap_local_forwards WHERE gmail_message_id = 'm-ticket'").get() as { status: string; error_message: string };
    expect(row.status).toBe("BLOCKED");
    expect(row.error_message).toContain("weight ticket");
  });

  it("still forwards on a pass verdict", async () => {
    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-pass",
      emailFrom: "billing@somevendor.com",
      emailSubject: "Invoice 12345",
      pdfFilename: "inv12345.pdf",
      pdfBuffer: Buffer.from("%PDF-1.4 minimal"),
      invoiceNumber: "12345",
      source: "local-forwarder",
    });
    expect(r.status).toBe("forwarded");
    expect(lastRaw).not.toBeNull();
  });

  it("still forwards (does not block) a customer_number flag", async () => {
    gateResult = {
      verdict: "customer_number",
      reason: "customer number still present after redaction: 1159492",
      invoiceNumbers: ["64058402"],
      ticketDetected: false,
      customerNumbers: ["1159492"],
      rawText: "CUSTOMER NUMBER 1159492",
      ocrRan: true,
    };

    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-cust",
      emailFrom: "ACT.statement@aaacooper.com",
      emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 64058402",
      pdfFilename: "ACT_STMD_ID_3125.PDF",
      pdfBuffer: Buffer.from("%PDF-1.4 minimal"),
      invoiceNumber: "64058402",
      source: "local-forwarder",
    });
    expect(r.status).toBe("forwarded");
    expect(lastRaw).not.toBeNull();
  });
});
