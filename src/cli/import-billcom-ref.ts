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
 *   npx tsx src/cli/import-billcom-ref.ts --csv=path/to/custom.csv
 */

import { getLocalDb } from "@/lib/storage/local-db";
import fs from "fs";
import path from "path";

const DEFAULT_CSV = path.resolve(process.cwd(), "data", "AllBillsPage.csv");

// ── CSV Column Mapping ───────────────────────────────────────────────────────
// Bill.com "All Bills" CSV → billcom_bills_ref columns.
// Column names are matched case-insensitively on the header row prefix.

interface ColumnMap {
  invoiceNumber: string[];
  vendorName: string[];
  invoiceAmount: string[];
  invoiceDate: string[];
  dueDate: string[];
  createdDate: string[];
  poNumber: string[];
  chartOfAccount: string[];
  billType: string[];
  paymentStatus: string[];
  currency: string[];
}

const COLUMN_MAP: ColumnMap = {
  invoiceNumber: ["invoice no", "invoice number", "inv no", "inv #", "invoice#", "invoice num"],
  vendorName: ["vendor name", "vendor", "supplier", "payee"],
  invoiceAmount: ["invoice amount", "bill amount", "total amount", "amount", "total", "amt"],
  invoiceDate: ["invoice date", "inv date", "bill date", "issue date", "issued"],
  dueDate: ["due date", "payment due", "due by", "due"],
  createdDate: ["created date", "date created", "date added", "entered date", "added date"],
  poNumber: ["po number", "po no", "po #", "po#", "purchase order number", "purchase order"],
  chartOfAccount: ["chart of account", "gl account", "gl category", "category", "account"],
  billType: ["bill type", "entry type", "bill type", "type"],
  paymentStatus: ["payment status", "pay status", "status", "state"],
  currency: ["currency", "curr"],
};

// ── Parsing ──────────────────────────────────────────────────────────────────

interface ParsedRow {
  invoice_number: string;
  vendor_name: string;
  invoice_amount: number | null;
  invoice_date: string | null;
  due_date: string | null;
  created_date: string | null;
  po_number: string | null;
  chart_of_account: string | null;
  bill_type: string | null;
  payment_status: string | null;
  currency: string | null;
}

export type { ParsedRow };

/**
 * Find a column index by matching header text against known names.
 *
 * Resolution is deliberate to avoid cross-column poison:
 *   pass 1 — exact normalized equality (e.g. "Invoice no." vs "invoice no")
 *   pass 2 — header CONTAINS a label name, but only names ≥ 6 chars, so a
 *            generic short name like "date" can never grab "Created date"
 *            before the real "Invoice date" column.
 *   pass 3 — short generics (≤5 chars: type, due, amt, …) exact-or-startswith,
 *            used only when no longer label matched.
 */
function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findColumn(headers: string[], names: string[]): number {
  const normalized = names.map(normalizeHeader).filter((n) => n.length > 0);

  // Pass 1: exact normalized match
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i] || "");
    if (h && normalized.includes(h)) return i;
  }

  // Pass 2: header contains a meaningful label (long names only)
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i] || "");
    if (!h) continue;
    if (normalized.some((n) => n.length >= 6 && h.includes(n))) return i;
  }

  // Pass 3: short generic (≤5 chars) exact or starts-with
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i] || "");
    if (!h) continue;
    if (normalized.some((n) => n.length < 6 && (h === n || h.startsWith(n)))) return i;
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
 * Exported for reconcile-billcom.ts (duplicate-bill scan on RAW rows, before the
 * UNIQUE(vendor, invoice#) UPSERT collapses exact-dup entries).
 */
export function parseCSV(filePath: string): ParsedRow[] {
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
      created_date: parseDate(fields[colIdx.createdDate] || ""),
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
  const updated = 0; // SQLite changes() counts inserts+updates together; kept for API shape
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
      } catch (err: unknown) {
        console.warn(
          `[billcom-import] Failed to upsert ${row.vendor_name} #${row.invoice_number}: ${err instanceof Error ? err.message : String(err)}`,
        );
        errors++;
      }
    }
  });

  insertAll();
  return { inserted, updated, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Import a Bill.com All Bills CSV into billcom_bills_ref (UPSERT).
 * Exported for reuse by reconcile-billcom.ts so one run = import + sweep.
 */
export async function importCsvFile(csvPath: string): Promise<{ inserted: number; updated: number; errors: number; rows: number }> {
  console.log(`[billcom-import] Importing Bill.com reference data...`);
  console.log(`[billcom-import] CSV: ${csvPath}`);

  if (!fs.existsSync(csvPath)) {
    console.error(`[billcom-import] CSV not found at ${csvPath}`);
    console.error("[billcom-import] Run download-billcom-ref.ts first, or provide --csv=path/to/file.csv");
    process.exitCode = 1;
    return { inserted: 0, updated: 0, errors: 0, rows: 0 };
  }

  const stats = fs.statSync(csvPath);
  console.log(`[billcom-import] File size: ${(stats.size / 1024).toFixed(1)} KB`);

  let rows: ParsedRow[];
  try {
    rows = parseCSV(csvPath);
  } catch (err: unknown) {
    console.error(`[billcom-import] Parse error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return { inserted: 0, updated: 0, errors: 0, rows: 0 };
  }

  console.log(`[billcom-import] Parsed ${rows.length} rows`);

  if (rows.length === 0) {
    console.warn("[billcom-import] No rows to import — CSV may be empty or malformed.");
    return { inserted: 0, updated: 0, errors: 0, rows: 0 };
  }

  const result = importRows(rows);

  // Count total rows in table for reporting
  const db = getLocalDb();
  const total = (db.prepare("SELECT COUNT(*) AS cnt FROM billcom_bills_ref").get() as { cnt: number }).cnt;

  console.log(
    `[billcom-import] ✓ Imported: ${result.inserted + result.updated} rows written ` +
    `(${result.errors} errors). Table total: ${total} rows.`,
  );
  return { ...result, rows: rows.length };
}

export async function main(): Promise<void> {
  // Allow custom CSV path via --csv= argument
  const csvArg = process.argv.find((a) => a.startsWith("--csv="));
  const csvPath = csvArg ? csvArg.split("=")[1] : DEFAULT_CSV;
  await importCsvFile(csvPath);
}

// CLI entry point
if (require.main === module) {
  main().catch((err) => {
    console.error("[billcom-import] Unhandled:", err);
    process.exit(1);
  });
}
