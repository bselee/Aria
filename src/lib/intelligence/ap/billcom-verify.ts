/**
 * @file    src/lib/intelligence/ap/billcom-verify.ts
 * @purpose Forward→Bill.com verification sweep. forwardInvoiceOnce marks a row
 *          FORWARDED the instant Gmail accepts the outbound message — nothing
 *          ever confirms Bill.com parsed the PDF into a bill (AAA Cooper
 *          freight: 5 weeks of "successfully forwarded" while ~$35K went
 *          unpaid). This module reconciles ap_local_forwards against
 *          Bill.com and surfaces forwards that never landed.
 *
 *          Flag split (2026-08-13): `verified` is owned by
 *          gmail-delivery-verify.ts — it proves Gmail SENT the forward
 *          (all 274 rows were verified=1 after the Gmail sweep, which used
 *          to make this sweep skip everything). This module judges
 *          processed-status via its OWN `billcom_processed` column, so a
 *          Gmail-verified row is still judged and the two signals never
 *          clobber each other.
 *
 *          Staleness guard: billcom_bills_ref was frozen for 5 weeks on
 *          2026-08-13 (MAX(imported_at) = 2026-07-05). When the ref data is
 *          older than staleHours the sweep returns refStale: true and an
 *          EMPTY unconfirmed list — flagging against stale data would produce
 *          a wall of false positives.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    better-sqlite3 via @/lib/storage/local-db (getLocalDb)
 */

import { getLocalDb } from "@/lib/storage/local-db";
import {
  deriveCanonicalVendorName,
  extractInvoiceNumber,
} from "@/lib/intelligence/ap/vendor-invoice-patterns";

// ─── Public contract ─────────────────────────────────────────────────────────

export interface ForwardVerificationRow {
  id: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  pdfFilename: string;
  emailSubject: string;
  forwardedAt: string;
  ageHours: number;
  matchReason: string | null; // how it matched, when verified
}

export interface VerificationSweepResult {
  checked: number;
  verified: number; // newly confirmed present in Bill.com
  alreadyVerified: number;
  unconfirmed: ForwardVerificationRow[]; // forwarded, NOT in Bill.com, past grace
  /**
   * Rows we cannot honestly adjudicate, and therefore MUST NOT alert on:
   *  - forwarded before the reference export's coverage window starts, or
   *  - no vendor/invoice identity recoverable from OCR, From, or Subject.
   * Counted for observability; never treated as a missing bill. Bill.com CSV
   * exports are a filtered view, so "absent from ref" ≠ "absent from Bill.com".
   */
  unadjudicable: number;
  /** Rows already marked billcom_processed=1 (skipped; Gmail verified is NOT this). */
  alreadyProcessed: number;
  refStale: boolean; // billcom_bills_ref older than staleHours
  refAgeHours: number | null;
  /** Oldest invoice_date present in billcom_bills_ref — the coverage floor. */
  refCoverageStart: string | null;
}

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * Minimum reference rows a vendor needs before absence means anything.
 *
 * WHY (2026-08-13): billcom_bills_ref is assembled from whatever CSV exports
 * exist, and most of Bill's manual exports are FILTERED to a single vendor
 * (13 of 17 in ~/Downloads). A vendor represented by a handful of rows from an
 * old full export is effectively uncovered: any invoice it sent since then is
 * guaranteed absent from the reference, so "absent" proves nothing and an alert
 * is a false positive. Bill's own domain knowledge caught this — Uline, Abel's,
 * CR Minerals, Evergreen and Logan Labs "are always smooth", and indeed each
 * had only 2–7 reference rows versus 100 for AAA Cooper.
 */
const MIN_VENDOR_REF_ROWS = 10;

const TAKEN_STATUS_LIST = ["FORWARDED", "CLAIMED", "PENDING_SEND"] as const;
const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_LOOKBACK_DAYS = 45;
const DEFAULT_STALE_HOURS = 36;
/**
 * Upper age bound for ALERTING (not for verifying).
 *
 * The Bill.com export is a working view: once a bill is paid it ages off the
 * report entirely (measured: 31 paid AAA Cooper bills totalling $19,228.45
 * dropped off between April and June 2026). For an old forward, "absent from
 * the reference" is therefore ambiguous — paid-and-aged-off is indistinguishable
 * from never-arrived, and alerting on it is guaranteed noise. Verification still
 * runs across the whole lookback; only the ALERT list is capped.
 */
const DEFAULT_MAX_ALERT_AGE_HOURS = 168; // 7 days
const AMOUNT_TOLERANCE = 0.02; // absolute dollars, not percent
const DATE_WINDOW_DAYS = 14;

