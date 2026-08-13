/**
 * @file    billcom-csv-source.test.ts
 * @purpose Unit tests for Bill.com CSV source resolution (Playwright output vs
 *          Bill's manual ~/Downloads exports) and billcom_bills_ref staleness.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    vitest, better-sqlite3 (in-memory, mocked via @/lib/storage/local-db)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

// ── In-memory DB for isRefDataStale (same mock pattern as ap-single-forward.test.ts) ──
const mem = new Database(":memory:");
mem.exec(`
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

import { resolveBillComCsv, isRefDataStale } from "./billcom-csv-source";

// ── Fixtures ─────────────────────────────────────────────────────────────────
let dataDir: string;
let downloadsDir: string;

/** Write a file and pin its mtime — 'newest wins' must be deterministic. */
function touch(filePath: string, mtimeMs: number): void {
  fs.writeFileSync(filePath, "dummy,csv,content\n");
  const d = new Date(mtimeMs);
  fs.utimesSync(filePath, d, d);
}

const HOUR = 3_600_000;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "billcom-data-"));
  downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "billcom-dl-"));
  mem.prepare("DELETE FROM billcom_bills_ref").run();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(downloadsDir, { recursive: true, force: true });
});

describe("resolveBillComCsv", () => {
  it("picks data/AllBillsPage.csv when only the Playwright output exists", () => {
    const csvPath = path.join(dataDir, "AllBillsPage.csv");
    const mtime = Date.now() - 3 * HOUR;
    touch(csvPath, mtime);

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("playwright");
    expect(res.path).toBe(csvPath);
    expect(res.mtime).toBe(new Date(mtime).toISOString());
    expect(res.ageHours).not.toBeNull();
    expect(res.ageHours!).toBeCloseTo(3, 1);
  });

  it("picks the newest manual export from Downloads when it is the only source", () => {
    const csvPath = path.join(downloadsDir, "AllBillsPage (16).csv");
    const mtime = Date.now() - 5 * HOUR;
    touch(csvPath, mtime);

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("downloads");
    expect(res.path).toBe(csvPath);
    expect(res.ageHours!).toBeCloseTo(5, 1);
  });

  it("matches the exact filename shape with space and parentheses", () => {
    // Filenames like 'AllBillsPage (16).csv' must be found by the glob.
    const csvPath = path.join(downloadsDir, "AllBillsPage (16).csv");
    touch(csvPath, Date.now() - HOUR);
    expect(resolveBillComCsv({ dataDir, downloadsDir }).path).toBe(csvPath);
  });

  it("picks Downloads over data/ when the manual export is newer", () => {
    const dataCsv = path.join(dataDir, "AllBillsPage.csv");
    const dlCsv = path.join(downloadsDir, "AllBillsPage (16).csv");
    touch(dataCsv, Date.now() - 48 * HOUR);
    touch(dlCsv, Date.now() - 2 * HOUR);

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("downloads");
    expect(res.path).toBe(dlCsv);
  });

  it("picks data/ over Downloads when the Playwright output is newer", () => {
    const dataCsv = path.join(dataDir, "AllBillsPage.csv");
    const dlCsv = path.join(downloadsDir, "AllBillsPage (16).csv");
    touch(dataCsv, Date.now() - 1 * HOUR);
    touch(dlCsv, Date.now() - 48 * HOUR);

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("playwright");
    expect(res.path).toBe(dataCsv);
  });

  it("picks by mtime, not by filename sort order, among multiple exports", () => {
    // '(16)' sorts after '(15)' lexically, but (15) has the newest mtime.
    const p14 = path.join(downloadsDir, "AllBillsPage (14).csv");
    const p15 = path.join(downloadsDir, "AllBillsPage (15).csv");
    const p16 = path.join(downloadsDir, "AllBillsPage (16).csv");
    touch(p14, Date.now() - 40 * HOUR);
    touch(p15, Date.now() - 2 * HOUR);
    touch(p16, Date.now() - 30 * HOUR);

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("downloads");
    expect(res.path).toBe(p15);
  });

  it("also matches a paren-less AllBillsPage.csv in Downloads and ignores unrelated files", () => {
    const plain = path.join(downloadsDir, "AllBillsPage.csv");
    const unrelated = path.join(downloadsDir, "bills-q2.csv");
    touch(plain, Date.now() - 6 * HOUR);
    touch(unrelated, Date.now() - 1 * HOUR); // newest but must be ignored

    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("downloads");
    expect(res.path).toBe(plain);
  });

  it("returns source 'none' with no throw when nothing exists anywhere", () => {
    const res = resolveBillComCsv({ dataDir, downloadsDir });
    expect(res.source).toBe("none");
    expect(res.path).toBeNull();
    expect(res.mtime).toBeNull();
    expect(res.ageHours).toBeNull();
  });

  it("does not throw when the downloads dir does not exist", () => {
    const missing = path.join(os.tmpdir(), "billcom-dl-missing-" + Date.now());
    expect(() => resolveBillComCsv({ dataDir, downloadsDir: missing })).not.toThrow();
    expect(resolveBillComCsv({ dataDir, downloadsDir: missing }).source).toBe("none");
  });

  it("still finds the Playwright output when the downloads dir is missing", () => {
    const csvPath = path.join(dataDir, "AllBillsPage.csv");
    touch(csvPath, Date.now() - HOUR);
    const missing = path.join(os.tmpdir(), "billcom-dl-missing-" + Date.now());
    const res = resolveBillComCsv({ dataDir, downloadsDir: missing });
    expect(res.source).toBe("playwright");
    expect(res.path).toBe(csvPath);
  });

  it("defaults to the real data/ and ~/Downloads dirs when options are omitted", () => {
    const res = resolveBillComCsv();
    // Should resolve against the real filesystem without throwing.
    expect(["playwright", "downloads", "none"]).toContain(res.source);
  });
});

