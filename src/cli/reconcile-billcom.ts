/**
 * @file    src/cli/reconcile-billcom.ts
 * @purpose One-command Bill.com completeness + data-quality check: import the
 *          fresh All Bills CSV export into billcom_bills_ref, then sweep the
 *          last N days of ap_local_forwards (FORWARDED) against it. Prints ONLY
 *          items that are missing from Bill.com or need manual review — matched
 *          bills are silent (Bill: "only show any that are missing or need
 *          review"). Since 2026-09-08 also checks BILL DATA on the fresh export:
 *          amount parity (forwarded total vs entered amount, exact # match
 *          only), date sanity (due < invoice, terms drift vs vendor median),
 *          and invoice# uniqueness (dup entries; account#-as-invoice#
 *          patterns). These read-only checks never touch forwarding.
 *
 *          Bill manually enters bills in Bill.com; Aria forwards source PDFs to
 *          buildasoilap@bill.com. This CLI is a manual-entry completeness check
 *          (did everything Aria forwarded get entered?), NOT a "did Bill.com
 *          auto-process" check — there is no Bill.com API.
 *
 * @author  Hermia
 * @created 2026-09-08
 * @deps    better-sqlite3 (local-db), importCsvFile (import-billcom-ref)
 *
 * Usage:
 *   npx tsx --env-file=.env.local src/cli/reconcile-billcom.ts
 *       # imports the newest AllBillsPage*.csv under 10 days (weekly export),
 *       # then sweeps last 14 days. No Bill.com login.
 *   npx tsx --env-file=.env.local src/cli/reconcile-billcom.ts --csv="C:/path/AllBillsPage (4).csv"
 *       # explicit export (always pass when Bill just downloaded)
 *   npx tsx --env-file=.env.local src/cli/reconcile-billcom.ts --days=30
 *       # widen sweep window
 *   --no-reverse       skip direction 2 (every bill on the page -> AP record?)
 *   --no-close-stuck   report the stuck-row heal without applying it
 *
 * Direction 2 (2026-10-07) also closes ledger rows whose invoice is now a bill in
 * Bill.com, which is what stops the 2-hourly FORWARDING_ESCALATED ping on rows
 * nobody can otherwise close. See src/lib/purchasing/billcom-ap-audit.ts.
 *
 * Exit code: 0 = nothing missing, needing review, or miskeyed; 1 = something does
 * (or the run errored). By-design "no AP record" classes do NOT set the code.
 */

import { getLocalDb } from "@/lib/storage/local-db";
import { createClient } from "@/lib/db";
import { importCsvFile, parseCSV, type ParsedRow } from "./import-billcom-ref";
import { isStatementDocument } from "@/lib/intelligence/ap-statement-gate";
import { isFedExExcludedFromBillCom } from "@/lib/intelligence/ap/fedex-billing-packet";
import { isQuoteOrSpecDocument } from "@/lib/intelligence/ap/quote-spec-gate";
import {
  classifyNoRecord,
  deriveInvoice,
  findApRecord,
  invoicesMatch,
  normInvoice,
  normVendor,
  parseDollars,
  parseSender,
  selectStuckRowsToClose,
  vendorsMatch,
  vendorHaystack,
  type AuditFacts,
  type CacheRow,
  type ForwardRow,
  type NoRecordVerdict,
  type RefRow,
  type VendorInvoiceRow,
} from "@/lib/purchasing/billcom-ap-audit";
import fs from "fs";
import os from "os";
import path from "path";

/** Statuses the escalation cron pings on until something closes the row. */
const STUCK_STATUSES = ["ERROR", "CLAIMED", "PENDING_SEND"];

interface Verdict {
  forwarded_at: string;
  email_from: string | null;
  email_subject: string | null;
  pdf_filename: string | null;
  vendor: string;
  invoice: string;
  amount: string | null;
  kind: "MISSING" | "NEEDS_REVIEW" | "NO_IDENTITY" | "OCR_SUSPECT" | "DIRECT_PAY";
  detail: string;
}

/** Bill-data assurance findings (amount parity / date sanity / invoice# uniqueness). */
interface BillIssue {
  vendor: string;
  invoice: string;
  amount: string | null;
  kind: "AMOUNT_MISMATCH" | "AMOUNT_OUTLIER" | "AMOUNT_LOW_CONFIDENCE" | "DUP_INVOICE_NUMBER" | "NEAR_DUP_INVOICE_NUMBER" | "NONUNIQUE_INVOICE_NUMBER" | "DATE_ISSUE" | "TERMS_OUTLIER";
  detail: string;
}

// ── Normalization, matching and identity helpers ─────────────────────────────
// Moved to src/lib/purchasing/billcom-ap-audit.ts (2026-10-07) so the rules live
// in one place and are unit-tested: normVendor, normInvoice, vendorsMatch,
// invoicesMatch, parseSender, vendorHaystack, deriveInvoice, parseDollars.

// ── Bill-data assurance checks (amount parity / dates / invoice# uniqueness) ──

/**
 * Days between two ISO dates (b - a); null when either is missing/invalid.
 */
