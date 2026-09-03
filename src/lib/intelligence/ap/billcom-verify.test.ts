/**
 * @file    src/lib/intelligence/ap/billcom-verify.test.ts
 * @purpose Unit tests for the forward→Bill.com verification sweep:
 *          matching rules (exact, normalized invoice#, amount+date fallback),
 *          grace period, staleness guard, and activation of the dead
 *          `verified` column on ap_local_forwards.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    better-sqlite3 (in-memory), vi.mock("@/lib/storage/local-db")
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

// In-memory DB mirroring the real aria-local.db schema for BOTH tables
// (ap_local_forwards with the `verified INTEGER DEFAULT 0` column included).
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
    reconciled_at DATETIME,
    completed_at DATETIME,
    vendor_routing_action TEXT,
    verified INTEGER DEFAULT 0,
    billcom_processed INTEGER DEFAULT 0,
    ocr_line_items TEXT,
    ocr_freight TEXT,
    ocr_tax TEXT,
    ocr_total TEXT,
    ocr_packing TEXT,
    ocr_vendor_name TEXT,
    ocr_invoice_number TEXT,
    ocr_confidence TEXT,
    ocr_raw_text TEXT,
    ocr_processed_at TEXT,
    reconciliation_result_json TEXT,
    reconciliation_verdict TEXT,
    UNIQUE(gmail_message_id, pdf_filename)
  );
  CREATE TABLE billcom_bills_ref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    invoice_amount REAL,
    invoice_date TEXT,
    due_date TEXT,
    po_number TEXT,
    chart_of_account TEXT,
    bill_type TEXT,
    payment_status TEXT,
    currency TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(invoice_number, vendor_name)
  );
`);

vi.mock("@/lib/storage/local-db", () => ({
  getLocalDb: () => mem,
}));

import { runForwardVerificationSweep } from "./billcom-verify";

// ─── helpers ─────────────────────────────────────────────────────────────────

let msgCounter = 0;

/** Date → "YYYY-MM-DD HH:MM:SS" (SQLite UTC datetime, same as CURRENT_TIMESTAMP). */
function isoToSqlite(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function hoursAgo(h: number): string {
  return isoToSqlite(new Date(Date.now() - h * 3_600_000));
}

/** Date → "MM/DD/YYYY" (the format billcom_bills_ref.invoice_date uses). */
function dateMMDDYYYY(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

function insertForward(row: {
  pdfFilename: string;
  forwardedAt: string;
  vendorName?: string | null;
  invoiceNumber?: string | null;
  ocrTotal?: string | null;
  status?: string;
  verified?: number;
  billcomProcessed?: number;
  emailFrom?: string | null;
  emailSubject?: string | null;
}): number {
  msgCounter += 1;
  const info = mem
    .prepare(
      `INSERT INTO ap_local_forwards (
         gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
         status, forwarded_at, ocr_vendor_name, ocr_invoice_number, ocr_total, verified, billcom_processed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `msg-${msgCounter}`,
      row.emailFrom ?? "vendor@example.com",
      row.emailSubject ?? "Invoice",
      row.pdfFilename,
      `hash-${row.pdfFilename}`,
      row.status ?? "FORWARDED",
      row.forwardedAt,
      row.vendorName ?? null,
      row.invoiceNumber ?? null,
      row.ocrTotal ?? null,
      row.verified ?? 0,
      row.billcomProcessed ?? 0,
    );
  return Number(info.lastInsertRowid);
}

function insertRef(row: {
  invoiceNumber: string;
  vendorName: string;
  invoiceAmount?: number | null;
  invoiceDate?: string | null;
  importedAt?: string | null;
}): void {
  mem
    .prepare(
      `INSERT INTO billcom_bills_ref (invoice_number, vendor_name, invoice_amount, invoice_date, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      row.invoiceNumber,
      row.vendorName,
      row.invoiceAmount ?? null,
      row.invoiceDate ?? null,
      row.importedAt ?? isoToSqlite(new Date()),
    );
}

function getVerified(id: number): number {
  const row = mem.prepare("SELECT verified FROM ap_local_forwards WHERE id = ?").get(id) as {
    verified: number;
  };
  return row.verified;
}

function getBillcomProcessed(id: number): number {
  const row = mem.prepare("SELECT billcom_processed FROM ap_local_forwards WHERE id = ?").get(id) as {
    billcom_processed: number;
  };
  return row.billcom_processed;
}

beforeEach(() => {
  mem.prepare("DELETE FROM ap_local_forwards").run();
  mem.prepare("DELETE FROM billcom_bills_ref").run();
  msgCounter = 0;
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("runForwardVerificationSweep", () => {
  it("1. exact vendor+invoice# match → verified incremented AND row verified=1", () => {
    insertRef({ invoiceNumber: "3198860", vendorName: "belt power", invoiceAmount: 534.85 });
    const id = insertForward({
      pdfFilename: "Inv3198860.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Belt Power",
      invoiceNumber: "3198860",
      ocrTotal: "534.85",
    });

    const result = runForwardVerificationSweep();

    expect(result.refStale).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.alreadyProcessed).toBe(0);
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1);
    expect(getVerified(id)).toBe(0);
  });

  it("2. normalized invoice# match (leading zeros stripped) → verified", () => {
    insertRef({ invoiceNumber: "64058411", vendorName: "ULINE", invoiceAmount: 3283.53 });
    const id = insertForward({
      pdfFilename: "Uline_Invoice.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Uline",
      invoiceNumber: "0064058411",
      ocrTotal: "3283.53",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1);
    expect(getVerified(id)).toBe(0);
  });

  it("3. forwarded, absent from ref, age > graceHours → appears in unconfirmed", () => {
    // Vendor must be WELL COVERED in the reference for absence to be
    // meaningful (see the vendor-coverage guard tests below), so seed enough
    // AAA Cooper rows to clear MIN_VENDOR_REF_ROWS while omitting 64058431.
    insertRef({ invoiceNumber: "999", vendorName: "FedEx", invoiceAmount: 100 });
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "640580" + String(i).padStart(2, "0"),
        vendorName: "AAA Cooper Transportation",
        invoiceAmount: 100 + i,
      });
    }
    const id = insertForward({
      pdfFilename: "ACT_STMD_ID_3380.PDF",
      forwardedAt: hoursAgo(72),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64058431",
      ocrTotal: "328.38",
    });

    const result = runForwardVerificationSweep();

    expect(result.refStale).toBe(false);
    expect(result.verified).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.unconfirmed).toHaveLength(1);
    const u = result.unconfirmed[0];
    expect(u.id).toBe(id);
    expect(u.vendorName).toBe("AAA Cooper Transportation");
    expect(u.invoiceNumber).toBe("64058431");
    expect(u.pdfFilename).toBe("ACT_STMD_ID_3380.PDF");
    expect(u.ageHours).toBeGreaterThan(24);
    expect(getVerified(id)).toBe(0);
  });

  it("4. forwarded, absent from ref, age < graceHours → NOT in unconfirmed", () => {
    insertRef({ invoiceNumber: "999", vendorName: "FedEx", invoiceAmount: 100 });
    insertForward({
      pdfFilename: "fresh.pdf",
      forwardedAt: hoursAgo(2),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64058431",
      ocrTotal: "328.38",
    });

    const result = runForwardVerificationSweep();

    expect(result.refStale).toBe(false);
    expect(result.unconfirmed).toHaveLength(0);
  });

  it("5. empty or stale billcom_bills_ref → refStale true, unconfirmed empty", () => {
    // 5a: empty ref table — cannot verify anything
    insertForward({
      pdfFilename: "a.pdf",
      forwardedAt: hoursAgo(72),
      vendorName: "Vendor",
      invoiceNumber: "1",
      ocrTotal: "10",
    });
    let result = runForwardVerificationSweep();
    expect(result.refStale).toBe(true);
    expect(result.refAgeHours).toBeNull();
    expect(result.unconfirmed).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.verified).toBe(0);

    // 5b: ref imported_at older than staleHours (36h default) — same guard.
    // An otherwise-flag-worthy forward must NOT be flagged against stale data.
    insertRef({
      invoiceNumber: "999",
      vendorName: "FedEx",
      invoiceAmount: 1,
      importedAt: isoToSqlite(new Date(Date.now() - 40 * 3_600_000)),
    });
    result = runForwardVerificationSweep();
    expect(result.refStale).toBe(true);
    expect(result.refAgeHours).not.toBeNull();
    if (result.refAgeHours !== null) {
      expect(result.refAgeHours).toBeGreaterThan(36);
    }
    expect(result.unconfirmed).toHaveLength(0);
    expect(result.checked).toBe(0);
  });

  it("6. amount+date fallback matches when invoice# is null on both sides", () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    insertRef({
      invoiceNumber: "", // Bill.com has no invoice# for this bill
      vendorName: "AAA COOPER TRANSPORTATION",
      invoiceAmount: 534.85,
      invoiceDate: dateMMDDYYYY(twoDaysAgo),
    });
    const id = insertForward({
      pdfFilename: "ACT_STMD_ID_1.68.PDF",
      forwardedAt: isoToSqlite(twoDaysAgo),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: null, // OCR produced no invoice#
      ocrTotal: "534.85",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1);
    expect(getVerified(id)).toBe(0);
  });

  it("7. billcom_processed=1 rows are skipped; verified=1 rows are still examined", () => {
    insertRef({ invoiceNumber: "999", vendorName: "FedEx", invoiceAmount: 100 });
    // Seed AAA Cooper coverage so the pending row is adjudicable.
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "641180" + String(i).padStart(2, "0"),
        vendorName: "AAA Cooper Transportation",
        invoiceAmount: 200 + i,
      });
    }
    insertForward({
      pdfFilename: "already-judged.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64118005", // present in ref — would match if re-examined
      ocrTotal: "205",
      billcomProcessed: 1, // a previous Bill.com sweep already confirmed it
    });
    insertForward({
      pdfFilename: "pending.pdf",
      forwardedAt: hoursAgo(72),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64058431",
      ocrTotal: "328.38",
    });

    const result = runForwardVerificationSweep();

    expect(result.alreadyProcessed).toBe(1);
    expect(result.checked).toBe(1); // only the non-processed row is examined
    expect(result.verified).toBe(0);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.unconfirmed[0].pdfFilename).toBe("pending.pdf");
  });

  // ── Flag split (2026-08-13): verified vs billcom_processed ────────────────
  // gmail-delivery-verify.ts owns `verified` — it proves Gmail SENT the
  // forward. billcom-verify must judge processed-status independently via the
  // NEW `billcom_processed` column, never skip on verified=1, and never clear
  // it. Previously the Gmail sweep set verified=1 on ALL 274 forwards, so the
  // 9 AM Bill.com sweep skipped every row and never judged processed-status.

  it("verified=1 Gmail row still gets judged; match writes billcom_processed, never clears verified", () => {
    insertRef({ invoiceNumber: "3198860", vendorName: "belt power", invoiceAmount: 534.85 });
    const id = insertForward({
      pdfFilename: "gmail-verified.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Belt Power",
      invoiceNumber: "3198860",
      ocrTotal: "534.85",
      verified: 1, // the Gmail delivery sweep already confirmed the SEND
    });

    const result = runForwardVerificationSweep();

    // verified=1 must NOT skip the row — it is still judged against Bill.com.
    expect(result.alreadyProcessed).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.verified).toBe(1); // newly confirmed present in Bill.com
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1); // match written to the NEW column
    expect(getVerified(id)).toBe(1); // Gmail flag untouched (never cleared)
  });

  it("a match sets billcom_processed=1, NOT verified (verified stays owned by the Gmail sweep)", () => {
    insertRef({ invoiceNumber: "64058411", vendorName: "ULINE", invoiceAmount: 3283.53 });
    const id = insertForward({
      pdfFilename: "Uline_Invoice2.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Uline",
      invoiceNumber: "0064058411",
      ocrTotal: "3283.53",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(getBillcomProcessed(id)).toBe(1);
    expect(getVerified(id)).toBe(0); // billcom-verify must not touch verified
  });

  it("rows already billcom_processed are skipped, not re-judged", () => {
    insertRef({ invoiceNumber: "3198860", vendorName: "belt power", invoiceAmount: 534.85 });
    const id = insertForward({
      pdfFilename: "judged.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Belt Power",
      invoiceNumber: "3198860",
      ocrTotal: "534.85",
      billcomProcessed: 1,
      verified: 0,
    });

    const result = runForwardVerificationSweep();

    expect(result.alreadyProcessed).toBe(1);
    expect(result.checked).toBe(0); // not examined again
    expect(result.verified).toBe(0);
    expect(getBillcomProcessed(id)).toBe(1);
    expect(getVerified(id)).toBe(0); // untouched
  });

  // ── Invoice# matcher regressions (2026-08-13) ─────────────────────────────
  // Real misses: Abel's 481033 lands in Bill.com as "48 10 3 3/1" and
  // American Extracts 4485 as "SF4485". Both must match; two distinct long
  // Pro#s (64058414 vs 64058431) must never be conflated.

  it("481033 (Aria) matches ref '48 10 3 3/1' (Bill.com) via digit containment", () => {
    insertRef({
      invoiceNumber: "48 10 3 3/1",
      vendorName: "Abel's Ace Hardware",
      invoiceAmount: 100,
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    const id = insertForward({
      pdfFilename: "abels.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "Abel's Ace Hardware",
      invoiceNumber: "481033",
      ocrTotal: "100",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1);
  });

  it("4485 (Aria) matches ref 'SF4485' (Bill.com) — letters stripped", () => {
    insertRef({
      invoiceNumber: "SF4485",
      vendorName: "American Extracts",
      invoiceAmount: 200,
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    const id = insertForward({
      pdfFilename: "am-extracts.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "American Extracts",
      invoiceNumber: "4485",
      ocrTotal: "200",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
    expect(getBillcomProcessed(id)).toBe(1);
  });

  it("64058414 does NOT match 64058431 (distinct long Pro#s never conflated)", () => {
    // Seed AAA Cooper coverage so a genuine miss reaches unconfirmed.
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "640580" + String(i).padStart(2, "0"),
        vendorName: "AAA Cooper Transportation",
        invoiceAmount: 100 + i,
      });
    }
    insertRef({ invoiceNumber: "64058431", vendorName: "AAA Cooper Transportation", invoiceAmount: 328.38 });
    insertForward({
      pdfFilename: "ACT_STMD_64058414.PDF",
      forwardedAt: hoursAgo(72),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64058414",
      ocrTotal: "328.38",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(0);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.unconfirmed[0].invoiceNumber).toBe("64058414");
  });

  // ── Calibration regressions ───────────────────────────────────────────────
  // These lock in the false-positive fixes found by running the sweep against
  // the real aria-local.db, where it reported 185 "missing" bills that were in
  // fact present in Bill.com or simply unadjudicable. Recalibrated → 16.

  it("junk OCR vendor name must not block a real match (==Start of OCR for page 1==)", () => {
    // Observed live on rows 330/331: OCR wrote a page marker into
    // ocr_vendor_name, so exact/normalized matching could never fire and the
    // bill was reported missing even though Bill.com held it.
    insertRef({
      invoiceNumber: "64058890",
      vendorName: "AAA Cooper Transportation",
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    insertForward({
      pdfFilename: "junk-vendor.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "==Start of OCR for page 1==",
      invoiceNumber: null,
      emailFrom: "act.statement@aaacooper.com",
      emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 64058890",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
  });

  it("consignee/bill-to OCR name must not be treated as the vendor", () => {
    // AAA Cooper freight PDFs put the DESTINATION party in ocr_vendor_name
    // ("BUILDASOIL", "CONSIGNEE", "MOONLIGHT GARDEN SUPPLY").
    insertRef({
      invoiceNumber: "35943009",
      vendorName: "AAA Cooper Transportation",
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    insertForward({
      pdfFilename: "consignee.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "MOONLIGHT GARDEN SUPPLY",
      emailFrom: "act.statement@aaacooper.com",
      emailSubject: "Invoice Stmt - Cust 0001159492 Pro#: 35943009",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
  });

  it("vendor spelling differences across systems still match (Logan Labs, LLC vs LOGAN LABS LLC)", () => {
    insertRef({
      invoiceNumber: "135076",
      vendorName: "Logan Labs, LLC",
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    insertForward({
      pdfFilename: "logan.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "LOGAN LABS LLC",
      invoiceNumber: "135076",
    });

    const result = runForwardVerificationSweep();

    expect(result.verified).toBe(1);
    expect(result.unconfirmed).toHaveLength(0);
  });

  it("forwards older than the alert horizon are counted unadjudicable, never alerted", () => {
    // Paid bills age off the Bill.com export entirely (31 paid AAA Cooper bills
    // = $19,228.45 dropped off Apr–Jun 2026), so an old absence proves nothing.
    // Ref invoice_date is RECENT so the data-currency guard (2026-09-02) does
    // not flag the reference as frozen — this test is about the FORWARD's age.
    insertRef({
      invoiceNumber: "999999",
      vendorName: "Some Vendor",
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    insertForward({
      pdfFilename: "ancient.pdf",
      forwardedAt: hoursAgo(30 * 24), // 30 days — well past the 7-day horizon
      vendorName: "Totally Different Vendor",
      invoiceNumber: "12345678",
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(0);
    expect(result.unadjudicable).toBeGreaterThanOrEqual(1);
  });

  it("a row with no recoverable vendor AND no invoice# is unadjudicable, not a miss", () => {
    insertRef({
      invoiceNumber: "555555",
      vendorName: "Known Vendor",
      invoiceDate: dateMMDDYYYY(new Date()),
    });
    insertForward({
      pdfFilename: "anonymous.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: null,
      invoiceNumber: null,
      emailFrom: "unknown-sender@nowhere.example",
      emailSubject: "BUISA1 - URGENT UPDATE REQUIRED",
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(0);
    expect(result.unadjudicable).toBeGreaterThanOrEqual(1);
  });

  it("a comma-joined bundle invoice list never counts as one invoice number", () => {
    // Row 346 carried "64058414, 64058417, 64058410, ..." — a bundle artefact.
    insertForward({
      pdfFilename: "bundle.pdf",
      forwardedAt: hoursAgo(48),
      vendorName: "AAA Cooper Transportation",
      invoiceNumber: "64058414, 64058417, 64058410",
      emailFrom: "act.statement@aaacooper.com",
      emailSubject: "RE: Need remittance",
    });
    insertRef({
      invoiceNumber: "64058414",
      vendorName: "AAA Cooper Transportation",
      invoiceDate: dateMMDDYYYY(new Date()),
    });

    const result = runForwardVerificationSweep();

    // Must NOT falsely verify against a single ref row via the joined string.
    expect(result.verified).toBe(0);
  });

  it("a genuine recent miss is still reported (no over-suppression)", () => {
    // Uline must be well covered for its absence to mean anything.
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "2116600" + String(i).padStart(2, "0"),
        vendorName: "Uline",
        invoiceDate: dateMMDDYYYY(new Date()),
      });
    }
    insertForward({
      pdfFilename: "real-miss.pdf",
      forwardedAt: hoursAgo(50),
      vendorName: "Uline",
      invoiceNumber: "211660327", // present in Aria, absent from Bill.com
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(1);
    expect(result.unconfirmed[0].invoiceNumber).toBe("211660327");
  });

  // ── Vendor-coverage guard ─────────────────────────────────────────────────
  // Bill caught the sweep flagging Uline / Abel's / CR Minerals / Evergreen /
  // Logan Labs — vendors he knows "are always smooth". Root cause: the
  // reference table had been loaded from a SINGLE-VENDOR (AAA Cooper) export,
  // leaving those vendors with 2–7 rows. Absence from a reference that barely
  // covers a vendor is not evidence of anything.

  it("does NOT alert for a vendor with too few reference rows", () => {
    // Only 3 Uline rows in the reference → coverage is too thin to judge.
    insertRef({ invoiceNumber: "900001", vendorName: "Uline", invoiceDate: dateMMDDYYYY(new Date()) });
    insertRef({ invoiceNumber: "900002", vendorName: "Uline", invoiceDate: dateMMDDYYYY(new Date()) });
    insertRef({ invoiceNumber: "900003", vendorName: "Uline", invoiceDate: dateMMDDYYYY(new Date()) });

    insertForward({
      pdfFilename: "thin-uline.pdf",
      forwardedAt: hoursAgo(50),
      vendorName: "Uline",
      invoiceNumber: "211660327",
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(0);
    expect(result.unadjudicable).toBeGreaterThanOrEqual(1);
  });

  it("DOES alert for a well-covered vendor (guard is not a blanket mute)", () => {
    // 12 reference rows ⇒ above MIN_VENDOR_REF_ROWS, so absence is meaningful.
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "7770" + String(i).padStart(2, "0"),
        vendorName: "Covered Vendor",
        invoiceDate: dateMMDDYYYY(new Date()),
      });
    }
    insertForward({
      pdfFilename: "covered-miss.pdf",
      forwardedAt: hoursAgo(50),
      vendorName: "Covered Vendor",
      invoiceNumber: "888888", // genuinely absent
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(1);
    expect(result.unconfirmed[0].invoiceNumber).toBe("888888");
  });

  it("does NOT alert when the vendor cannot be resolved at all", () => {
    // Generic sender (Intuit/QuickBooks relay) that the vendor-pattern table
    // does not map — coverage is uncheckable, so absence proves nothing.
    for (let i = 1; i <= 12; i++) {
      insertRef({
        invoiceNumber: "6660" + String(i).padStart(2, "0"),
        vendorName: "Some Covered Vendor",
        invoiceDate: dateMMDDYYYY(new Date()),
      });
    }
    insertForward({
      pdfFilename: "no-vendor.pdf",
      forwardedAt: hoursAgo(50),
      vendorName: null,
      invoiceNumber: null,
      emailFrom: "LOGAN LABS LLC <quickbooks@notification.intuit.com>",
      emailSubject: "New payment request from LOGAN LABS LLC - invoice 135339",
    });

    const result = runForwardVerificationSweep();

    expect(result.unconfirmed).toHaveLength(0);
    expect(result.unadjudicable).toBeGreaterThanOrEqual(1);
  });
});
