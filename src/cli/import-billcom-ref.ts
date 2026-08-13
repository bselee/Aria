/**
 * @file    src/cli/import-billcom-ref.ts
 * @purpose Import the AllBillsPage.csv export from bill.com into the
 *          billcom_bills_ref SQLite table. UPSERTs on (vendor_name, invoice_number)
 *          so re-running is idempotent.
 *
 *          The billcom_bills_ref table feeds the dedup check in
 *          ap-single-forward.ts → isAlreadyClaimedOrForwarded() — if a
 *          vendor+invoice# already exists in Bill.com, Aria skips forwarding.
 *
 * @author  Hermia
 * @created 2026-07-30
 * @updated 2026-07-30 — Initial implementation; replaces placeholder cron ref.
 * @deps    better-sqlite3 (via local-db)
 *
 * Usage:
 *   npx tsx src/cli/import-billcom-ref.ts
 *   npx tsx src/cli/import-billcom-ref.ts --inbox
 *   npx tsx src/cli/import-billcom-ref.ts --csv=path/to/custom.csv
 */

import { getLocalDb } from "@/lib/storage/local-db";
import { resolveBillComCsv, isRefDataStale, listBillComInboxCsvs } from "@/lib/intelligence/ap/billcom-csv-source";
import fs from "fs";

// ── CSV Column Mapping ───────────────────────────────────────────────────────
// Bill.com "All Bills" CSV → billcom_bills_ref columns.
// Column names are matched case-insensitively on the header row prefix.

interface ColumnMap {
  invoiceNumber: string[];
  vendorName: string[];
  invoiceAmount: string[];
  invoiceDate: string[];
  dueDate: string[];
  poNumber: string[];
  chartOfAccount: string[];
  billType: string[];
  paymentStatus: string[];
  currency: string[];
}

const COLUMN_MAP: ColumnMap = {
  // 'Invoice no.' is the real Bill.com export header (verified 2026-08-13 on
  // ~/Downloads/AllBillsPage (16).csv) — 'no.' needed as an alias.
  invoiceNumber: ["invoice #", "invoice number", "inv #", "invoice#", "number", "inv num", "invoice no."],
  vendorName: ["vendor", "vendor name", "supplier", "payee", "from"],
  invoiceAmount: ["amount", "total", "invoice amount", "bill amount", "total amount", "amt"],
  invoiceDate: ["invoice date", "date", "inv date", "bill date", "issued"],
  dueDate: ["due date", "due", "payment due", "pay by"],
  // 'PO no.' is likewise the real export header.
  poNumber: ["po #", "po number", "purchase order", "po#", "reference", "po no."],
  chartOfAccount: ["chart of account", "category", "account", "gl account", "coa"],
  billType: ["bill type", "type", "entry type", "source", "origin"],
  paymentStatus: ["payment status", "status", "pay status", "state"],
  currency: ["currency", "curr"],
};

// ── Parsing ──────────────────────────────────────────────────────────────────

interface ParsedRow {
  invoice_number: string;
  vendor_name: string;
  invoice_amount: number | null;
  invoice_date: string | null;
  due_date: string | null;
  po_number: string | null;
  chart_of_account: string | null;
  bill_type: string | null;
  payment_status: string | null;
  currency: string | null;
}

/**
 * Find a column index by matching header text against known names.
 */
function findColumn(headers: string[], names: string[]): number {
  const lowerNames = names.map((n) => n.toLowerCase().trim());
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || "").toLowerCase().trim();
    if (lowerNames.some((n) => h === n || h.startsWith(n) || h.includes(n))) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse a single CSV line respecting quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Safely parse a dollar amount string to a number.
 */
function parseAmount(raw: string): number | null {
  if (!raw) return null;
  // Remove currency symbols, commas, spaces
  const cleaned = raw.replace(/[$£€,\s]/g, "").trim();
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Safely parse a date string. Returns ISO format (YYYY-MM-DD) or null.
 */
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return trimmed;

  // Month DD, YYYY
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const longMatch = trimmed.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (longMatch) {
    const [, mon, d, y] = longMatch;
    const mm = months[mon.toLowerCase().slice(0, 3)];
    if (mm) return `${y}-${mm}-${d.padStart(2, "0")}`;
  }

  return null;
}

/**
 * Parse the entire CSV file into structured rows.
 */
