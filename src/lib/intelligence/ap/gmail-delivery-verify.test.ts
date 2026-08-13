/**
 * @file    src/lib/intelligence/ap/gmail-delivery-verify.test.ts
 * @purpose Unit tests for Gmail-as-source-of-truth AP delivery verification —
 *          the replacement for CSV/scrape-dependent verification.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    vitest, better-sqlite3 (in-memory), vi.mock("@/lib/storage/local-db")
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
    verified INTEGER DEFAULT 0,
    ocr_vendor_name TEXT,
    ocr_invoice_number TEXT,
    UNIQUE(gmail_message_id, pdf_filename)
  );
`);

vi.mock("@/lib/storage/local-db", () => ({ getLocalDb: () => mem }));

import {
  runGmailDeliverySweep,
  classifyForward,
  hasPdfAttachment,
  BILLCOM_INTAKE_ADDRESS,
} from "./gmail-delivery-verify";

let counter = 0;

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

function insertForward(row: {
  sentId?: string | null;
  subject?: string;
  forwardedAt?: string;
  verified?: number;
  vendorName?: string | null;
  invoiceNumber?: string | null;
  status?: string;
}): number {
  counter += 1;
  const info = mem
    .prepare(
      `INSERT INTO ap_local_forwards
        (gmail_message_id, email_subject, pdf_filename, pdf_content_hash,
         billcom_sent_message_id, status, forwarded_at, verified,
         ocr_vendor_name, ocr_invoice_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `src-${counter}`,
      row.subject ?? "Invoice 12345",
      `file-${counter}.pdf`,
      `hash-${counter}`,
      row.sentId === undefined ? `sent-${counter}` : row.sentId,
      row.status ?? "FORWARDED",
      row.forwardedAt ?? hoursAgo(24),
      row.verified ?? 0,
      row.vendorName ?? null,
      row.invoiceNumber ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** Build a Gmail double whose messages.get is driven by a lookup table. */
function makeGmail(messages: Record<string, any>, listResult: any[] = []) {
  return {
    users: {
      messages: {
        get: async ({ id }: any) => {
          if (!(id in messages)) {
            const err: any = new Error("Not Found");
            err.code = 404;
            throw err;
          }
          const m = messages[id];
          if (m instanceof Error) throw m;
          return { data: m };
        },
        list: async () => ({ data: { messages: listResult } }),
      },
    },
  };
}

/** A well-formed sent forward: addressed to Bill.com with a PDF attached. */
function goodMessage(subject = "Fwd: Invoice 12345") {
  return {
    id: "x",
    labelIds: ["SENT"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "To", value: BILLCOM_INTAKE_ADDRESS },
        { name: "Subject", value: subject },
      ],
      parts: [
        { mimeType: "text/plain", filename: "" },
        { mimeType: "application/pdf", filename: "invoice.pdf" },
      ],
    },
  };
}

beforeEach(() => {
  mem.prepare("DELETE FROM ap_local_forwards").run();
  counter = 0;
});

describe("hasPdfAttachment", () => {
  it("finds a PDF by mimeType", () => {
    expect(hasPdfAttachment({ mimeType: "application/pdf", filename: "a.pdf" })).toBe(true);
  });

  it("finds a PDF by .pdf filename even when mimeType is octet-stream", () => {
    // Vendor mailers sometimes mislabel PDFs; a missed attachment would be
    // reported as a delivery problem, so the filename is a valid fallback.
    expect(hasPdfAttachment({ mimeType: "application/octet-stream", filename: "INV.PDF" })).toBe(true);
  });

  it("recurses into nested multipart trees", () => {
    const tree = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", filename: "" }] },
        { mimeType: "multipart/related", parts: [{ mimeType: "application/pdf", filename: "deep.pdf" }] },
      ],
    };
    expect(hasPdfAttachment(tree)).toBe(true);
  });

  it("returns false when there is no PDF anywhere", () => {
    expect(hasPdfAttachment({ mimeType: "text/plain", filename: "" })).toBe(false);
    expect(hasPdfAttachment(null)).toBe(false);
  });
});

