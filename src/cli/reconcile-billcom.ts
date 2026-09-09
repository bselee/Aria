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
 *       # imports ~/Downloads newest multi-vendor AllBillsPage*.csv if fresh,
 *       # then sweeps last 14 days
 *   npx tsx --env-file=.env.local src/cli/reconcile-billcom.ts --csv="C:/path/AllBillsPage (4).csv"
 *       # explicit export (always pass when Bill just downloaded)
 *   npx tsx --env-file=.env.local src/cli/reconcile-billcom.ts --days=30
 *       # widen sweep window
 *
 * Exit code: 0 = nothing missing; 1 = items missing/needing review (or error).
 */

import { getLocalDb } from "@/lib/storage/local-db";
import { importCsvFile, parseCSV, type ParsedRow } from "./import-billcom-ref";
import fs from "fs";
import os from "os";
import path from "path";

interface RefRow {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_amount: number | null;
  invoice_date: string | null;
  due_date: string | null;
  po_number: string | null;
  created_at: string | null;
}

interface ForwardRow {
  id: number;
  forwarded_at: string;
  email_from: string | null;
  email_subject: string | null;
  pdf_filename: string | null;
  ocr_vendor_name: string | null;
  ocr_invoice_number: string | null;
  ocr_total: string | null;
  ocr_raw_text: string | null;
  verified: number;
  billcom_processed: number;
  vendor_routing_action: string | null;
}

interface Verdict {
  forwarded_at: string;
  email_from: string | null;
  email_subject: string | null;
  pdf_filename: string | null;
  vendor: string;
  invoice: string;
  amount: string | null;
  kind: "MISSING" | "NEEDS_REVIEW" | "NO_IDENTITY" | "OCR_SUSPECT";
  detail: string;
}

/** Bill-data assurance findings (amount parity / date sanity / invoice# uniqueness). */
interface BillIssue {
  vendor: string;
  invoice: string;
  amount: string | null;
  kind: "AMOUNT_MISMATCH" | "DUP_INVOICE_NUMBER" | "NONUNIQUE_INVOICE_NUMBER" | "DATE_ISSUE" | "TERMS_OUTLIER";
  detail: string;
}

// ── Normalization ────────────────────────────────────────────────────────────

const STOP_WORDS =
  /\b(inc|llc|l\.l\.c|ltd|co|corp|company|corporation|incorporated|the|usa|us|llc,|group|supply)\b/gi;

function normVendor(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(STOP_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normInvoice(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "").replace(/^0+/, "");
}

/** Loose vendor compare: containment OR shared meaningful token OR alias map. */
const VENDOR_ALIASES: Array<string[]> = [
  ["fedex", "federalexpress"],
  ["aaacooper", "aaacoopertransportation", "aaacoopertransportation", "aaa cooper", "aaa cooper transportation"],
  ["autopot", "autopotwateringsystems"],
  ["loganlabs", "loganlabs"],
  ["evergreen", "evergreengrowerssupply"],
  ["marionag", "marionagservice"],
  ["miles", "milesfilippelli"],
  ["destination", "destinationtransport"],
  ["grassroots", "grassrootsfabricpots"],
  ["fertiorganic", "ferti"],
  ["crminerals", "crminerals"],
  ["thriveprobiotics", "thrive"],
  ["beltpower", "beltpowerllc"],
  ["aloecorp", "aloe"],
  ["organicag", "organicagproducts"],
  ["coloradowormcompany", "coloradoworm"],
  ["bennymartinez", "bennymartineztrucking"],
  ["noveltymanufacturing", "noveltymanufacturingcompany"],
  ["rootwise", "rootwisesoildynamics"],
  ["clarkemosquito", "clarkeenvironmental"],
  ["tealab", "tealab"],
  ["spectrumanalytic", "spectrumanalyticinc"],
  ["uline", "uline"],
  ["blackburn", "blackburnpropane"],
  ["wagner", "wagnerequipment"],
  ["wwex", "worldwideexpress"],
  ["loganlabsllc", "loganlabsllc"],
];

function vendorsMatch(a: string, b: string): boolean {
  const na = normVendor(a);
  const nb = normVendor(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 4));
  if ([...ta].some((t) => tb.has(t))) return true;
  for (const group of VENDOR_ALIASES) {
    if (group.some((g) => na.includes(g)) && group.some((g) => nb.includes(g))) return true;
  }
  return false;
}