function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00`);
  const tb = Date.parse(`${b}T00:00:00`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/**
 * Re-derive a FINAL total from stored OCR text using explicit final-total
 * labels (AMOUNT DUE / TOTAL THIS INVOICE / BALANCE DUE / GRAND TOTAL /
 * INVOICE TOTAL / TOTAL DUE). SUB-TOTAL and per-line totals are deliberately
 * NOT matched. Used as a second opinion: a stored ocr_total that captured a
 * SUB-TOTAL or an OCR fragment (Uline 1775 vs 1859.04, Gary Ambriole '7' vs
 * 7875) will NOT agree with this re-derivation, so the parity check only fires
 * when BOTH extractions point at the same figure. Returns null when no
 * confident final total exists.
 */
function rederiveFinalTotal(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  const labelRe = /(?<![A-Z0-9-])(?:amount\s+due|total\s+this\s+invoice|balance\s+due|grand\s+total|invoice\s+total|total\s+amount\s+due|total\s+due)\b/i;
  const amtRe = /\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2})/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!labelRe.test(line)) continue;
    if (/sub[- ]?total/i.test(line)) continue;
    const seg = lines.slice(i, Math.min(i + 3, lines.length)).join(" ");
    const m = amtRe.exec(seg);
    if (!m) continue;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0 && v < 1_000_000) return v;
  }
  return null;
}

/** Vendor typical net terms (median due-invoice days) from clean ref history. */
function vendorTermMedian(refRows: RefRow[]): Map<string, number> {
  const terms = new Map<string, number[]>();
  for (const r of refRows) {
    const d = daysBetween(r.invoice_date, r.due_date ?? null);
    if (d === null || d < 0 || d > 180) continue; // ignore impossible/legacy-poisoned rows
    const key = normVendor(r.vendor_name);
    if (!key) continue;
    const arr = terms.get(key) || [];
    arr.push(d);
    terms.set(key, arr);
  }
  const out = new Map<string, number>();
  for (const [k, arr] of terms) {
    if (arr.length < 5) continue; // too little history to trust
    arr.sort((x, y) => x - y);
    const mid = Math.floor(arr.length / 2);
    out.set(k, arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  }
  return out;
}

/**
 * Vendor typical invoice amount (median) from clean ref history. Feeds the
 * "strange or large amount" outlier check: a forward whose total is a large
 * multiple of the vendor's own median (or an absolute large bill) gets
 * flagged for a human to verify the entered amount.
 */
function vendorAmountMedian(refRows: RefRow[]): Map<string, number> {
  const amounts = new Map<string, number[]>();
  for (const r of refRows) {
    const a = r.invoice_amount;
    if (a === null || a === undefined || a <= 0 || a > 1_000_000) continue;
    const key = normVendor(r.vendor_name);
    if (!key) continue;
    const arr = amounts.get(key) || [];
    arr.push(a);
    amounts.set(key, arr);
  }
  const out = new Map<string, number>();
  for (const [k, arr] of amounts) {
    if (arr.length < 3) continue; // too little history to trust
    arr.sort((x, y) => x - y);
    const mid = Math.floor(arr.length / 2);
    out.set(k, arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  }
  return out;
}

/**
 * The gate writes `ocr-gate:<verdict>:<reason>` (see ap-single-forward.ts); the
 * weekly sweep surfaces any non-pass verdict here so a no_invoice_number or
 * customer_number flag never stays buried in a note column.
 */
function parseGateVerdict(notes: string | null): { verdict: string; reason: string } | null {
  if (!notes) return null;
  const m = notes.match(/ocr-gate:([a-z_]+):(.*?)(?=\s*(?:ocr-gate:|\||$))/i);
  if (!m) return null;
  return { verdict: m[1], reason: m[2].trim() };
}

/**
 * True when any forward for this vendor+invoice# is a credit memo (filename or
 * subject says Cr_Memo / Credit Memo / credit). Credit memos carry net-0 due
 * dates by nature — a terms-outlier flag on one is noise.
 */
function isCreditMemo(row: ParsedRow, fwds: ForwardRow[]): boolean {
  const rowVendor = normVendor(row.vendor_name);
  const rowInv = normInvoice(row.invoice_number);
  if (!rowVendor || rowInv.length < 4) return false;
  return fwds.some((f) => {
    const hay = vendorHaystack(f);
    const inv = deriveInvoice(f);
    const credit = /(?:cr[ _-]?memo|credit memo|credit note)/i.test(`${f.pdf_filename || ""} ${f.email_subject || ""}`);
    return credit && vendorsMatch(hay, row.vendor_name || "") && invoicesMatch(inv, row.invoice_number || "");
  });
}

/**
 * Sanity-check one imported bill row (this run's fresh export only — legacy
 * poisoned ref rows must never re-flag). Checks:
 *  1. due date precedes invoice date (impossible) or drifts > 45d from the
 *     vendor's own median net terms (legacy AAA rows carried garbage dates)
 *  2. invoice# not unique per vendor (AAA Cooper was entering the ACCOUNT#
 *     3746570 instead of the unique Pro# — same # on many bills = not unique)
 */
function checkBillRow(row: ParsedRow, terms: Map<string, number>, fwds: ForwardRow[]): BillIssue[] {
  const issues: BillIssue[] = [];
  const vendor = row.vendor_name || "";
  const invoice = row.invoice_number || "";
  const amount = row.invoice_amount != null ? `$${row.invoice_amount.toFixed(2)}` : null;

  // 1. Date sanity — only when BOTH dates parse; credit memos are exempt
  //    (net 0 is their normal state)
  const net = daysBetween(row.invoice_date, row.due_date);
  if (net !== null && !isCreditMemo(row, fwds)) {
    if (net < 0) {
      issues.push({
        vendor, invoice, amount, kind: "DATE_ISSUE",
        detail: `due date ${row.due_date} precedes invoice date ${row.invoice_date} (net ${net}d)`,
      });
    } else {
      const med = terms.get(normVendor(vendor));
      if (med !== undefined) {
        // Tolerance scales with the vendor's own terms: at least 21d, or 75% of
        // the median — catches "net 3 typed for net 30" without flagging
        // legitimate intra-vendor spread (DestiNation 17-30, Grassroots 24-30).
        const tol = Math.max(21, Math.round(med * 0.75));
        if (Math.abs(net - med) > tol) {
          issues.push({
            vendor, invoice, amount, kind: "TERMS_OUTLIER",
            detail: `net ${net}d vs vendor median ${med}d (±${tol}d) — due ${row.due_date} on invoice ${row.invoice_date} may be miskeyed`,
          });
        }
      }
    }
  }

  return issues;
}

function newestDownloadsCsv(): string | null {
  const dir = path.join(os.homedir(), "Downloads");
  const aria = path.join(os.homedir(), "Downloads", "Aria-Ingest", "billcom");
  const dirs = [aria, dir];
  let best: { file: string; mtime: number } | null = null;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/^AllBillsPage.*\.csv$/i.test(f)) continue;
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.mtime) best = { file: p, mtime: st.mtimeMs };
    }
  }
  if (!best) return null;
  // Fresh = younger than 10 days
  if (Date.now() - best.mtime > 10 * 24 * 3600 * 1000) return null;
  return best.file;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const csvArg = process.argv.find((a) => a.startsWith("--csv="));
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 14;
  const lookback = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  /** Direction 2 (bill -> AP record). On by default; --no-reverse disables. */
  const reverse = !process.argv.includes("--no-reverse");
  /** Close ledger rows whose bill has since appeared in Bill.com. */
  const closeStuck = !process.argv.includes("--no-close-stuck");

  const csvPath: string | null = csvArg ? csvArg.split("=")[1] : newestDownloadsCsv();

  if (csvPath) {
    const stats = fs.existsSync(csvPath) ? fs.statSync(csvPath) : null;
    if (!stats) {
      console.error(`[reconcile-billcom] CSV not found: ${csvPath}`);
      process.exit(1);
    }
    await importCsvFile(csvPath);
  } else {
    console.log("[reconcile-billcom] No --csv given and no fresh Downloads export — using existing ref table.");
  }

  const db = getLocalDb();

  const ref = db
    .prepare(
      "SELECT vendor_name, invoice_number, invoice_amount, invoice_date, due_date, po_number, created_at FROM billcom_bills_ref",
    )
    .all() as RefRow[];

  const fwds = db
    .prepare(
      `SELECT id, forwarded_at, email_from, email_subject, pdf_filename,
              ocr_vendor_name, ocr_invoice_number, ocr_total, ocr_raw_text, verified, billcom_processed,
              vendor_routing_action, reconciliation_notes
       FROM ap_local_forwards
       WHERE status='FORWARDED' AND forwarded_at >= ?
       ORDER BY forwarded_at DESC`,
    )
    .all(lookback) as ForwardRow[];

  const refRows = ref; // full loose match over rows (prefix/suffix invoice compare)

  // ── Direction 2 inputs: the page under audit + everything AP has on file ────
  // The page rows are parsed once here and reused by the bill-data checks below.
  let pageRows: ParsedRow[] = [];
  if (csvPath && fs.existsSync(csvPath)) {
    try {
      pageRows = parseCSV(csvPath);
    } catch { /* import already logged the failure */ }
  }

  // All-time forwards (any status/age): the reverse sweep needs the vendor's whole
  // forward history to tell "Aria never forwards this vendor" from "Aria tried and
  // failed", and the heal pass needs rows sitting in non-terminal statuses.
  const allForwards = db
    .prepare(
      `SELECT id, forwarded_at, status, email_from, email_subject, pdf_filename,
              ocr_vendor_name, ocr_invoice_number, ocr_total, error_message
       FROM ap_local_forwards
       ORDER BY forwarded_at DESC`,
    )
    .all() as ForwardRow[];

  const cacheRows = db
    .prepare("SELECT vendor_name, invoice_number, invoice_date, total, source FROM invoice_cache")
    .all() as CacheRow[];

  // vendor_invoices lives in PostgREST. Best effort, but say so when it is down:
  // a silently narrowed reverse sweep looks exactly like a clean one.
  const vendorInvoices: VendorInvoiceRow[] = [];
  let vendorInvoicesDown = false;
  let vendorInvoicesPartial = false;
  if (reverse) {
    try {
      const sb = createClient();
      // PostgREST caps a response at 1000 rows (db-max-rows), so a plain
      // .limit(5000) returns 1000 and any bill whose only evidence sits on page 2
      // gets reported as "no AP record". Page until a short page comes back.
      const PAGE = 1000;
      for (let page = 0; page < 10; page++) {
        const { data, error } = await sb
          .from("vendor_invoices")
          .select("vendor_name,invoice_number,invoice_date,total,created_at")
          .order("created_at", { ascending: false })
          .limit(PAGE)
          .offset(page * PAGE);
        if (error) throw new Error(JSON.stringify(error));
        const rows = (data as VendorInvoiceRow[]) || [];
        vendorInvoices.push(...rows);
        if (rows.length < PAGE) break;
        if (page === 9) vendorInvoicesPartial = true;
      }
    } catch (e) {
      vendorInvoicesDown = true;
      console.log(`[reconcile-billcom] ⚠ vendor_invoices unavailable (${(e as Error).message}) — reverse sweep ran on forwards + invoice_cache only`);
    }
    if (vendorInvoicesPartial) {
      console.log(
        `[reconcile-billcom] ⚠ vendor_invoices paged to the 10,000-row cap — older evidence not loaded, ` +
        `a "no AP record" line here may be coverage, not a gap`,
      );
    }
  }

  const verdicts: Verdict[] = [];
  /** Real payables that never become Bill.com bills (vendor collects payment). */
  const directPay: Verdict[] = [];
  const billIssues: BillIssue[] = [];
  const gateFlags: Array<{ date: string; vendor: string; invoice: string; verdict: string; reason: string }> = [];
  let matched = 0;
  let paidOnlineCount = 0;
  const terms = vendorTermMedian(ref);
  const amountMedians = vendorAmountMedian(ref);

  for (const f of fwds) {
    const hay = vendorHaystack(f);
    const invoice = deriveInvoice(f);
    const displayVendor = parseSender(f.email_from).display || f.ocr_vendor_name || f.email_from || "";

    // Surface any non-pass pre-send OCR-gate verdict on this forward.
    const gate = parseGateVerdict(f.reconciliation_notes);
    if (gate && gate.verdict !== "pass" && gate.verdict !== "skipped") {
      gateFlags.push({
        date: (f.forwarded_at || "").slice(0, 10),
        vendor: displayVendor,
        invoice: invoice || f.pdf_filename || "?",
        verdict: gate.verdict,
        reason: gate.reason,
      });
    }

    const base = {
      forwarded_at: (f.forwarded_at || "").slice(0, 10),
      email_from: f.email_from,
      email_subject: f.email_subject,
      pdf_filename: f.pdf_filename,
      vendor: displayVendor,
      invoice,
      amount: f.ocr_total,
    };

    // Row-level loose match: vendor haystack AND digits compare
    const hitRow = refRows.find((r) => vendorsMatch(hay, r.vendor_name || "") && invoicesMatch(invoice, r.invoice_number || ""));
    if (hitRow) {
      matched++;
      // Amount parity — DOUBLE-CONFIRMED forward total only. A stored
      // ocr_total may be a SUB-TOTAL or OCR fragment (Uline 1775 vs real
      // 1859.04; Gary Ambriole '7' vs real 7875), so we require the
      // label-anchored re-derivation from the raw text to agree with it. Only
      // then is a difference from Bill.com worth flagging — this never fires
      // on parser noise, only on a stable two-parse figure vs the entered bill.
      const exactInv = !!invoice && normInvoice(invoice) === normInvoice(hitRow.invoice_number || "");
      if (exactInv) {
        // A statement is not an invoice — the statement gate blocks these at
        // forward time now, but pre-gate FORWARDED rows (Berger BUIAS1.pdf,
        // "$42k statement") still surface here. Skip all amount checks on a
        // statement row: its "amount" is an account balance, not a bill.
        const isStmt = isStatementDocument(f.email_subject || "", f.pdf_filename || "", f.email_from || "");
        if (isStmt) {
          continue;
        }
        const fwdAmt = parseDollars(f.ocr_total);
        const rederived = rederiveFinalTotal(f.ocr_raw_text);
        const billAmt = hitRow.invoice_amount;
        const med = amountMedians.get(normVendor(hitRow.vendor_name || ""));

        // Tier 1 — confident + confirmed: double-extraction agreement AND the
        // entered amount disagrees → a real amount mismatch, flag it.
        if (fwdAmt !== null && rederived !== null) {
          const agree = Math.abs(fwdAmt - rederived) <= Math.max(0.05, fwdAmt * 0.005);
          if (agree && billAmt != null && Math.abs(fwdAmt - billAmt) > 0.02) {
            billIssues.push({
              vendor: displayVendor,
              invoice,
              amount: f.ocr_total,
              kind: "AMOUNT_MISMATCH",
              detail: `confirmed total $${fwdAmt.toFixed(2)} ≠ Bill.com amount $${billAmt.toFixed(2)} (bill #${hitRow.invoice_number}) — verify which is right`,
            });
          }
        }

        // Tier 2 — large/strange amount vs this vendor's own history. Fires
        // regardless of match: a bill that is 5× the vendor's median (or over
        // an absolute $25k) is worth a human glance before it gets paid.
        // Evaluate the amount that will actually be PAID first. The raw ocr_total
        // is only a proxy and can capture a line charge instead of the total
        // (AAA Cooper 64058919, 2026-10-07: ocr_total $2,545.74 = the first line
        // charge, while the PDF's AMOUNT DUE and the entered bill are $988.71 —
        // flagging 5.7× the vendor median off the OCR figure was a false positive).
        const confidentAmt = billAmt ?? rederived ?? fwdAmt ?? null;
        if (confidentAmt !== null && med !== undefined) {
          const rel = confidentAmt > med * 5;
          const abs = confidentAmt > 25_000;
          if (rel || abs) {
            billIssues.push({
              vendor: displayVendor,
              invoice,
              amount: confidentAmt.toFixed(2),
              kind: "AMOUNT_OUTLIER",
              detail: `$${confidentAmt.toFixed(2)} is ${abs ? ">$25k" : `${Math.round((confidentAmt / med) * 10) / 10}× vendor median $${med.toFixed(2)}`} — verify entered amount is not a miskey`,
            });
          }
        }

        // Tier 3 — low confidence: a single extraction exists (no re-derivation
        // to confirm it) and it is a large bill. OCR total on a big bill without
        // corroboration is the "verify entered" case Bill flagged.
        if (
          (fwdAmt !== null && rederived === null) ||
          (fwdAmt === null && rederived !== null)
        ) {
          const single = (fwdAmt ?? rederived) as number;
          if (single > 10_000) {
            billIssues.push({
              vendor: displayVendor,
              invoice,
              amount: single.toFixed(2),
              kind: "AMOUNT_LOW_CONFIDENCE",
              detail: `$${single.toFixed(2)} from a single OCR pass (no corroborating total) — verify the entered amount`,
            });
          }
        }
      }
      continue;
    }

    // PO-number match: subject "PO # 125125" ↔ billcom_bills_ref.po_number
    // (Agri-Aloe BAS_2026-07-23.pdf → bill #1000956 po 125125; landed 08-13.)
    const poInSubject = (f.email_subject || "").match(/\b(?:po|p\.o\.|purchase order)\s*#?\s*(\d{4,8})\b/i);
    if (poInSubject) {
      const poDigits = poInSubject[1].replace(/\D/g, "");
      const poHit = refRows.find(
        (r) => vendorsMatch(hay, r.vendor_name || "") && (r.po_number || "").replace(/\D/g, "") === poDigits,
      );
      if (poHit) {
        matched++;
        continue;
      }
    }

    // Known paid-online / CC-paid classes — never Bill.com bills. Bill-confirmed
    // 2026-09-08: NuMega (paid online, QuickBooks payment confirmation same day),
    // Blackburn Propane (CC), Wagner Equipment (CC receipt). These must NOT recur
    // as review noise on every run.
    const paidOnline = [
      /numega/i,
      /blackburn/i,
    ].some((re) => re.test(`${displayVendor} ${hay}`));
    const wagnerCc = /wagner/i.test(`${displayVendor} ${hay}`) && /cc receipt|S02W/i.test(`${hay} ${invoice}`);
    // Historical no-bill classes now router-skipped (pre-rule forwards only):
    // BFG order acks, Uline payment-information docs, AAA Cooper collection
    // correspondence. Router rules prevent these from forwarding today.
    const filename = f.pdf_filename || "";
    // FedEx (FBO parcel and Freight) is not a Bill.com bill (Bill 2026-09-23).
    // Historical forwards must not keep showing up as missing.
    const fedexNotABill = isFedExExcludedFromBillCom({
      from: `${f.email_from || ""} ${displayVendor || ""}`,
      subject: f.email_subject,
      filename,
      vendorName: displayVendor,
      invoiceNumber: invoice,
    });
    // Quote / spec-sheet documents (Century Equipment, 2026-09-16) are not
    // bills — they can never be entered. Router skips them at forward now.
    const quoteSpecDoc = isQuoteOrSpecDocument({
      subject: f.email_subject,
      filename,
      pdfText: f.ocr_raw_text,
    });
    const noBillClass = fedexNotABill
      || quoteSpecDoc
      || /acknowledgment_/i.test(filename)
      || /us payment information/i.test(filename)
      || /correspondence_/i.test(filename)
      || /collectiontoolbox/i.test(`${displayVendor} ${hay}`)
      || (/berger/i.test(`${displayVendor} ${hay}`) && /image00/i.test(filename));
    if (paidOnline || wagnerCc || noBillClass) {
      paidOnlineCount++;
      continue;
    }

    // Century Equipment (peter.capone@centuryeq.com): the vendor collects
    // payment directly — "I can come pick up a physical Check or I can take
    // payment over the phone" (2026-09-11 email), and the 2026-09-17 invoice
    // GJ17176-1 ($9,638.89, bucket extension + counterweights) ships only after
    // "a signed copy and payment". Zero Century bills in 1300+ Bill.com rows.
    // It is a real payable, just not a Bill.com bill — report once, never as
    // a missing Bill.com entry.
    const directPayVendor = /century\s*equipment/i.test(`${displayVendor} ${hay}`)
      || /centuryeq\.com/i.test(f.email_from || "");
    if (directPayVendor) {
      directPay.push({
        ...base,
        kind: "DIRECT_PAY",
        detail: `vendor collects payment directly (check pickup / phone) — not a Bill.com bill; confirm it got paid outside Bill.com`,
      });
      continue;
    }

    const vendorPresent = refRows.some((r) => vendorsMatch(hay, r.vendor_name || ""));
    const invoiceUsable = /[A-Za-z0-9]{4,}/.test(invoice) && !/^[A-Z]{2,6}$/.test(invoice);
    const meaningfulVendor = /[a-z]{3,}/i.test(displayVendor);

    // Truly anonymous: neither a recognizable vendor nor an invoice id
    if (!vendorPresent && !invoiceUsable && !meaningfulVendor) {
      verdicts.push({
        ...base,
        kind: "NO_IDENTITY",
        detail: `no usable vendor/invoice identity — vendor="${displayVendor || "?"}" invoice="${invoice || "?"}"`,
      });
      continue;
    }

    // Named vendor (or invoice) with no ref match — human judgment needed
    if (!vendorPresent) {
      verdicts.push({
        ...base,
        kind: "NEEDS_REVIEW",
        detail: `vendor not found in ref (${refRows.length} rows) — may be paid/aged off export, CC-paid, statement, or entered under a different vendor name`,
      });
      continue;
    }

    // Vendor present but this invoice has no bill
    if (invoiceUsable) {
      const filename = f.pdf_filename || "";
      const isScanClass = f.vendor_routing_action === "scans-watcher"
        || /image|rsimage|scan|photo/i.test(filename);
      // BAS PO-numbered thread images (image.pdf / RSImage-*.pdf) are copies of a
      // vendor invoice entered separately — review, not a hard missing bill.
      const isPoThreadImage = isScanClass && /image|rsimage/i.test(filename) && /^125\d{3,}$/.test(normInvoice(invoice));
      if (isPoThreadImage) {
        verdicts.push({
          ...base,
          kind: "OCR_SUSPECT",
          detail: `thread image for PO #${invoice} — vendor bill may be entered under its real invoice #; verify once`,
        });
      } else if (isScanClass) {
        verdicts.push({
          ...base,
          kind: "OCR_SUSPECT",
          detail: `scan/photo with vendor match but no readable invoice # — Bill.com likely OCR'd its own #; verify once against vendor statement`,
        });
      } else {
        verdicts.push({
          ...base,
          kind: "MISSING",
          detail: `vendor matches ref but invoice #${invoice} has no bill in export`,
        });
      }
    } else {
      verdicts.push({
        ...base,
        kind: "OCR_SUSPECT",
        detail: `vendor matches ref but no invoice # extractable — photo/scan/reminder; check amount $${f.ocr_total ?? "?"} against existing bills (may have landed under OCR'd #)`,
      });
    }
  }

  // ── Bill-data assurance over THIS run's fresh export (never legacy rows) ──
  // parseCSV re-reads the raw CSV so duplicate invoice# rows are visible BEFORE
  // the UNIQUE(vendor, invoice#) UPSERT collapses exact dups.
  if (csvPath && fs.existsSync(csvPath)) {
    // Same rows the reverse sweep used — parsed once, at the top of main().
    const freshRows: ParsedRow[] = pageRows;

    const seen = new Map<string, ParsedRow>(); // normVendor|RAW invoice# → first row
    for (const row of freshRows) {
      // a) Date sanity (due-vs-invoice + vendor term drift)
      for (const issue of checkBillRow(row, terms, fwds)) {
        if (!billIssues.some((x) => x.kind === issue.kind && x.vendor === issue.vendor && x.invoice === issue.invoice)) {
          billIssues.push(issue);
        }
      }

      // b) Same RAW invoice# string twice for one vendor with different
      //    amounts/dates = entered twice under the same # (dup or shared #).
      //    Identical rows = export page overlap; skip. (Normalized reuse with
      //    different raw forms is handled by (c) below.)
      const rawKey = `${normVendor(row.vendor_name)}|${(row.invoice_number || "").trim()}`;
      if ((row.invoice_number || "").trim().length >= 4) {
        const first = seen.get(rawKey);
        if (first) {
          const sameBill = first.invoice_amount === row.invoice_amount && first.invoice_date === row.invoice_date && first.due_date === row.due_date;
          if (!sameBill) {
            billIssues.push({
              vendor: row.vendor_name || "?",
              invoice: row.invoice_number || "?",
              amount: row.invoice_amount != null ? `$${row.invoice_amount.toFixed(2)}` : null,
              kind: "DUP_INVOICE_NUMBER",
              detail: `invoice# ${row.invoice_number} appears TWICE for ${row.vendor_name} (${first.invoice_amount} on ${first.invoice_date} vs ${row.invoice_amount} on ${row.invoice_date}) — duplicate entry or shared #; verify`,
            });
          }
        } else {
          seen.set(rawKey, row);
        }
      }
    }

    // c) Invoice# must be UNIQUE per vendor across this export. Same normalized
    //    # on many bills = the ACCOUNT# was captured instead of the Pro#
    //    (AAA Cooper 3746570 pattern) — the bill data is unusable for dedup.
    const byVendorInvoice = new Map<string, ParsedRow[]>();
    for (const row of freshRows) {
      const d = normInvoice(row.invoice_number);
      if (d.length < 4) continue;
      const k = `${normVendor(row.vendor_name)}|${d}`;
      const arr = byVendorInvoice.get(k) || [];
      arr.push(row);
      byVendorInvoice.set(k, arr);
    }
    for (const rows of byVendorInvoice.values()) {
      if (rows.length < 2) continue;
      const distinct = new Set(rows.map((r) => `${r.invoice_amount}|${r.invoice_date}`));
      if (distinct.size < 2) continue; // identical amounts+dates = same bill duplicated (handled above)
      for (const row of rows) {
        if (billIssues.some((x) => x.kind === "NONUNIQUE_INVOICE_NUMBER" && x.vendor === (row.vendor_name || "") && x.invoice === (row.invoice_number || ""))) continue;
        billIssues.push({
          vendor: row.vendor_name || "?",
          invoice: row.invoice_number || "?",
          amount: row.invoice_amount != null ? `$${row.invoice_amount.toFixed(2)}` : null,
          kind: "NONUNIQUE_INVOICE_NUMBER",
          detail: `invoice# ${normInvoice(row.invoice_number)} used on ${rows.length} different bills for ${row.vendor_name} — looks like an account/vendor# instead of a unique invoice#; fix in Bill.com so each bill has its own #`,
        });
      }
    }
    // d) Near-duplicate invoice# across exports: same vendor + amount + date,
    //    one number a prefix of the other. Real case: FedEx 9-444-759 vs
    //    9-444-75902 ($15,202.99, 2026-09-01) — the short number was a mistyped
    //    copy of the Ground bill and Bill renamed it on 2026-09-08. Because the
    //    rename completed before the next export, no single export ever held
    //    both, so (b)/(c) can never see this class. Compare fresh rows against
    //    the accumulated ref and say whether the twin is live or stale.
    const freshKeys = new Set(
      freshRows.map((r) => `${normVendor(r.vendor_name)}|${normInvoice(r.invoice_number)}`),
    );
    for (const row of freshRows) {
      const v = normVendor(row.vendor_name);
      const rd0 = normInvoice(row.invoice_number);
      if (!v || row.invoice_amount == null || !row.invoice_date || rd0.length < 6) continue;
      for (const cand of ref) {
        if (normVendor(cand.vendor_name) !== v) continue;
        if (cand.invoice_amount !== row.invoice_amount) continue;
        if ((cand.invoice_date || "") !== row.invoice_date) continue;
        const rd1 = normInvoice(cand.invoice_number);
        if (rd1 === rd0 || rd1.length < 6) continue;
        const [short, long] = rd0.length <= rd1.length ? [rd0, rd1] : [rd1, rd0];
        if (!long.startsWith(short)) continue;
        const twinLive = freshKeys.has(`${v}|${rd1}`);
        if (billIssues.some((x) => x.kind === "NEAR_DUP_INVOICE_NUMBER" && x.vendor === (row.vendor_name || "") && (x.invoice === (row.invoice_number || "") || x.invoice === (cand.invoice_number || "")))) continue;
        billIssues.push({
          vendor: row.vendor_name || "?",
          invoice: row.invoice_number || "?",
          amount: row.invoice_amount != null ? `$${row.invoice_amount.toFixed(2)}` : null,
          kind: "NEAR_DUP_INVOICE_NUMBER",
          detail: twinLive
            ? `invoice# ${row.invoice_number} and ${cand.invoice_number} are BOTH in this export with the same amount/date — live duplicate entry; void one before payment`
            : `invoice# ${row.invoice_number} has an older twin ${cand.invoice_number} (same amount/date, not in this export) — looks already renamed/voided in Bill.com; confirm it is gone`,
        });
      }
    }
  }

  // ── Direction 2: every bill on this page -> is there an AP record? ──────────
  // The loop above answers "did Aria's mail become a bill". This answers the other
  // half: "is every bill on this page backed by a source Aria saw" — and, when it
  // is not, which of those are this vendor's normal payment path.
  const noRecord: Array<{ row: ParsedRow; verdict: NoRecordVerdict }> = [];
  if (reverse && pageRows.length > 0) {
    const facts: AuditFacts = { forwards: allForwards, cache: cacheRows, vendorInvoices, ref: refRows };
    for (const row of pageRows) {
      if (findApRecord(row, facts).length > 0) continue;
      noRecord.push({ row, verdict: classifyNoRecord(row, facts) });
    }
  }
  const actionableNoRecord = noRecord.filter((x) => x.verdict.actionable);

  // ── Auto-heal: close ledger rows whose bill has arrived ────────────────────
  // The escalation cron pings on ERROR/CLAIMED/PENDING_SEND rows until something
  // closes them (Evergreen 150323 pinged daily for 20 days). Bill.com is the
  // source of truth: an exact vendor + invoice# match there means the row is done.
  const stuckRows = allForwards.filter((f) => !!f.status && STUCK_STATUSES.includes(f.status));
  const closeCandidates = selectStuckRowsToClose(stuckRows, refRows);
  const closedIds = new Set<number>();
  const closed: Array<{ id: number; invoice: string; vendor: string; amount: number | null }> = [];
  if (closeStuck) {
    for (const c of closeCandidates) {
      const note =
        `auto-closed ${new Date().toISOString().slice(0, 10)}: bill #${c.bill.invoice_number} ` +
        `$${c.bill.invoice_amount} present in Bill.com (AllBillsPage audit)`;
      db.prepare(
        `UPDATE ap_local_forwards
         SET status = 'SKIPPED', completed_at = datetime('now'), reconciliation_notes = ?
         WHERE id = ?`,
      ).run(note, c.id);
      closedIds.add(c.id);
      closed.push({ id: c.id, invoice: c.invoice, vendor: c.bill.vendor_name || "?", amount: c.bill.invoice_amount });
    }
  }
  const stuckRemaining = stuckRows.filter((s) => !closedIds.has(s.id));
  // BLOCKED rows are deliberate: the PDF was a payment confirmation / paid invoice.
  const stuckNeedsAttention = stuckRemaining.filter((s) => !/^BLOCKED:/i.test(String(s.error_message || "")));

  const kinds = verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v.kind] = (acc[v.kind] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n[reconcile-billcom] Forwarded (last ${days}d): ${fwds.length}`);
  console.log(`[reconcile-billcom] Ref rows: ${ref.length}`);
  console.log(`[reconcile-billcom] Matched in Bill.com: ${matched}`);
  if (paidOnlineCount > 0) {
    console.log(`[reconcile-billcom] Paid online / CC (no bill expected): ${paidOnlineCount}`);
  }
  if (directPay.length > 0) {
    console.log(`[reconcile-billcom] Direct pay (not a Bill.com bill): ${directPay.length}`);
  }
  console.log(`[reconcile-billcom] Action needed: ${verdicts.length} (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
  if (billIssues.length > 0) {
    const ikinds = billIssues.reduce<Record<string, number>>((acc, x) => {
      acc[x.kind] = (acc[x.kind] || 0) + 1;
      return acc;
    }, {});
    console.log(`[reconcile-billcom] Bill-data issues: ${billIssues.length} (${Object.entries(ikinds).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  }
  if (reverse && pageRows.length > 0) {
    console.log(
      `[reconcile-billcom] Page bills with no AP record: ${noRecord.length} of ${pageRows.length} ` +
      `(${actionableNoRecord.length} need a look${vendorInvoicesDown ? ", vendor_invoices DOWN" : ""})`,
    );
  } else if (reverse) {
    console.log("[reconcile-billcom] Reverse sweep skipped: no page (pass --csv or drop a fresh export).");
  }
  console.log(
    `[reconcile-billcom] Stuck ledger rows: ${stuckRows.length} ` +
    `(${closed.length} closed this run${closeStuck ? "" : ", heal disabled"}, ${stuckNeedsAttention.length} need attention)`,
  );

  if (
    verdicts.length === 0
    && billIssues.length === 0
    && directPay.length === 0
    && actionableNoRecord.length === 0
    && stuckNeedsAttention.length === 0
  ) {
    console.log("\n✓ Nothing missing, needing review, or miskeyed.");
    process.exit(0);
  }

  if (directPay.length > 0) {
    console.log("\n=== DIRECT PAY — real payable, paid outside Bill.com ===");
    for (const v of directPay) {
      console.log(
        `[DIRECT_PAY] ${v.forwarded_at} | ${v.vendor} | #${v.invoice} | $${v.amount ?? "?"} | ${v.pdf_filename}`,
      );
      console.log(`        ${v.detail}`);
    }
  }

  if (verdicts.length > 0) {
    console.log("\n=== NEEDS ACTION (forwards without a matching bill) ===");
    for (const v of verdicts) {
      console.log(
        `[${v.kind}] ${v.forwarded_at} | ${v.vendor} | #${v.invoice} | $${v.amount ?? "?"} | ${v.pdf_filename}`,
      );
      console.log(`        ${v.detail}`);
    }
  }

  if (billIssues.length > 0) {
    console.log("\n=== BILL DATA ISSUES (bills entered — verify amount / dates / invoice#) ===");
    for (const x of billIssues) {
      console.log(`[${x.kind}] ${x.vendor} | #${x.invoice} | ${x.amount ?? "$?"}`);
      console.log(`        ${x.detail}`);
    }
  }

  if (gateFlags.length > 0) {
    console.log("\n=== OCR-GATE FLAGS (pre-send — may have landed with wrong/none invoice#) ===");
    for (const g of gateFlags) {
      console.log(`[${g.verdict.toUpperCase()}] ${g.date} | ${g.vendor} | #${g.invoice}`);
      console.log(`        ${g.reason}`);
    }
  }

  if (noRecord.length > 0) {
    console.log("\n=== BILLS ON THIS PAGE WITH NO AP RECORD (classified) ===");
    const byClass = new Map<string, typeof noRecord>();
    for (const x of noRecord) {
      const arr = byClass.get(x.verdict.kind) || [];
      arr.push(x);
      byClass.set(x.verdict.kind, arr);
    }
    const byDesign = [...byClass.entries()].filter(([, v]) => !v[0].verdict.actionable);
    if (byDesign.length > 0) {
      const n = byDesign.reduce((acc, [, v]) => acc + v.length, 0);
      console.log(`  by design — this vendor's normal payment path, no action (${n})`);
      for (const [kind, rows] of byDesign) {
        const names = rows.slice(0, 3).map((x) => `${x.row.vendor_name} #${x.row.invoice_number}`).join(", ");
        console.log(`     ${kind} (${rows.length}): ${names}${rows.length > 3 ? `, +${rows.length - 3} more` : ""}`);
        console.log(`        ${rows[0].verdict.detail}`);
      }
    }
    if (actionableNoRecord.length > 0) {
      console.log(`\n  ACTION (${actionableNoRecord.length})`);
      for (const x of actionableNoRecord) {
        console.log(
          `     [${x.verdict.kind}] ${x.row.vendor_name} | #${x.row.invoice_number} | ` +
          `$${x.row.invoice_amount ?? "?"} | created ${x.row.created_date ?? "?"}`,
        );
        console.log(`        ${x.verdict.detail}`);
      }
    }
  }

  if (stuckRows.length > 0 || closed.length > 0) {
    console.log("\n=== STUCK LEDGER ROWS (ap_local_forwards, any age) ===");
    for (const c of closed) {
      console.log(`[CLOSED] row ${c.id} | ${c.vendor} #${c.invoice} | bill $${c.amount} is in Bill.com`);
    }
    if (!closeStuck && closeCandidates.length > 0) {
      console.log(`[WOULD CLOSE] ${closeCandidates.length} row(s) — heal disabled by --no-close-stuck`);
      for (const c of closeCandidates) {
        console.log(`     row ${c.id} | #${c.invoice} | ${c.bill.vendor_name} $${c.bill.invoice_amount}`);
      }
    }
    for (const s of stuckRemaining) {
      const blocked = /^BLOCKED:/i.test(String(s.error_message || ""));
      console.log(
        `[${blocked ? "BLOCKED ok" : "ATTENTION"}] row ${s.id} | ${s.status} | ${(s.forwarded_at || "").slice(0, 10)} | ` +
        `${s.pdf_filename} | "${(s.email_subject || "").slice(0, 55)}"`,
      );
      if (!blocked) console.log(`        ${String(s.error_message || "").slice(0, 160)}`);
    }
  }

  process.exit(1);
}

main().catch((e) => {
  console.error("[reconcile-billcom] FATAL:", e);
  process.exit(1);
});