function parseCSV(filePath: string): ParsedRow[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 2) {
    console.warn("[billcom-import] CSV has fewer than 2 lines — nothing to import");
    return [];
  }

  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine);

  console.log(`[billcom-import] CSV headers: ${headers.join(", ")}`);

  // Map column indices
  const colIdx: Record<string, number> = {};
  for (const [key, names] of Object.entries(COLUMN_MAP)) {
    colIdx[key] = findColumn(headers, names);
  }

  // Log which columns were found
  for (const [key, idx] of Object.entries(colIdx)) {
    if (idx >= 0) {
      console.log(`[billcom-import]   ${key} → column "${headers[idx]}" (idx ${idx})`);
    } else {
      console.log(`[billcom-import]   ${key} → NOT FOUND`);
    }
  }

  if (colIdx.invoiceNumber < 0 || colIdx.vendorName < 0) {
    throw new Error(
      "CSV must have 'Invoice #' and 'Vendor' columns. " +
      `Found headers: ${headers.join(", ")}`,
    );
  }

  // Parse data rows
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    const invoiceNumber = (fields[colIdx.invoiceNumber] || "").trim();
    const vendorName = (fields[colIdx.vendorName] || "").trim();

    // Skip rows with empty required fields
    if (!invoiceNumber || !vendorName) continue;
    // Skip header-like rows that might appear mid-file
    if (invoiceNumber.toLowerCase() === "invoice #") continue;

    rows.push({
      invoice_number: invoiceNumber,
      vendor_name: vendorName,
      invoice_amount: parseAmount(fields[colIdx.invoiceAmount] || ""),
      invoice_date: parseDate(fields[colIdx.invoiceDate] || ""),
      due_date: parseDate(fields[colIdx.dueDate] || ""),
      po_number: (fields[colIdx.poNumber] || "").trim() || null,
      chart_of_account: (fields[colIdx.chartOfAccount] || "").trim() || null,
      bill_type: (fields[colIdx.billType] || "").trim() || null,
      payment_status: (fields[colIdx.paymentStatus] || "").trim() || null,
      currency: (fields[colIdx.currency] || "").trim() || null,
    });
  }

  return rows;
}

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * UPSERT parsed rows into billcom_bills_ref.
 * Uses INSERT OR REPLACE on the UNIQUE(vendor_name, invoice_number) constraint.
 */
