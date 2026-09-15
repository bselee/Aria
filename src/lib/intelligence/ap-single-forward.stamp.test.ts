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
        send: async () => ({ data: { id: "sent-msg-1" } }),
      },
    },
  }),
}));

import { forwardInvoiceOnce } from "./ap-single-forward";

// Capture the raw the mocked send received so we can assert the stamped PDF.
let lastRaw: string | null = null;
vi.mock("@googleapis/gmail", () => {
  return {
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
  };
});

describe("forwardInvoiceOnce invoice# stamp", () => {
  beforeEach(() => {
    lastRaw = null;
    mem.prepare("DELETE FROM ap_local_forwards").run();
    mem.prepare("DELETE FROM billcom_bills_ref").run();
  });

  it("stamps the Pro# into the sent PDF for AAA Cooper", async () => {
    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-stamp",
      emailFrom: "ACT.statement@aaacooper.com",
      emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 64058449",
      pdfFilename: "ACT_STMD_ID_3125.PDF",
      pdfBuffer: Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
      ),
      invoiceNumber: "64058449",
      vendorName: "AAA Cooper Transportation",
      source: "local-forwarder",
    });

    expect(r.status).toBe("forwarded");
    const raw = Buffer.from(lastRaw!, "base64url").toString("latin1");
    expect(raw).toContain("64058449");
  });

  it("renames the attachment to <Pro#>_AAA_Cooper_Transportation.pdf", async () => {
    await forwardInvoiceOnce({
      gmailMessageId: "m-stamp-name",
      emailFrom: "ACT.statement@aaacooper.com",
      emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 64058449",
      pdfFilename: "ACT_STMD_ID_3125.PDF",
      pdfBuffer: Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
      ),
      invoiceNumber: "64058449",
      vendorName: "AAA Cooper Transportation",
      source: "local-forwarder",
    });

    const row = mem.prepare("SELECT pdf_filename FROM ap_local_forwards WHERE gmail_message_id = 'm-stamp-name'").get() as { pdf_filename: string };
    expect(row.pdf_filename).toContain("64058449_AAA_Cooper_Transportation");
  });

  it("does NOT stamp a non-AAA sender (keeps original filename)", async () => {
    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-nostamp",
      emailFrom: "billing@somevendor.com",
      emailSubject: "Invoice 12345",
      pdfFilename: "inv12345.pdf",
      pdfBuffer: Buffer.from("%PDF-1.4 minimal"),
      invoiceNumber: "12345",
      vendorName: "Some Vendor",
      source: "local-forwarder",
    });
    expect(r.status).toBe("forwarded");
    const raw = Buffer.from(lastRaw!, "base64url").toString("latin1");
    expect(raw).not.toContain("AAA_Cooper");
  });
});
