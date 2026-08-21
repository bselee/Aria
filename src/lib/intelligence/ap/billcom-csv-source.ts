/**
 * @file    src/lib/intelligence/ap/billcom-csv-source.ts
 * @purpose Resolve the freshest usable Bill.com All-Bills CSV across the two
 *          known sources — the Playwright download (data/AllBillsPage.csv) and
 *          Bill's manual exports (~/Downloads/AllBillsPage*.csv) — and report
 *          how stale the billcom_bills_ref reference table has gone.
 *
 *          WHY THIS EXISTS (2026-08-13): the daily cron's Playwright login has
 *          been failing for weeks (data/billcom-error.png), data/AllBillsPage.csv
 *          never lands, and billcom_bills_ref froze on 2026-07-05 while Bill kept
 *          exporting CSVs by hand into ~/Downloads. This module makes the ingest
 *          survive the Playwright failure by falling back to the newest manual
 *          export, and surfaces staleness instead of failing silently.
 *
 * @author  Hermia
 * @created 2026-08-13
 * @deps    node:fs, node:os, node:path, @/lib/storage/local-db (better-sqlite3)
 */
import { getLocalDb } from "@/lib/storage/local-db";
import fs from "fs";
import os from "os";
import path from "path";

/** Where a resolved CSV came from. */
export type CsvSource = "playwright" | "downloads" | "none";

/** Result of resolving the freshest Bill.com All-Bills CSV. */
export interface CsvSourceResolution {
  /** Absolute path of the winning CSV, or null when no source has one. */
  path: string | null;
  /** Which source won. */
  source: CsvSource;
  /** File mtime as ISO string, or null. */
  mtime: string | null;
  /** Age of the winning file in hours (fractional), or null. */
  ageHours: number | null;
  /** Distinct vendor count in the winning CSV, or null when not inspectable. */
  vendorCount: number | null;
  /**
   * True when the winning CSV covers a single vendor — i.e. it is a FILTERED
   * export, not the full ledger. Importing one of these over a broad export
   * silently narrows billcom_bills_ref to that vendor and makes every other
   * vendor look absent from Bill.com.
   */
  singleVendor: boolean;
}

/** Result of checking how stale billcom_bills_ref has gone. */
export interface RefStaleness {
  /** True when the reference table cannot be trusted (empty, old, or unreadable). */
  stale: boolean;
  /** Age in hours of the newest import, or null when unknowable (empty/unreadable). */
  ageHours: number | null;
}

/** Default staleness threshold, matching the WS-A sweep's staleHours default. */
const DEFAULT_STALE_HOURS = 36;

interface CsvCandidate {
  filePath: string;
  mtimeMs: number;
  source: Exclude<CsvSource, "none">;
}

/** List matching manual-export filenames: 'AllBillsPage (16).csv', 'AllBillsPage.csv'. */
const DOWNLOADS_GLOB = /^AllBillsPage.*\.csv$/i;

/**
 * Count distinct vendors in a Bill.com All-Bills CSV without a full parse.
 *
 * WHY (2026-08-13): Bill's manual exports are often FILTERED to one vendor —
 * the AAA Cooper reconciliation exports are 100 rows, all
 * "AAA Cooper Transportation". Those files are newer than the last full
 * export, so pure mtime ranking picks them and the import narrows
 * billcom_bills_ref to a single vendor. Every other vendor then looks absent
 * from Bill.com, producing confident false "never landed" alerts.
 *
 * Reads at most `maxRows` data rows — enough to tell filtered from full.
 *
 * @param filePath - CSV to inspect
 * @param maxRows  - row cap for the scan (default 400)
 * @returns distinct vendor names found, or null when unreadable/no Vendor column
 */
export function countCsvVendors(filePath: string, maxRows = 400): number | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  if (lines.length < 2) return null;

  // Header may carry a UTF-8 BOM; strip it before matching column names.
  const header = splitCsvLine(lines[0].replace(/^\uFEFF/, ""));
  const vendorIdx = header.findIndex((h) => /^vendor$/i.test(h.trim()));
  if (vendorIdx === -1) return null;

  const vendors = new Set<string>();
  for (let i = 1; i < lines.length && i <= maxRows; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = splitCsvLine(line);
    const v = (cells[vendorIdx] ?? "").trim();
    if (v) vendors.add(v.toLowerCase());
  }
  return vendors.size > 0 ? vendors.size : null;
}

/** Split one CSV line, honouring double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else if (c.charCodeAt(0) !== 13) {
      // skip CR (13) so CRLF files don't leave a stray carriage return
      field += c;
    }
  }
  out.push(field);
  return out;
}

/**
 * Resolve the freshest usable Bill.com All-Bills CSV.
 *
 * 1. data/AllBillsPage.csv (Playwright output)
 * 2. newest ~/Downloads/AllBillsPage*.csv (Bill's manual export)
 *
 * Ranking is BREADTH FIRST, then recency: a multi-vendor export always beats a
 * single-vendor (filtered) one regardless of mtime, because importing a
 * filtered export over a full one silently narrows the reference table and
 * turns every uncovered vendor into a false "missing from Bill.com" alert.
 * Within the same breadth class, newest mtime wins (ties prefer the Playwright
 * output, the canonical automated source). Missing directories or unreadable
 * files are skipped, never thrown on.
 *
 * @param opts.dataDir       Directory holding the Playwright output; defaults to <cwd>/data.
 * @param opts.downloadsDir  Directory holding Bill's manual exports; defaults to ~/Downloads.
 * @returns The winning CSV's path, source, mtime, age, vendor breadth and a
 *          singleVendor flag — or source "none" with nulls when nothing exists.
 */