interface ForwardRow {
  id: number;
  email_from: string | null;
  email_subject: string | null;
  pdf_filename: string;
  forwarded_at: string;
  ocr_vendor_name: string | null;
  ocr_invoice_number: string | null;
  ocr_total: string | null;
  verified: number;
  billcom_processed: number;
}

interface RefBillRow {
  invoice_number: string;
  vendor_name: string;
  invoice_amount: number | null;
  invoice_date: string | null;
}

type MatchReason = "exact" | "normalized-invoice" | "invoice-only" | "amount-date";

/** "2026-08-13 14:07:18" / ISO → Date (SQLite datetimes are UTC). */
function parseSqliteDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  const iso = /(Z|[+-]\d{2}:\d{2})$/.test(t) ? t : `${t}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** billcom_bills_ref.invoice_date is "MM/DD/YYYY"; also tolerates ISO. */
function parseRefInvoiceDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseSqliteDate(s);
}

/** "$3,283.53" | "328.38" | 3283.53 → number, or null when absent/unparseable. */
function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Strip non-digits then leading zeros: "0064058411" → "64058411". */
function normalizeInvoice(s: string): string {
  return s.replace(/\D/g, "").replace(/^0+/, "");
}

function invoicesLooselyEqual(a: string, b: string): boolean {
  const da = normalizeInvoice(a);
  const db = normalizeInvoice(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  if (short.length < 6) return false;
  return long.startsWith(short) || long.endsWith(short);
}

/**
 * Canonicalize a vendor name for comparison across Bill.com and Aria.
 *
 * The two systems spell the same vendor differently — Bill.com exports
 * "Logan Labs, LLC" / "Grassroots Fabric Pots" / "CR Minerals" while Aria
 * records "LOGAN LABS LLC" / "Grassroots Fabric Pots Inc." / "CR Mineral
 * Company, LLC". Case, punctuation, and corporate suffixes are therefore
 * stripped so a real match is not lost to cosmetic spelling.
 *
 * @param s - raw vendor name from either side
 * @returns lowercase alphanumeric core with suffixes removed
 */
function normalizeVendor(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|l\.l\.c|ltd|co|corp|company|incorporated)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function hoursBetween(a: Date, b: Date | null): number {
  if (!b) return Number.POSITIVE_INFINITY;
  return (a.getTime() - b.getTime()) / 3_600_000;
}

/**
 * OCR vendor-name values that are noise, not vendors. AAA Cooper's freight PDFs
 * have written "==Start of OCR for page 1==", "Unknown Vendor", and the BILL-TO
 * / CONSIGNEE party ("BUILDASOIL", "CONSIGNEE", "MOONLIGHT GARDEN SUPPLY" —
 * the delivery destination, not the biller) into ocr_vendor_name. Treating any
 * of these as the vendor makes an exact-match IMPOSSIBLE and manufactures a
 * false "never landed in Bill.com" alert, so they are discarded in favour of
 * the sender-derived canonical name.
 */
const JUNK_VENDOR_PATTERNS: RegExp[] = [
  /^={2,}/, // "==Start of OCR for page 1=="
  /start of ocr/i,
  /^unknown vendor$/i,
  /^unknown$/i,
  /^n\/?a$/i,
  /^consignee$/i,
  /^shipper$/i,
  /^bill\s*to$/i,
  /^buildasoil/i, // we are the bill-TO party, never the vendor
  /^build\s*a\s*soil/i,
];

/** True when an OCR vendor string is noise and must not be used for matching. */
function isJunkVendorName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return true;
  return JUNK_VENDOR_PATTERNS.some((re) => re.test(t));
}

/**
 * Best-effort vendor + invoice# for a forward row.
 *
 * 191 of 274 historical FORWARDED rows predate OCR-metadata capture and have
 * NULL ocr_vendor_name/ocr_invoice_number. Their identity is still recoverable
 * from the Gmail From/Subject headers via the WS-C declarative pattern table
 * (e.g. "Invoice Stmt - Cust 0001159492 Pro#: 64058415" → 64058415, AAA Cooper
 * Transportation). Recovering it here turns unverifiable rows into genuinely
 * adjudicable ones instead of false "never landed" alerts.
 *
 * Precedence is deliberate: the sender-derived canonical vendor OUTRANKS
 * ocr_vendor_name, because the From header cannot be misread while freight-PDF
 * OCR routinely lifts the consignee or a page marker instead of the biller.
 *
 * @param fwd - the forward row
 * @returns vendor/invoice, each null when not recoverable from any source
 */
function resolveForwardIdentity(fwd: ForwardRow): {
  vendor: string | null;
  invoice: string | null;
} {
  const from = fwd.email_from ?? "";
  const subject = fwd.email_subject ?? "";

  // Sender-derived canonical name first — it is the most reliable signal.
  let vendor = from ? (deriveCanonicalVendorName(from) ?? "").trim() : "";
  if (!vendor) {
    const ocrVendor = (fwd.ocr_vendor_name ?? "").trim();
    if (ocrVendor && !isJunkVendorName(ocrVendor)) vendor = ocrVendor;
  }

  let invoice = (fwd.ocr_invoice_number ?? "").trim();
  // OCR invoice numbers for LTL freight are frequently garbage (AAA Cooper has
  // yielded the account number "3746570" and raw "==Start of OCR..." markers).
  // A subject-derived number is strictly more trustworthy when available.
  const fromSubject = from || subject ? extractInvoiceNumber(from, subject) : undefined;
  if (fromSubject) invoice = fromSubject.trim();
  // A comma-joined list ("64058414, 64058417, ...") is a bundle artefact, not
  // one invoice number; it can never equal a single ref invoice_number.
  if (invoice.includes(",")) invoice = "";

  return { vendor: vendor || null, invoice: invoice || null };
}

/**
 * Match one forwarded row against the reference bills, rules in order:
 *   1. exact       — LOWER(vendor_name) equal AND invoice_number equal
 *   2. normalized  — vendor equal AND invoice# equal after stripping
 *                    non-digits + leading zeros (01159492 vs 1159492)
 *   3. invoice-only— normalized invoice# equal with NO vendor on the forward
 *                    side. Freight Pro#s are long (>= 6 digits) and globally
 *                    unique, so this cannot collide across vendors; it rescues
 *                    pre-metadata rows whose vendor never got recorded.
 *   4. amount-date — invoice# absent on BOTH sides: ocr_total within $0.02
 *                    AND invoice date within ±14 days (forward's date is
 *                    approximated by forwarded_at — the only date a forward
 *                    row carries). Vendor must still match: amount+date alone
 *                    is not enough to attribute a bill to a vendor.
 * Returns the winning rule, or null when nothing matches.
 */
function matchForwardToRef(fwd: ForwardRow, refs: RefBillRow[]): MatchReason | null {
  const identity = resolveForwardIdentity(fwd);
  const fwdVendor = identity.vendor ? normalizeVendor(identity.vendor) : "";
  const fwdInvoice = identity.invoice ?? "";
  const fwdTotal = parseAmount(fwd.ocr_total);
  const fwdDate = parseSqliteDate(fwd.forwarded_at);
  const normFwd = fwdInvoice ? normalizeInvoice(fwdInvoice) : "";

  for (const ref of refs) {
    const refVendor = ref.vendor_name ? normalizeVendor(ref.vendor_name) : "";
    const refInvoice = (ref.invoice_number ?? "").trim();

    // Rule 1: exact vendor + invoice#
    if (
      fwdVendor &&
      refVendor &&
      fwdVendor === refVendor &&
      fwdInvoice &&
      fwdInvoice === refInvoice
    ) {
      return "exact";
    }

    // Rule 2: normalized invoice# (leading zeros / padding differences)
    if (fwdVendor && refVendor && fwdVendor === refVendor && fwdInvoice && refInvoice) {
      if (normFwd && invoicesLooselyEqual(fwdInvoice, refInvoice)) {
        return "normalized-invoice";
      }
    }

    // Rule 3: invoice#-only, for rows with no recoverable vendor. Requires a
    // long identifier so short human invoice numbers ("1234") can't collide.
    if (!fwdVendor && normFwd.length >= 6 && refInvoice) {
      if (invoicesLooselyEqual(fwdInvoice, refInvoice)) {
        return "invoice-only";
      }
    }

    // Rule 4: amount+date fallback — invoice# absent on both sides
    if (!fwdInvoice && !refInvoice && fwdVendor && refVendor && fwdVendor === refVendor) {
      const refAmount = parseAmount(ref.invoice_amount);
      if (fwdTotal !== null && refAmount !== null && Math.abs(fwdTotal - refAmount) <= AMOUNT_TOLERANCE) {
        const refDate = parseRefInvoiceDate(ref.invoice_date);
        if (
          fwdDate &&
          refDate &&
          Math.abs(fwdDate.getTime() - refDate.getTime()) <= DATE_WINDOW_DAYS * 86_400_000
        ) {
          return "amount-date";
        }
      }
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Reconcile forwarded invoices against billcom_bills_ref.
 *
 * Scans ap_local_forwards rows in taken statuses (FORWARDED/CLAIMED/
 * PENDING_SEND) within `lookbackDays`, verifies them against the reference
 * bills, writes `verified = 1` on matches (activating the dead column), and
 * returns the forwards that never landed and are past `graceHours`.
 *
 * When billcom_bills_ref is empty or its newest import is older than
 * `staleHours`, returns refStale: true and an EMPTY unconfirmed list — the
 * reference data cannot be trusted, so nothing is verified or flagged.
 *
 * Never throws: any DB failure returns a zeroed result (the forward path
 * must keep working regardless of this module).
 *
 * @param opts.graceHours   don't flag forwards younger than this (default 24)
 * @param opts.lookbackDays only scan forwards this old or newer (default 45)
 * @param opts.staleHours   ref data older than this is untrustworthy (default 36)
 * @returns the sweep result (see VerificationSweepResult)
 */
export function runForwardVerificationSweep(opts?: {
  graceHours?: number;
  lookbackDays?: number;
  staleHours?: number;
  maxAlertAgeHours?: number;
}): VerificationSweepResult {
  const graceHours = opts?.graceHours ?? DEFAULT_GRACE_HOURS;
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const staleHours = opts?.staleHours ?? DEFAULT_STALE_HOURS;
  const maxAlertAgeHours = opts?.maxAlertAgeHours ?? DEFAULT_MAX_ALERT_AGE_HOURS;

  const zeroed: VerificationSweepResult = {
    checked: 0,
    verified: 0,
    alreadyVerified: 0,
    unconfirmed: [],
    unadjudicable: 0,
    alreadyProcessed: 0,
    refStale: false,
    refAgeHours: null,
    refCoverageStart: null,
  };

  try {
    const db = getLocalDb();

    // ── Staleness guard: read-only against billcom_bills_ref ──────────────
    const maxRow = db
      .prepare("SELECT MAX(imported_at) AS m FROM billcom_bills_ref")
      .get() as { m: string | null };
    if (!maxRow.m) {
      return { ...zeroed, refStale: true, refAgeHours: null };
    }
    const refAgeHours = hoursBetween(new Date(), parseSqliteDate(maxRow.m));
    if (refAgeHours > staleHours) {
      return { ...zeroed, refStale: true, refAgeHours };
    }

    // ── Data-currency guard (2026-09-02) ─────────────────────────────────
    // MAX(imported_at) is fooled when a stale or single-vendor CSV is
    // re-imported: it bumps imported_at without refreshing coverage. That is
    // exactly what happened — a single-vendor Gro-Kashi export kept
    // imported_at fresh while Bill.com data stayed frozen at 2026-08-13.
    // The newest bill's invoice_date is the real currency signal. A fixed
    // 10-day window (not `staleHours`) is deliberate: invoice dates lag a
    // few days by nature, a weekly export always clears 10 days, and a
    // frozen reference trips it.
    const DATA_CURRENCY_STALE_HOURS = 240; // 10 days
    const newestInvoice = db
      .prepare(
        "SELECT MAX(invoice_date) AS m FROM billcom_bills_ref WHERE invoice_date IS NOT NULL AND invoice_date != ''",
      )
      .get() as { m: string | null };
    if (newestInvoice.m) {
      const dataAgeHours = hoursBetween(new Date(), parseRefInvoiceDate(newestInvoice.m));
      if (dataAgeHours > DATA_CURRENCY_STALE_HOURS) {
        return { ...zeroed, refStale: true, refAgeHours: dataAgeHours };
      }
    }

    const refs = db
      .prepare(
        "SELECT invoice_number, vendor_name, invoice_amount, invoice_date FROM billcom_bills_ref",
      )
      .all() as RefBillRow[];

    // ── Coverage floor ────────────────────────────────────────────────────
    // The Bill.com CSV export is a FILTERED view (observed: 195 rows reaching
    // back only to 05/21/2026), not the complete ledger. A forward older than
    // the export's earliest bill therefore cannot be found in the reference
    // even when Bill.com holds it — flagging those would be pure noise.
    let coverageStart: Date | null = null;
    for (const ref of refs) {
      const d = parseRefInvoiceDate(ref.invoice_date);
      if (d && (coverageStart === null || d.getTime() < coverageStart.getTime())) {
        coverageStart = d;
      }
    }
    const refCoverageStart = coverageStart ? coverageStart.toISOString().slice(0, 10) : null;

    // ── Per-vendor coverage census ────────────────────────────────────────
    // Absence only carries information for vendors the reference actually
    // covers. Count rows per normalized vendor so a thinly-covered vendor is
    // never alerted on.
    const vendorRefCounts = new Map<string, number>();
    for (const ref of refs) {
      if (!ref.vendor_name) continue;
      const key = normalizeVendor(ref.vendor_name);
      if (!key) continue;
      vendorRefCounts.set(key, (vendorRefCounts.get(key) ?? 0) + 1);
    }

    const rows = db
      .prepare(
        `SELECT id, email_from, email_subject, pdf_filename, forwarded_at,
                ocr_vendor_name, ocr_invoice_number, ocr_total, verified, billcom_processed
         FROM ap_local_forwards
         WHERE status IN (${TAKEN_STATUS_LIST.map(() => "?").join(",")})
           AND forwarded_at >= datetime('now', ?)
         ORDER BY forwarded_at DESC`,
      )
      .all(...TAKEN_STATUS_LIST, `-${lookbackDays} days`) as ForwardRow[];

    let alreadyProcessed = 0;
    const candidates: ForwardRow[] = [];
    for (const row of rows) {
      if (Number(row.billcom_processed) === 1) {
        alreadyProcessed += 1;
      } else {
        candidates.push(row);
      }
    }

    let verified = 0;
    let unadjudicable = 0;
    const unconfirmed: ForwardVerificationRow[] = [];
    const markProcessed = db.prepare("UPDATE ap_local_forwards SET billcom_processed = 1 WHERE id = ?");

    for (const row of candidates) {
      const reason = matchForwardToRef(row, refs);
      if (reason !== null) {
        markProcessed.run(row.id);
        verified += 1;
        continue;
      }

      const ageHours = hoursBetween(new Date(), parseSqliteDate(row.forwarded_at));
      if (ageHours <= graceHours) continue;

      // Older than the alert horizon → paid-and-aged-off is indistinguishable
      // from never-arrived in a filtered export. Count, never alert.
      if (ageHours > maxAlertAgeHours) {
        unadjudicable += 1;
        continue;
      }

      // Outside the reference export's coverage window → cannot adjudicate.
      // A DATE_WINDOW_DAYS margin is applied so a forward sitting near the
      // boundary is still judged: the export's earliest invoice_date is a
      // proxy for its era, not an exact cutoff, and over-suppressing here
      // would silently hide real misses.
      const fwdDate = parseSqliteDate(row.forwarded_at);
      if (
        coverageStart &&
        fwdDate &&
        fwdDate.getTime() < coverageStart.getTime() - DATE_WINDOW_DAYS * 86_400_000
      ) {
        unadjudicable += 1;
        continue;
      }

      // No vendor AND no invoice# recoverable from OCR, From, or Subject →
      // there is no key to match on; absence of a match proves nothing.
      const identity = resolveForwardIdentity(row);
      if (!identity.vendor && !identity.invoice) {
        unadjudicable += 1;
        continue;
      }

      // Vendor too thinly represented in the reference to conclude anything.
      // Without this, a filtered single-vendor export turns every OTHER vendor
      // into a confident false "never landed in Bill.com" alert.
      //
      // A row with NO resolvable vendor is treated the same way: coverage
      // cannot be checked, so absence cannot be interpreted. Alerting on an
      // invoice#-only row would reintroduce exactly the false positives Bill
      // caught (Logan Labs / Uline / Evergreen arrive from generic senders —
      // quickbooks@notification.intuit.com, accounts.receivable@uline.com —
      // that the vendor-pattern table does not map to a canonical name).
      if (!identity.vendor) {
        unadjudicable += 1;
        continue;
      }
      const refRows = vendorRefCounts.get(normalizeVendor(identity.vendor)) ?? 0;
      if (refRows < MIN_VENDOR_REF_ROWS) {
        unadjudicable += 1;
        continue;
      }

      unconfirmed.push({
        id: row.id,
        vendorName: identity.vendor,
        invoiceNumber: identity.invoice,
        pdfFilename: row.pdf_filename,
        emailSubject: row.email_subject ?? "",
        forwardedAt: row.forwarded_at,
        ageHours,
        matchReason: null,
      });
    }

    // Oldest / most overdue first — the worst offenders lead the alert.
    unconfirmed.sort((a, b) => b.ageHours - a.ageHours);

    return {
      checked: candidates.length,
      verified,
      alreadyVerified: alreadyProcessed,
      alreadyProcessed,
      unconfirmed,
      unadjudicable,
      refStale: false,
      refAgeHours,
      refCoverageStart,
    };
  } catch (err) {
    console.error("[billcom-verify] sweep failed:", err);
    return zeroed;
  }
}