describe("isRefDataStale", () => {
  it("is fresh when the newest import is ~2 hours old", () => {
    mem.prepare(
      "INSERT INTO billcom_bills_ref (invoice_number, vendor_name, imported_at) VALUES (?, ?, datetime('now', '-2 hours'))",
    ).run("INV-1", "Vendor A");

    const res = isRefDataStale();
    expect(res.stale).toBe(false);
    expect(res.ageHours).not.toBeNull();
    expect(res.ageHours!).toBeCloseTo(2, 1);
  });

  it("is stale when the newest import is weeks old", () => {
    mem.prepare(
      "INSERT INTO billcom_bills_ref (invoice_number, vendor_name, imported_at) VALUES (?, ?, '2026-07-05 13:00:42')",
    ).run("INV-1", "Vendor A");

    const res = isRefDataStale();
    expect(res.stale).toBe(true);
    expect(res.ageHours).not.toBeNull();
    expect(res.ageHours!).toBeGreaterThan(24 * 7); // over a week
  });

  it("reports stale with null age on an empty table", () => {
    const res = isRefDataStale();
    expect(res.stale).toBe(true);
    expect(res.ageHours).toBeNull();
  });

  it("honors a custom threshold", () => {
    mem.prepare(
      "INSERT INTO billcom_bills_ref (invoice_number, vendor_name, imported_at) VALUES (?, ?, datetime('now', '-50 hours'))",
    ).run("INV-1", "Vendor A");

    expect(isRefDataStale().stale).toBe(true); // default 36h
    expect(isRefDataStale(100).stale).toBe(false); // custom 100h
  });

  it("treats an unreadable DB as stale rather than throwing", () => {
    // Drop the table to simulate a broken/unreadable DB.
    mem.exec("DROP TABLE billcom_bills_ref");
    try {
      const res = isRefDataStale();
      expect(res.stale).toBe(true);
      expect(res.ageHours).toBeNull();
    } finally {
      mem.exec(`
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
    }
  });
});
