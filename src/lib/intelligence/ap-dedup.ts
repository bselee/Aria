/**
 * @file    src/lib/intelligence/ap-dedup.ts
 * @purpose Single source of truth for AP invoice deduplication.
 *          Used by local-first forwarder AND ap-single-forward claim path.
 *          Rule: log once, never re-send the same invoice content or vendor+inv#.
 * @author  Hermia
 * @created 2026-07-09
 * @updated 2026-07-17 — vendor+invoice OCR, invoice_cache, SKIPPED logging
 * @updated 2026-08-13 — fuzzy vendor+amount+date dedup layer (Workstream D)
 * @deps    @/lib/storage/local-db
 */

import { getLocalDb } from "@/lib/storage/local-db";

/** Statuses that mean "do not send again" — always bound as parameters. */
const TAKEN_STATUS_LIST = ["FORWARDED", "CLAIMED", "PENDING_SEND"] as const;
const TAKEN_IN_CLAUSE = TAKEN_STATUS_LIST.map(() => "?").join(", ");

/**
 * Returns true if this invoice PDF has already been claimed or forwarded.
 * Content-hash is authoritative.
 */
export function isDuplicate(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
): boolean {
  const db = getLocalDb();
  const taken = [...TAKEN_STATUS_LIST];

  // Layer 2 first: content hash
  const byHash = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE pdf_content_hash = ?
       AND status IN (${TAKEN_IN_CLAUSE})
       LIMIT 1`,
    )
    .get(pdfHash, ...taken);
  if (byHash) return true;

  // Layer 1: message_id + filename (original or common sanitize variants)
  const byKey = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE gmail_message_id = ? AND pdf_filename = ?
       AND status IN (${TAKEN_IN_CLAUSE})
       LIMIT 1`,
    )
    .get(gmailMessageId, pdfFilename, ...taken);

  return !!byKey;
}

/**
 * Full multi-layer dedup: hash, message+filename, vendor+invoice# (OCR/cache/Bill.com ref).
 * Prefer this when vendor/invoice are known so we never re-send a bill already logged.
 */
export function isAlreadyForwarded(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
  vendorName?: string,
  invoiceNumber?: string,
): boolean {
  if (isDuplicate(gmailMessageId, pdfFilename, pdfHash)) return true;

  const inv = (invoiceNumber || "").trim();
  const vendor = (vendorName || "").trim();
  if (vendor && inv && !/^(unknown|n\/a|na|none)$/i.test(inv)) {
    try {
      const db = getLocalDb();

      // Layer 3: already in Bill.com reference import
      try {
        const ref = db
          .prepare(
            `SELECT 1 FROM billcom_bills_ref
             WHERE LOWER(vendor_name) = LOWER(?)
             AND invoice_number = ?
             LIMIT 1`,
          )
          .get(vendor, inv);
        if (ref) return true;
      } catch {
        /* table may not exist in some envs */
      }

      // Layer 4: prior forward row with same OCR vendor+invoice
      const byOcr = db
        .prepare(
          `SELECT 1 FROM ap_local_forwards
           WHERE status IN (${TAKEN_IN_CLAUSE})
             AND LOWER(COALESCE(ocr_vendor_name, '')) = LOWER(?)
             AND ocr_invoice_number = ?
           LIMIT 1`,
        )
        .get(...takenParams(), vendor, inv);
      if (byOcr) return true;

      // Layer 5: local invoice_cache (365d AP logs)
      try {
        const byCache = db
          .prepare(
            `SELECT 1 FROM invoice_cache
             WHERE LOWER(vendor_name) = LOWER(?)
               AND invoice_number = ?
               AND expire_at > datetime('now')
             LIMIT 1`,
          )
          .get(vendor, inv);
        if (byCache) return true;
      } catch {
        /* non-fatal */
      }
    } catch {
      // DB error — assume not forwarded
    }
  }

  return false;
}

/** Result of the last-resort fuzzy dedup — `reason` always starts with "fuzzy:". */
export interface FuzzyDuplicateMatch {
  hit: boolean;
  reason: string;
  existingId?: number;
  existingBillcomMessageId?: string | null;
}

/**
 * Normalize a vendor name for fuzzy comparison: lowercase, strip punctuation,
 * collapse whitespace, drop trailing legal/business suffixes.
 * "AAA COOPER TRANSPORTATION" === "AAA Cooper Transportation, LLC".
 */
function normalizeVendorName(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s+(llc|inc|corp|co|ltd|transportation)$/, "");
  } while (s !== prev);
  return s;
}

/** Absolute day distance between two date strings; Infinity on unparseable input. */
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / (24 * 60 * 60 * 1000);
}

/**
 * Last-resort dedup: same vendor, same total (±tolerance ABSOLUTE dollars),
 * invoice date within ±dayWindow. Only consults rows already in
 * FORWARDED/CLAIMED/PENDING_SEND — an ERROR row must never suppress a retry.
 *
 * WHY IT EXISTS: a vendor re-sending the same invoice as a freshly-generated
 * PDF defeats hash, message+filename, and (often OCR-garbled) invoice# layers.
 * Vendor + amount + date is the last remaining signal.
 *
 * DANGER: a false positive here suppresses a REAL bill. Guardrails:
 * - Requires BOTH a non-empty vendor name AND a finite total > 0 — never guess.
 * - Amount tolerance is absolute dollars (default $0.02), NOT a percentage —
 *   two genuinely different freight bills are frequently within 2% of each other.
 * - When invoiceDate is missing on either side, fall back to comparing
 *   forwarded_at within dayWindow. Rows with no date evidence can never suppress.
 * - Every suppression is logged via console.warn with vendor, amount, row id.
 *
 * @param args.vendorName       OCR vendor name of the incoming invoice
 * @param args.total            Invoice total in dollars (finite, > 0 required)
 * @param args.invoiceDate      Invoice date (ISO/SQLite); falls back to "now"
 * @param args.excludeId        Row id to ignore (self-match protection)
 * @param args.amountTolerance  Absolute-dollar tolerance, default 0.02
 * @param args.dayWindow        Date window in days, default 14
 * @returns FuzzyDuplicateMatch with `reason` prefixed "fuzzy:" on hit
 */