export function resolveBillComCsv(opts?: {
  dataDir?: string;
  downloadsDir?: string;
}): CsvSourceResolution {
  const dataDir = opts?.dataDir ?? path.resolve(process.cwd(), "data");
  const downloadsDir = opts?.downloadsDir ?? path.join(os.homedir(), "Downloads");

  const candidates: CsvCandidate[] = [];

  // 1. Playwright output — exact filename, single file.
  const playwrightPath = path.join(dataDir, "AllBillsPage.csv");
  const playwrightStats = safeStat(playwrightPath);
  if (playwrightStats) {
    candidates.push({ filePath: playwrightPath, mtimeMs: playwrightStats.mtimeMs, source: "playwright" });
  }

  // 2. Manual exports — glob must handle 'AllBillsPage (16).csv' (space + parens).
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(downloadsDir);
  } catch {
    entries = []; // missing/unreadable downloads dir — not an error
  }
  for (const name of entries) {
    if (!DOWNLOADS_GLOB.test(name)) continue;
    const filePath = path.join(downloadsDir, name);
    const stats = safeStat(filePath);
    if (stats) {
      candidates.push({ filePath, mtimeMs: stats.mtimeMs, source: "downloads" });
    }
  }

  if (candidates.length === 0) {
    return { path: null, source: "none", mtime: null, ageHours: null, vendorCount: null, singleVendor: false };
  }

  // Inspect breadth, then rank: multi-vendor beats single-vendor, newest first.
  const ranked = candidates
    .map((c) => ({ ...c, vendorCount: countCsvVendors(c.filePath) }))
    .sort((a, b) => {
      const aBroad = (a.vendorCount ?? 0) > 1 ? 1 : 0;
      const bBroad = (b.vendorCount ?? 0) > 1 ? 1 : 0;
      if (aBroad !== bBroad) return bBroad - aBroad; // breadth wins outright
      return b.mtimeMs - a.mtimeMs; // then recency
    });

  const winner = ranked[0];

  return {
    path: winner.filePath,
    source: winner.source,
    mtime: new Date(winner.mtimeMs).toISOString(),
    ageHours: Math.round(((Date.now() - winner.mtimeMs) / 3_600_000) * 100) / 100,
    vendorCount: winner.vendorCount,
    singleVendor: (winner.vendorCount ?? 0) === 1,
  };
}

/** Canonical drop folder so agents see weekly CUA/manual exports without chat attach. */
export function billcomInboxDir(): string {
  return path.join(os.homedir(), "Downloads", "Aria-Ingest", "billcom");
}

export interface InboxCsv {
  path: string;
  vendorCount: number | null;
  mtimeMs: number;
}

/**
 * List AllBillsPage*.csv in the agent inbox. Skips empty files.
 * Multi-vendor files first (breadth), then newest.
 */
export function listBillComInboxCsvs(inboxDir?: string): InboxCsv[] {
  const dir = inboxDir ?? billcomInboxDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: InboxCsv[] = [];
  for (const name of names) {
    if (!DOWNLOADS_GLOB.test(name)) continue;
    const filePath = path.join(dir, name);
    const st = safeStat(filePath);
    if (!st || !st.isFile() || st.size < 40) continue;
    const vendorCount = countCsvVendors(filePath);
    if (vendorCount === null || vendorCount < 1) continue;
    out.push({ path: filePath, vendorCount, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => {
    const aBroad = (a.vendorCount ?? 0) > 1 ? 1 : 0;
    const bBroad = (b.vendorCount ?? 0) > 1 ? 1 : 0;
    if (aBroad !== bBroad) return bBroad - aBroad;
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

/**
 * Report how stale billcom_bills_ref has gone, by comparing the newest
 * imported_at against now. Used to make staleness loud instead of silent:
 * the dedup layer in ap-single-forward.ts trusts this table, so a frozen
 * table silently disables duplicate detection.
 *
 * Never throws — an unreadable DB is reported as stale so callers alert
 * rather than crash (a thrown module must never break the forward path).
 *
 * @param hours  Staleness threshold in hours (default 36).
 * @returns stale flag plus the age in hours of the newest import (null when
 *          the table is empty or unreadable).
 */
export function isRefDataStale(hours: number = DEFAULT_STALE_HOURS): RefStaleness {
  let maxImported: string | null = null;
  try {
    const db = getLocalDb();
    const row = db
      .prepare("SELECT MAX(imported_at) AS max_imported FROM billcom_bills_ref")
      .get() as { max_imported: string | null } | undefined;
    maxImported = row?.max_imported ?? null;
  } catch {
    maxImported = null; // unreadable DB — treat as stale, never throw
  }

  if (!maxImported) {
    return { stale: true, ageHours: null };
  }

  // imported_at is SQLite datetime('now') = UTC 'YYYY-MM-DD HH:MM:SS'.
  const importedMs = new Date(maxImported.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(importedMs)) {
    return { stale: true, ageHours: null };
  }

  const ageHours = (Date.now() - importedMs) / 3_600_000;
  return { stale: ageHours > hours, ageHours: Math.round(ageHours * 100) / 100 };
}

/** statSync that returns null instead of throwing (ENOENT, EACCES, broken link...). */
function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