describe("classifyForward", () => {
  const row = {
    id: 1,
    billcom_sent_message_id: "abc",
    email_subject: "Invoice 1",
    ocr_vendor_name: "Uline",
    ocr_invoice_number: "211660327",
    verified: 0,
  };

  it("returns delivered for a Bill.com-addressed message with a PDF", async () => {
    const gmail = makeGmail({ abc: goodMessage() });
    const r = await classifyForward(gmail, row);
    expect(r.verdict).toBe("delivered");
    expect(r.recipient).toBe(BILLCOM_INTAKE_ADDRESS);
  });

  it("returns not_in_gmail on a hard 404 (the send never happened)", async () => {
    const gmail = makeGmail({});
    const r = await classifyForward(gmail, row);
    expect(r.verdict).toBe("not_in_gmail");
  });

  it("returns lookup_error (NOT a problem) on a transient failure", async () => {
    const boom: any = new Error("backendError");
    boom.code = 503;
    const gmail = makeGmail({ abc: boom });
    const r = await classifyForward(gmail, row);
    expect(r.verdict).toBe("lookup_error");
  });

  it("returns wrong_recipient when not addressed to the intake address", async () => {
    const msg = goodMessage();
    msg.payload.headers[0].value = "someone.else@example.com";
    const gmail = makeGmail({ abc: msg });
    const r = await classifyForward(gmail, row);
    expect(r.verdict).toBe("wrong_recipient");
  });

  it("returns sent_without_pdf when the attachment is missing", async () => {
    const msg = goodMessage();
    msg.payload.parts = [{ mimeType: "text/plain", filename: "" }];
    const gmail = makeGmail({ abc: msg });
    const r = await classifyForward(gmail, row);
    expect(r.verdict).toBe("sent_without_pdf");
  });

  it("returns no_send_id when the row was never given a Gmail id", async () => {
    const gmail = makeGmail({});
    const r = await classifyForward(gmail, { ...row, billcom_sent_message_id: null });
    expect(r.verdict).toBe("no_send_id");
  });
});

describe("runGmailDeliverySweep", () => {
  it("verifies a good forward and sets verified = 1", async () => {
    const id = insertForward({ sentId: "m1" });
    const gmail = makeGmail({ m1: goodMessage() });

    const r = await runGmailDeliverySweep(gmail, { checkBounces: false });

    expect(r.checked).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.problems).toHaveLength(0);
    const row = mem.prepare("SELECT verified FROM ap_local_forwards WHERE id=?").get(id) as any;
    expect(row.verified).toBe(1);
  });

  it("reports a forward Gmail has no record of", async () => {
    insertForward({ sentId: "ghost" });
    const gmail = makeGmail({});

    const r = await runGmailDeliverySweep(gmail, { checkBounces: false });

    expect(r.delivered).toBe(0);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].verdict).toBe("not_in_gmail");
  });

  it("skips already-verified rows and counts them separately", async () => {
    insertForward({ sentId: "m1", verified: 1 });
    insertForward({ sentId: "m2" });
    const gmail = makeGmail({ m2: goodMessage() });

    const r = await runGmailDeliverySweep(gmail, { checkBounces: false });

    expect(r.alreadyVerified).toBe(1);
    expect(r.checked).toBe(1);
    expect(r.delivered).toBe(1);
  });

  it("respects the grace period for very recent sends", async () => {
    insertForward({ sentId: "m1", forwardedAt: hoursAgo(0) });
    const gmail = makeGmail({ m1: goodMessage() });

    const r = await runGmailDeliverySweep(gmail, { graceHours: 2, checkBounces: false });

    expect(r.checked).toBe(0);
  });

  it("does NOT surface transient lookup errors as problems", async () => {
    insertForward({ sentId: "m1" });
    const boom: any = new Error("rate limit");
    boom.code = 429;
    const gmail = makeGmail({ m1: boom });

    const r = await runGmailDeliverySweep(gmail, { checkBounces: false });

    expect(r.problems).toHaveLength(0);
    expect(r.byVerdict["lookup_error"]).toBe(1);
  });

  it("verifies many forwards without any third-party dependency", async () => {
    // The whole point: no CSV, no scrape, no vendor portal — just Gmail.
    const msgs: Record<string, any> = {};
    for (let i = 1; i <= 12; i++) {
      insertForward({ sentId: "bulk" + i });
      msgs["bulk" + i] = goodMessage();
    }
    const gmail = makeGmail(msgs);

    const r = await runGmailDeliverySweep(gmail, { checkBounces: false });

    expect(r.checked).toBe(12);
    expect(r.delivered).toBe(12);
    expect(r.problems).toHaveLength(0);
  });
});