export function findFuzzyDuplicate(args: {
  vendorName: string;
  total: number;
  invoiceDate?: string | null;
  excludeId?: number;
  amountTolerance?: number; // default 0.02 absolute dollars
  dayWindow?: number; // default 14
}): FuzzyDuplicateMatch {
  const vendor = (args.vendorName || "").trim();
  if (!vendor) return { hit: false, reason: "" };
  if (!Number.isFinite(args.total) || args.total <= 0) {
    return { hit: false, reason: "" };
  }

  const tolerance = args.amountTolerance ?? 0.02;
  const dayWindow = args.dayWindow ?? 14;
  const normalizedVendor = normalizeVendorName(vendor);
  if (!normalizedVendor) return { hit: false, reason: "" };

  try {
    const db = getLocalDb();
    const taken = [...TAKEN_STATUS_LIST];

    const rows = db
      .prepare(
        `SELECT id, ocr_vendor_name, ocr_total, forwarded_at, billcom_sent_message_id
         FROM ap_local_forwards
         WHERE status IN (${TAKEN_IN_CLAUSE})
           AND ocr_vendor_name IS NOT NULL
           AND ocr_total IS NOT NULL`,
      )
      .all(...taken) as Array<{
      id: number;
      ocr_vendor_name: string | null;
      ocr_total: string | null;
      forwarded_at: string | null;
      billcom_sent_message_id: string | null;
    }>;

    const incomingDate = args.invoiceDate || new Date().toISOString();
    for (const row of rows) {
      if (args.excludeId !== undefined && row.id === args.excludeId) continue;
      if (!row.ocr_vendor_name) continue;
      if (normalizeVendorName(row.ocr_vendor_name) !== normalizedVendor) continue;
      // ocr_total is stored as TEXT (String(norm.total)) — parse defensively.
      const rowTotal = parseFloat(row.ocr_total || "");
      if (!Number.isFinite(rowTotal) || rowTotal <= 0) continue;
      // Absolute-dollar tolerance, NOT percentage.
      if (Math.abs(rowTotal - args.total) > tolerance) continue;
      // Date window: invoice date when provided, else forwarded_at fallback.
      if (!row.forwarded_at) continue;
      if (daysBetween(incomingDate, row.forwarded_at) > dayWindow) continue;

      console.warn(
        `[ap-dedup] fuzzy SUPPRESSED vendor="${args.vendorName}" amount=${args.total} matchedRowId=${row.id} (existing ocr_total=${row.ocr_total}, forwarded_at=${row.forwarded_at})`,
      );
      return {
        hit: true,
        reason: `fuzzy: vendor+amount+date (row ${row.id})`,
        existingId: row.id,
        existingBillcomMessageId: row.billcom_sent_message_id,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ap-dedup] findFuzzyDuplicate failed: ${msg}`);
  }

  return { hit: false, reason: "" };
}

function takenParams(): string[] {
  return [...TAKEN_STATUS_LIST];
}

/**
 * Record a deliberate skip (routing / non-invoice / prepaid) so we log the
 * email without ever forwarding. Idempotent on message+filename.
 */
export function recordSkippedForward(args: {
  gmailMessageId: string;
  emailFrom: string;
  emailSubject: string;
  pdfFilename: string;
  pdfHash?: string;
  reason: string;
  vendorRoutingAction?: string;
}): void {
  try {
    const db = getLocalDb();
    const hash = args.pdfHash || `skip:${args.gmailMessageId}:${args.pdfFilename}`.slice(0, 64);
    const existing = db
      .prepare(
        `SELECT id FROM ap_local_forwards
         WHERE gmail_message_id = ? AND pdf_filename = ?
         LIMIT 1`,
      )
      .get(args.gmailMessageId, args.pdfFilename) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE ap_local_forwards
         SET status = 'SKIPPED',
             error_message = ?,
             vendor_routing_action = COALESCE(?, vendor_routing_action),
             forwarded_at = datetime('now')
         WHERE id = ?`,
      ).run(args.reason.slice(0, 500), args.vendorRoutingAction || null, existing.id);
      return;
    }
    db.prepare(
      `INSERT INTO ap_local_forwards
         (gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
          status, error_message, vendor_routing_action, forwarded_at)
       VALUES (?, ?, ?, ?, ?, 'SKIPPED', ?, ?, datetime('now'))`,
    ).run(
      args.gmailMessageId,
      args.emailFrom,
      args.emailSubject,
      args.pdfFilename || "(none)",
      hash,
      args.reason.slice(0, 500),
      args.vendorRoutingAction || "skip",
    );
  } catch (e: any) {
    console.warn(`[ap-dedup] recordSkippedForward failed: ${e?.message || e}`);
  }
}
