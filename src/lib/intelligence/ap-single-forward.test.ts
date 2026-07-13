/**
 * @file    ap-single-forward.test.ts
 * @purpose Unit tests for single-forward gate claim/dedup/reclaim behavior.
 * @author  Hermia
 * @created 2026-07-10
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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

function mockGmail(id = "sent-1") {
  return {
    users: {
      messages: {
        send: async () => ({ data: { id } }),
      },
    },
  };
}

describe("forwardInvoiceOnce single-send invariant", () => {
  beforeEach(() => {
    mem.prepare("DELETE FROM ap_local_forwards").run();
    mem.prepare("DELETE FROM billcom_bills_ref").run();
  });

  it("forwards once then suppresses second call with same content", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake invoice content for test");
    const req = {
      gmailMessageId: "msg-abc",
      emailFrom: "vendor@example.com",
      emailSubject: "Invoice 123 PO 125000",
      pdfFilename: "inv123.pdf",
      pdfBuffer: pdf,
      source: "local-forwarder" as const,
      gmail: mockGmail("sent-1"),
    };

    const first = await forwardInvoiceOnce(req);
    expect(first.status).toBe("forwarded");

    const second = await forwardInvoiceOnce({
      ...req,
      gmailMessageId: "msg-different-email",
      emailSubject: "Fwd: same pdf different subject",
      gmail: mockGmail("sent-2"),
    });
    expect(second.status).toBe("already_forwarded");
  });

  it("suppresses same message+filename even if hash differs", async () => {
    const gmail = mockGmail("sent-a");
    const r1 = await forwardInvoiceOnce({
      gmailMessageId: "m1",
      emailFrom: "a@b.com",
      emailSubject: "Inv",
      pdfFilename: "a.pdf",
      pdfBuffer: Buffer.from("%PDF one"),
      source: "ap-agent",
      gmail,
    });
    expect(r1.status).toBe("forwarded");

    const r2 = await forwardInvoiceOnce({
      gmailMessageId: "m1",
      emailFrom: "a@b.com",
      emailSubject: "Inv",
      pdfFilename: "a.pdf",
      pdfBuffer: Buffer.from("%PDF two different"),
      source: "supabase-forwarder",
      gmail: mockGmail("sent-b"),
    });
    expect(r2.status).toBe("already_forwarded");
  });

  it("reclaims ERROR rows so failed sends can retry", async () => {
    const pdf = Buffer.from("%PDF retryable");
    let calls = 0;
    const flaky = {
      users: {
        messages: {
          send: async () => {
            calls++;
            if (calls === 1) throw new Error("network blip");
            return { data: { id: "sent-retry" } };
          },
        },
      },
    };

    const req = {
      gmailMessageId: "m-retry",
      emailFrom: "v@x.com",
      emailSubject: "Invoice",
      pdfFilename: "retry.pdf",
      pdfBuffer: pdf,
      source: "local-forwarder" as const,
      gmail: flaky,
    };

    const fail = await forwardInvoiceOnce(req);
    expect(fail.status).toBe("error");

    const ok = await forwardInvoiceOnce(req);
    expect(ok.status).toBe("forwarded");
    if (ok.status === "forwarded") {
      expect(ok.billcomSentMessageId).toBe("sent-retry");
    }
  });

  it("blocks empty buffer", async () => {
    const r = await forwardInvoiceOnce({
      gmailMessageId: "m",
      emailFrom: "x",
      emailSubject: "y",
      pdfFilename: "z.pdf",
      pdfBuffer: Buffer.alloc(0),
      source: "manual",
    });
    expect(r.status).toBe("blocked");
  });

  it("blocks via billcom_bills_ref vendor+invoice", async () => {
    mem.prepare(
      `INSERT INTO billcom_bills_ref (invoice_number, vendor_name) VALUES (?, ?)`,
    ).run("999", "Belt Power LLC");

    const r = await forwardInvoiceOnce({
      gmailMessageId: "m-ref",
      emailFrom: "remitto@beltpower.com",
      emailSubject: "Invoice 999",
      pdfFilename: "Inv999.pdf",
      pdfBuffer: Buffer.from("%PDF belt"),
      vendorName: "Belt Power LLC",
      invoiceNumber: "999",
      source: "local-forwarder",
      gmail: mockGmail(),
    });
    expect(r.status).toBe("already_forwarded");
    if (r.status === "already_forwarded") {
      expect(r.reason).toContain("billcom_bills_ref");
    }
  });
});
