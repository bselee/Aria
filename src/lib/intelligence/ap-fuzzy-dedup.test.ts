/**
 * @file    ap-fuzzy-dedup.test.ts
 * @purpose Unit tests for the LAST-RESORT fuzzy duplicate layer
 *          (vendor + amount + date-window) in the AP forward gate.
 *          Guardrailed: never guesses, never suppresses on ERROR rows,
 *          absolute-dollar tolerance, reason prefixed "fuzzy:".
 * @author  Hermia
 * @created 2026-08-13
 * @deps    better-sqlite3 (in-memory), @/lib/storage/local-db (mocked)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
        send: async () => ({ data: { id: "sent-fuzzy" } }),
      },
    },
  }),
}));

import { findFuzzyDuplicate } from "./ap-dedup";
import { forwardInvoiceOnce } from "./ap-single-forward";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Seed a taken-status row with OCR vendor/total/date. Returns its id. */
function seedRow(overrides: {
  status?: string;
  ocrVendorName?: string | null;
  ocrTotal?: string | null;
  forwardedDaysAgo?: number;
  pdfHash?: string;
  messageId?: string;
  filename?: string;
  ocrInvoiceNumber?: string | null;
} = {}): number {
  const info = mem
    .prepare(
      `INSERT INTO ap_local_forwards
         (gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
          status, ocr_vendor_name, ocr_invoice_number, ocr_total, forwarded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.messageId ?? `seed-msg-${Math.random()}`,
      "act.statement@aaacooper.com",
      "Invoice Stmt",
      overrides.filename ?? `seed-${Math.random()}.pdf`,
      overrides.pdfHash ?? `seed-hash-${Math.random()}`,
      overrides.status ?? "FORWARDED",
      overrides.ocrVendorName ?? "AAA Cooper Transportation",
      overrides.ocrInvoiceNumber ?? null,
      overrides.ocrTotal ?? "534.85",
      daysAgoIso(overrides.forwardedDaysAgo ?? 0),
    );
  return Number(info.lastInsertRowid);
}

describe("findFuzzyDuplicate — last-resort vendor+amount+date dedup", () => {
  beforeEach(() => {
    mem.prepare("DELETE FROM ap_local_forwards").run();
    mem.prepare("DELETE FROM billcom_bills_ref").run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. same vendor, same total, dates 3 days apart → hit, reason prefixed fuzzy:", () => {
    const rowId = seedRow({ forwardedDaysAgo: 3 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const match = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });

    expect(match.hit).toBe(true);
    expect(match.existingId).toBe(rowId);
    expect(match.reason.startsWith("fuzzy:")).toBe(true);
    // Guardrail (e): every fuzzy suppression is logged with vendor, amount, row id.
    const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).toContain("AAA Cooper Transportation");
    expect(logged).toContain("534.85");
    expect(logged).toContain(String(rowId));
  });

  it("2. same vendor, $534.85 vs $534.90 (8¢ apart, outside $0.02) → NO hit", () => {
    seedRow({ ocrTotal: "534.90" });

    const match = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });

    expect(match.hit).toBe(false);
  });

  it("3. same vendor, same total, dates 30 days apart (> 14) → NO hit", () => {
    seedRow({ forwardedDaysAgo: 30 });

    const match = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });

    expect(match.hit).toBe(false);
  });

  it("4. different vendor, identical total and date → NO hit", () => {
    seedRow({ ocrVendorName: "Belt Power LLC" });

    const match = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });

    expect(match.hit).toBe(false);
  });

  it("5. 'AAA COOPER TRANSPORTATION' vs 'AAA Cooper Transportation' normalizes equal → hit", () => {
    seedRow({ ocrVendorName: "AAA Cooper Transportation" });

    const match = findFuzzyDuplicate({
      vendorName: "AAA COOPER TRANSPORTATION",
      total: 534.85,
    });

    expect(match.hit).toBe(true);
  });

  it("6. empty vendor name → NO hit, never guesses", () => {
    seedRow();

    expect(
      findFuzzyDuplicate({ vendorName: "", total: 534.85 }).hit,
    ).toBe(false);
    expect(
      findFuzzyDuplicate({ vendorName: "   ", total: 534.85 }).hit,
    ).toBe(false);
  });

  it("7. total 0 or NaN → NO hit", () => {
    seedRow();

    expect(
      findFuzzyDuplicate({ vendorName: "AAA Cooper Transportation", total: 0 }).hit,
    ).toBe(false);
    expect(
      findFuzzyDuplicate({ vendorName: "AAA Cooper Transportation", total: NaN }).hit,
    ).toBe(false);
  });

  it("8. ERROR row must NOT suppress — only FORWARDED/CLAIMED/PENDING_SEND consulted", () => {
    seedRow({ status: "ERROR" });

    const match = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });

    expect(match.hit).toBe(false);
  });

  it("9. excludeId prevents a row matching itself", () => {
    const rowId = seedRow();

    const withSelf = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
      excludeId: rowId,
    });
    expect(withSelf.hit).toBe(false);

    const withoutExclude = findFuzzyDuplicate({
      vendorName: "AAA Cooper Transportation",
      total: 534.85,
    });
    expect(withoutExclude.hit).toBe(true);
    expect(withoutExclude.existingId).toBe(rowId);
  });

  it("10. integration: forwardInvoiceOnce returns already_forwarded with reason starting 'fuzzy:'", async () => {
    // A freshly-generated PDF from the same vendor: different bytes, different
    // filename, different message, no invoice number — only the fuzzy layer can catch it.
    seedRow({ forwardedDaysAgo: 3, pdfHash: "seed-hash", messageId: "seed-msg", filename: "seed.pdf" });

    const result = await forwardInvoiceOnce({
      gmailMessageId: "new-msg",
      emailFrom: "act.statement@aaacooper.com",
      emailSubject: "Invoice Stmt",
      pdfFilename: "freshly-generated.pdf",
      pdfBuffer: Buffer.from("%PDF-1.4 brand new bytes 2026-08-13"),
      vendorName: "AAA Cooper Transportation",
      invoiceTotal: 534.85,
      source: "local-forwarder",
      gmail: {
        users: {
          messages: {
            send: async () => ({ data: { id: "sent-fuzzy" } }),
          },
        },
      },
    });

    expect(result.status).toBe("already_forwarded");
    if (result.status === "already_forwarded") {
      expect(result.reason.startsWith("fuzzy:")).toBe(true);
    }
  });
});