function importRows(rows: ParsedRow[]): { inserted: number; updated: number; errors: number } {
  const db = getLocalDb();
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  const upsert = db.prepare(`
    INSERT INTO billcom_bills_ref (
      invoice_number, vendor_name, invoice_amount, invoice_date, due_date,
      po_number, chart_of_account, bill_type, payment_status, currency,
      imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(invoice_number, vendor_name) DO UPDATE SET
      invoice_amount = excluded.invoice_amount,
      invoice_date = excluded.invoice_date,
      due_date = excluded.due_date,
      po_number = excluded.po_number,
      chart_of_account = excluded.chart_of_account,
      bill_type = excluded.bill_type,
      payment_status = excluded.payment_status,
      currency = excluded.currency,
      imported_at = datetime('now')
  `);

  const insertAll = db.transaction(() => {
    for (const row of rows) {
      try {
        const result = upsert.run(
          row.invoice_number,
          row.vendor_name,
          row.invoice_amount,
          row.invoice_date,
          row.due_date,
          row.po_number,
          row.chart_of_account,
          row.bill_type,
          row.payment_status,
          row.currency,
        );
        // SQLite's changes() counts both inserts and updates
        if (result.changes > 0) inserted++;
        // We can't easily distinguish insert vs update without last_insert_rowid
        // tracking, but the total changes tell us rows were written
      } catch (err: any) {
        console.warn(
          `[billcom-import] Failed to upsert ${row.vendor_name} #${row.invoice_number}: ${err.message}`,
        );
        errors++;
      }
    }
  });

  insertAll();
  return { inserted, updated, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function importInbox(): Promise<void> {
  const files = listBillComInboxCsvs().filter((f) => (f.vendorCount ?? 0) > 1);
  if (files.length === 0) {
    console.log("[billcom-import] inbox empty — drop AllBillsPage.csv in Downloads/Aria-Ingest/billcom/ then re-run");
    return;
  }
  console.log(`[billcom-import] inbox: ${files.length} multi-vendor file(s)`);
  for (const f of files) {
    console.log(`[billcom-import] CSV: ${f.path} (vendors=${f.vendorCount})`);
    const rows = parseCSV(f.path);
    const result = importRows(rows);
    console.log(`[billcom-import]   wrote ${result.inserted + result.updated} (err ${result.errors})`);
  }
  const db = getLocalDb();
  const total = (db.prepare("SELECT COUNT(*) AS cnt FROM billcom_bills_ref").get() as { cnt: number }).cnt;
  console.log(`[billcom-import] ✓ inbox done. Table total: ${total} rows.`);
}

export async function importCsvFile(csvPath: string): Promise<void> {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }
  const rows = parseCSV(csvPath);
  const result = importRows(rows);
  const db = getLocalDb();
  const total = (db.prepare("SELECT COUNT(*) AS cnt FROM billcom_bills_ref").get() as { cnt: number }).cnt;
  console.log(
    `[billcom-import] ${csvPath}: wrote ${result.inserted + result.updated} (err ${result.errors}). Table total: ${total}`,
  );
}

export async function main(): Promise<void> {
  console.log(`[billcom-import] Importing Bill.com reference data...`);

  const inboxMode = process.argv.includes("--inbox");
  if (inboxMode) {
    try {
      await importInbox();
    } catch (err: any) {
      console.error(`[billcom-import] --inbox: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
    return;
  }

  // Explicit --csv= override wins over auto-resolution.
  const csvArg = process.argv.find((a) => a.startsWith("--csv="));

  // Auto-resolve: data/AllBillsPage.csv (Playwright) first, then the newest
  // manual export in ~/Downloads/AllBillsPage*.csv — whichever is newer by mtime.
  // Keeps the ingest alive when the Playwright login fails (which it has been
  // since 2026-07-05) by falling back to Bill's hand-made exports.
  const resolved = csvArg ? null : resolveBillComCsv();
  if (resolved) {
    if (resolved.path) {
      console.log(
        `[billcom-import] Source: ${resolved.source} — ${resolved.path} ` +
        `(age ${resolved.ageHours !== null ? resolved.ageHours.toFixed(1) : "?"}h, mtime ${resolved.mtime ?? "?"})`,
      );
    } else {
      console.log(
        "[billcom-import] No Bill.com CSV found from any source (checked data/AllBillsPage.csv and ~/Downloads/AllBillsPage*.csv).",
      );
    }
  }

  // Make staleness loud instead of silent — a frozen billcom_bills_ref silently
  // disables duplicate detection in ap-single-forward.ts.
  const staleness = isRefDataStale();
  if (staleness.stale) {
    console.warn(
      `[billcom-import] ⚠ billcom_bills_ref is STALE ` +
        `(${staleness.ageHours !== null ? `${staleness.ageHours.toFixed(1)}h since last import` : "table empty or unreadable"}) ` +
        `— this import refreshes it.`,
    );
  } else {
    console.log(
      `[billcom-import] billcom_bills_ref is fresh (last import ${staleness.ageHours !== null ? staleness.ageHours.toFixed(1) : "?"}h ago).`,
    );
  }

  const csvPath = csvArg ? csvArg.split("=")[1] : resolved?.path ?? null;

  console.log(`[billcom-import] CSV: ${csvPath}`);

  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(`[billcom-import] CSV not found${csvPath ? ` at ${csvPath}` : " from any source"}`);
    console.error("[billcom-import] Run download-billcom-ref.ts first (or export from Bill.com), or provide --csv=path/to/file.csv");
    process.exitCode = 1;
    return;
  }

  const stats = fs.statSync(csvPath);
  console.log(`[billcom-import] File size: ${(stats.size / 1024).toFixed(1)} KB`);

  let rows: ParsedRow[];
  try {
    rows = parseCSV(csvPath);
  } catch (err: any) {
    console.error(`[billcom-import] Parse error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[billcom-import] Parsed ${rows.length} rows`);

  if (rows.length === 0) {
    console.warn("[billcom-import] No rows to import — CSV may be empty or malformed.");
    return;
  }

  const result = importRows(rows);

  // Count total rows in table for reporting
  const db = getLocalDb();
  const total = (db.prepare("SELECT COUNT(*) AS cnt FROM billcom_bills_ref").get() as { cnt: number }).cnt;

  console.log(
    `[billcom-import] ✓ Imported: ${result.inserted + result.updated} rows written ` +
    `(${result.errors} errors). Table total: ${total} rows.`,
  );
}

// CLI entry point
if (require.main === module) {
  main().catch((err) => {
    console.error("[billcom-import] Unhandled:", err);
    process.exit(1);
  });
}