/** Digits-only compare; shorter ≥6-digit core may prefix/suffix longer. */
function invoicesMatch(a: string, b: string): boolean {
  const da = normInvoice(a);
  const db = normInvoice(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 6 && (long.startsWith(short) || long.endsWith(short));
}

// ── Identity derivation from a forward row ──────────────────────────────────

function parseSender(from: string | null): { display: string; addr: string; domain: string } {
  const cleaned = (from || "").replace(/^["']|["']$/g, "");
  const angle = cleaned.match(/^([^<]*)<([^>]+)>$/);
  if (angle) {
    const addr = angle[2].trim();
    const domain = addr.includes("@") ? addr.split("@")[1].replace(/^www\./, "") : "";
    return { display: angle[1].trim(), addr, domain };
  }
  const bare = cleaned.includes("@") ? cleaned.trim() : "";
  const domain = bare.includes("@") ? bare.split("@")[1].replace(/^www\./, "") : "";
  return { display: "", addr: bare, domain };
}

/** Haystack of vendor evidence: OCR vendor, display name, domain root, subject. */
function vendorHaystack(fwd: ForwardRow): string {
  const { display, domain } = parseSender(fwd.email_from);
  const parts: string[] = [];
  if (fwd.ocr_vendor_name && !/unknown/i.test(fwd.ocr_vendor_name)) parts.push(fwd.ocr_vendor_name);
  if (display) parts.push(display);
  if (domain) parts.push(domain.replace(/\..*$/, "")); // ferti-organic.com → ferti-organic
  if (fwd.email_subject) parts.push(fwd.email_subject);
  return parts.join(" | ");
}

function deriveInvoice(fwd: ForwardRow): string {
  const hay = [
    fwd.ocr_invoice_number,
    fwd.pdf_filename,
    fwd.email_subject,
    fwd.email_from,
  ]
    .filter(Boolean)
    .join(" | ");

  // 0. Subject Pro# FIRST — authoritative for AAA Cooper scans where OCR of the
  //    PDF grabs the ACCOUNT# (3746570) instead of the Pro# in the subject.
  //    (2026-09-08: 4 AAA rows false-MISSING because ocr beat the subject Pro#.)
  const proSubj = (fwd.email_subject || "").match(/\bPro#?:?\s*(\d{6,10})\b/i);
  if (proSubj) return proSubj[1];

  // 1. OCR invoice number second (comma-form ok)
  const ocr = (fwd.ocr_invoice_number || "").trim().replace(/,/g, "");
  if (ocr && /[A-Za-z0-9]{4,}/.test(ocr) && !/^unknown$/i.test(ocr)) return ocr;

  // 2. FedEx billing: 9-454-04878 (underscore/dash tolerant boundaries)
  const fedex = hay.match(/(?<![A-Za-z0-9])\d-\d{3}-\d{5}(?![A-Za-z0-9])/);
  if (fedex) return fedex[0];

  // 3. "Invoice 135879" / Inv# / Inv_135879 / Facture — capture must start with a digit
  const kw = hay.match(/\b(?:invoice|inv|facture|n[ºo])\s*[:#._-]*\s*(\d[A-Za-z0-9-]{2,})/i);
  if (kw) return kw[1];

  // 4. APUS-247215 / INV12928 style alphanumeric ID
  const alpha = hay.match(/(?<![A-Za-z0-9])[A-Z]{2,6}[-_]?\d{4,8}(?![A-Za-z0-9])/i);
  if (alpha) return alpha[0];

  // 5. Bare long digit run (destination 9476798, novelty 41131586)
  const bare = hay.match(/(?<![A-Za-z0-9])\d{5,10}(?![A-Za-z0-9])/);
  if (bare) return bare[0];

  // 6. Filename digit-strip (BAS invoice 8.27.2026.pdf → 8272026 matches
  //    Bill.com "8,272,026"). Guarded to 5-12 digits; used as a second
  //    candidate by the matcher loop, not a primary invoice claim.
  const filenameDigits = (fwd.pdf_filename || "").replace(/\D/g, "");
  if (/^\d{5,12}$/.test(filenameDigits)) return filenameDigits;

  return "";
}

// ── Bill-data assurance checks (amount parity / dates / invoice# uniqueness) ──

/** Parse a dollar string ("1,234.56", "$1,234.56", "1234.5") to cents-safe number. */
function parseDollars(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[$£€,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Days between two ISO dates (b - a); null when either is missing/invalid. */
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
              vendor_routing_action
       FROM ap_local_forwards
       WHERE status='FORWARDED' AND forwarded_at >= ?
       ORDER BY forwarded_at DESC`,
    )
    .all(lookback) as ForwardRow[];

  const refRows = ref; // full loose match over rows (prefix/suffix invoice compare)

  const verdicts: Verdict[] = [];
  const billIssues: BillIssue[] = [];
  let matched = 0;
  let paidOnlineCount = 0;
  const terms = vendorTermMedian(ref);

  for (const f of fwds) {
    const hay = vendorHaystack(f);
    const invoice = deriveInvoice(f);
    const displayVendor = parseSender(f.email_from).display || f.ocr_vendor_name || f.email_from || "";

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
        const fwdAmt = parseDollars(f.ocr_total);
        const rederived = rederiveFinalTotal(f.ocr_raw_text);
        if (fwdAmt !== null && rederived !== null) {
          const agree = Math.abs(fwdAmt - rederived) <= Math.max(0.05, fwdAmt * 0.005);
          const billAmt = hitRow.invoice_amount;
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
    const noBillClass = /acknowledgment_/i.test(filename)
      || /us payment information/i.test(filename)
      || /correspondence_/i.test(filename)
      || /collectiontoolbox/i.test(`${displayVendor} ${hay}`)
      || (/berger/i.test(`${displayVendor} ${hay}`) && /image00/i.test(filename));
    if (paidOnline || wagnerCc || noBillClass) {
      paidOnlineCount++;
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
    let freshRows: ParsedRow[] = [];
    try {
      freshRows = parseCSV(csvPath);
    } catch { /* import already logged the failure */ }

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
  }

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
  console.log(`[reconcile-billcom] Action needed: ${verdicts.length} (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
  if (billIssues.length > 0) {
    const ikinds = billIssues.reduce<Record<string, number>>((acc, x) => {
      acc[x.kind] = (acc[x.kind] || 0) + 1;
      return acc;
    }, {});
    console.log(`[reconcile-billcom] Bill-data issues: ${billIssues.length} (${Object.entries(ikinds).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  }

  if (verdicts.length === 0 && billIssues.length === 0) {
    console.log("\n✓ Nothing missing, needing review, or miskeyed.");
    process.exit(0);
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

  process.exit(1);
}

main().catch((e) => {
  console.error("[reconcile-billcom] FATAL:", e);
  process.exit(1);
});
