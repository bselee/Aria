/**
 * @file    src/lib/ap/overdue-bills.ts
 * @purpose Pure logic for the Bill.com overdue-bills PDF: parse the All Bills
 *          CSV export, age it against an as-of date, allocate the past-due
 *          stack into Friday payment runs, and render the EOW-style HTML.
 * @author  Hermia
 * @created 2026-10-26
 * @deps    none (pure — no fs, no db, no network)
 * @env     none
 *
 * Design notes:
 *  - The Bill.com export is the source of truth for balance and process date.
 *  - "Overdue" = due date strictly before the as-of date AND balance due > 0.
 *  - Runs are Friday-dated because BuildASoil releases payments on Fridays.
 *  - FedEx is flagged, never planned: per standing SOP FedEx invoices are paid
 *    through the Billtrust/COLL batch and must not be released from Bill.com.
 *  - An optional Payments Out export is netted against balances, so the report
 *    shows what is still owed after the batch that has already gone out.
 */

import type { AllocatedPayment } from "./payments-out";
import { applyPayments, billKey, parsePaymentsCsv } from "./payments-out";

// ── Types ────────────────────────────────────────────────────────────────────

/** One row of the Bill.com "All Bills" CSV export. Dates are ISO (YYYY-MM-DD). */
export interface BillRecord {
  invoiceNo: string;
  description: string;
  vendor: string;
  chartOfAccount: string;
  billType: string;
  createdDate: string;
  poNumber: string;
  invoiceDate: string;
  dueDate: string;
  paymentStatus: string;
  invoiceAmount: number;
  balanceDue: number;
  processDate: string;
  paymentMethod: string;
}

/** A bill past its due date, with the age that drives prioritisation. */
export interface OverdueBill extends BillRecord {
  daysOverdue: number;
  /** Balance before payments out were applied. */
  originalBalance: number;
  /** Amount already applied from the Payments Out export. */
  paidAmount: number;
}

/** Aging bucket label used in the summary strip. */
export type AgingBucket = "1-14" | "15-30" | "31-60" | "61-90" | "90+";

/** One Friday release of cash. */
export interface PaymentRun {
  /** ISO Friday the money leaves. */
  date: string;
  /** Short label for the band this run clears. */
  label: string;
  /** Bill-level detail for this run. */
  bills: OverdueBill[];
  /** Sum of overdue balances released in this run. */
  overdueAmount: number;
  /** Bills that come due between the previous run and this run. */
  newDueAmount: number;
}

/** Everything the renderer needs. */
export interface OverdueModel {
  asOf: string;
  source: string;
  /** Past due, excluding excluded vendors (the only number the report shows). */
  totalOverdue: number;
  /** Past due including excluded vendors, for audit only. */
  totalOverdueIncludingExcluded: number;
  overdue: OverdueBill[];
  /** Excluded rows (FedEx on CC autopay). Count and total only; not tabled. */
  excluded: OverdueBill[];
  excludedAmount: number;
  /** Excluded rows rolled up by reason, for a single summary line. */
  exclusionSummary: { reason: string; count: number; amount: number; vendors: string[] }[];
  /** Payments Out netting, present only when a payments export was supplied. */
  paymentSummary: {
    applied: AllocatedPayment[];
    totalApplied: number;
    unappliedCount: number;
    totalUnapplied: number;
  } | null;
  runs: PaymentRun[];
  buckets: { bucket: AgingBucket; count: number; amount: number }[];
  vendors: { vendor: string; count: number; amount: number; oldestDue: string }[];
  futureDue: BillRecord[];
  generatedAt: string;
}

// ── Vendors outside this payment run ─────────────────────────────────────────

/** One reason a vendor is left out of the plan. */
export interface ExclusionRule {
  /** Matched against the vendor name. */
  pattern: RegExp;
  /** Short reason shown in the report. */
  reason: string;
}

/**
 * Vendors that never belong in the past-due pay queue.
 * - FedEx bills on the credit card autopay.
 * - AAA Cooper and Ferticell are already handled on an existing payment plan,
 *   so their Bill.com rows must not be re-planned here.
 * POs are deliberately not correlated: Bill.com bills carry no PO by policy,
 * and there is no reliable invoice-to-PO key in local data.
 */
export const EXCLUSIONS: ExclusionRule[] = [
  { pattern: /^fedex\b/i, reason: "CC autopay" },
  { pattern: /^aaa cooper/i, reason: "existing payment plan" },
  { pattern: /^ferticell/i, reason: "existing payment plan" },
];

/** Exclusion rule that applies to a vendor, or undefined when it is payable. */
export function exclusionFor(vendor: string): ExclusionRule | undefined {
  const name = (vendor || "").trim();
  return EXCLUSIONS.find((rule) => rule.pattern.test(name));
}

/** True when the vendor is handled outside this report. */
export function isExcludedVendor(vendor: string): boolean {
  return exclusionFor(vendor) !== undefined;
}

/** Approved arrangements that explain an exclusion. Kept here so the report
 *  states the commitment instead of the inflated Bill.com total. */
export const STANDING_ARRANGEMENTS: { pattern: RegExp; note: string }[] = [
  {
    pattern: /^aaa cooper/i,
    note: "Approved catch-up plan through December, roughly $13,729 remaining. Freight pickups reinstated.",
  },
];

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Convert Bill.com's MM/DD/YYYY to ISO YYYY-MM-DD. Returns "" when unparseable. */
export function isoFromUs(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((value || "").trim());
  if (!m) return "";
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Add days to an ISO date. */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** First Friday strictly after `iso`. Payment runs are Friday-dated. */
export function firstFridayAfter(iso: string): string {
  let cursor = addDays(iso, 1);
  for (let i = 0; i < 7; i += 1) {
    const dow = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (dow === 5) return cursor;
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

/** `n` consecutive Friday run dates starting after `iso`. */
export function nextFridays(iso: string, n: number): string[] {
  const out: string[] = [];
  let cursor = firstFridayAfter(iso);
  for (let i = 0; i < n; i += 1) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** MM/DD short form for tables. */
export function md(iso: string): string {
  if (!iso || iso.length < 10) return "";
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

/** Full US date for prose (e.g. "Fri 10/30"). */
export function runLabel(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[dow]} ${md(iso)}`;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/** Minimal RFC4180 parser: handles the BOM, quoted commas, and CRLF. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse "$1,234.56" / "1234.56" / "" into a number. */
export function parseAmount(value: string): number {
  const cleaned = (value || "").replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Locate a column by case-insensitive prefix, tolerating header drift. */
function colIndex(header: string[], prefixes: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const p of prefixes) {
    const idx = norm.findIndex((h) => h === p || h.startsWith(p));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parse a Bill.com "All Bills" CSV export into typed rows.
 * Unknown columns are ignored; missing optional columns fall back to "".
 */
export function parseBillsCsv(text: string): BillRecord[] {
  const table = splitCsv(text);
  if (table.length < 2) return [];
  const header = table[0];
  const idx = {
    invoiceNo: colIndex(header, ["invoice no"]),
    description: colIndex(header, ["description"]),
    vendor: colIndex(header, ["vendor"]),
    chartOfAccount: colIndex(header, ["chart of account"]),
    billType: colIndex(header, ["bill type"]),
    createdDate: colIndex(header, ["created date"]),
    poNumber: colIndex(header, ["po no"]),
    invoiceDate: colIndex(header, ["invoice date"]),
    dueDate: colIndex(header, ["due date"]),
    paymentStatus: colIndex(header, ["payment status"]),
    invoiceAmount: colIndex(header, ["invoice amount"]),
    balanceDue: colIndex(header, ["balance due"]),
    processDate: colIndex(header, ["process date"]),
    paymentMethod: colIndex(header, ["type "]),
  };
  if (idx.vendor < 0 || idx.invoiceNo < 0 || idx.dueDate < 0) return [];

  const at = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? "").trim() : "");

  return table.slice(1).map((row) => ({
    invoiceNo: at(row, idx.invoiceNo),
    description: at(row, idx.description),
    vendor: at(row, idx.vendor),
    chartOfAccount: at(row, idx.chartOfAccount),
    billType: at(row, idx.billType),
    createdDate: isoFromUs(at(row, idx.createdDate)),
    poNumber: at(row, idx.poNumber),
    invoiceDate: isoFromUs(at(row, idx.invoiceDate)),
    dueDate: isoFromUs(at(row, idx.dueDate)),
    paymentStatus: at(row, idx.paymentStatus),
    invoiceAmount: parseAmount(at(row, idx.invoiceAmount)),
    balanceDue: parseAmount(at(row, idx.balanceDue)),
    processDate: isoFromUs(at(row, idx.processDate)),
    paymentMethod: at(row, idx.paymentMethod),
  }));
}

// ── Aging ────────────────────────────────────────────────────────────────────

/** True when the bill still owes money (status is informational only). */
export function hasBalance(bill: BillRecord): boolean {
  if (bill.balanceDue > 0) return true;
  return bill.balanceDue === 0 && bill.paymentStatus.toLowerCase() !== "paid" && bill.invoiceAmount === 0;
}

/** Aging bucket for a day count. */
export function bucketOf(days: number): AgingBucket {
  if (days > 90) return "90+";
  if (days > 60) return "61-90";
  if (days > 30) return "31-60";
  if (days > 14) return "15-30";
  return "1-14";
}

/** A bill carrying the pre-payment balance for the detail table. */
export interface BillWithBalance extends BillRecord {
  /** Balance before any Payments Out netting. */
  originalBalance: number;
  /** Amount applied from the Payments Out export. */
  paidAmount: number;
}

/**
 * Select past-due bills, oldest first (ties broken by vendor then invoice).
 * Accepts plain bill rows or rows already carrying payment netting.
 */
export function selectOverdue(bills: BillRecord[], asOf: string): OverdueBill[] {
  return bills
    .filter((b) => b.dueDate !== "" && b.balanceDue > 0 && daysBetween(b.dueDate, asOf) > 0)
    .map((b) => {
      const withBalance = b as Partial<BillWithBalance>;
      return {
        ...b,
        originalBalance:
          typeof withBalance.originalBalance === "number"
            ? withBalance.originalBalance
            : b.balanceDue,
        paidAmount: typeof withBalance.paidAmount === "number" ? withBalance.paidAmount : 0,
        daysOverdue: daysBetween(b.dueDate, asOf),
      };
    })
    .sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.vendor.localeCompare(b.vendor) ||
        a.invoiceNo.localeCompare(b.invoiceNo),
    );
}

/** Sum balances. */
export function sumAmount(bills: BillRecord[]): number {
  return bills.reduce((acc, b) => acc + (Number.isFinite(b.balanceDue) ? b.balanceDue : 0), 0);
}

// ── Payment plan ─────────────────────────────────────────────────────────────

const BANDS: { label: string; test: (days: number) => boolean }[] = [
  { label: "Critical · 61+ days", test: (d) => d > 60 },
  { label: "Aging · 15-60 days", test: (d) => d > 14 && d <= 60 },
  { label: "Recent · 1-14 days", test: (d) => d <= 14 },
];

/**
 * Allocate the payable overdue stack into consecutive Friday runs.
 *
 * Band 1 takes everything 61+ days, band 2 everything 15-60, band 3 the rest.
 * This pays oldest first, clears the relationship-damaging tail in the first
 * release, and finishes the backlog in three Fridays. Excluded vendors
 * (FedEx, CC autopay) never enter the plan.
 *
 * @param overdue      Past-due bills, oldest first.
 * @param asOf         ISO as-of date.
 * @param bills        Full bill set, used to count what comes due each week.
 * @param runCount     Number of Friday runs to lay out (default 3).
 * @returns Terminated runs plus a steady-state run with no catch-up bills.
 */
export function buildPaymentPlan(
  overdue: OverdueBill[],
  asOf: string,
  bills: BillRecord[],
  runCount = 3,
): PaymentRun[] {
  const dates = nextFridays(asOf, runCount + 1);
  const payable = overdue.filter((b) => !isExcludedVendor(b.vendor));
  const used = new Set<string>();

  const runs: PaymentRun[] = [];
  let previousCutoff = asOf;

  for (let i = 0; i < runCount; i += 1) {
    const band = BANDS[i];
    const slice = payable.filter((b) => !used.has(keyOf(b)) && band.test(b.daysOverdue));
    slice.forEach((b) => used.add(keyOf(b)));
    const newDue = bills.filter(
      (b) =>
        b.dueDate !== "" &&
        b.balanceDue > 0 &&
        !isExcludedVendor(b.vendor) &&
        daysBetween(previousCutoff, b.dueDate) > 0 &&
        daysBetween(b.dueDate, dates[i]) >= 0,
    );
    runs.push({
      date: dates[i],
      label: band.label,
      bills: slice,
      overdueAmount: sumAmount(slice),
      newDueAmount: sumAmount(newDue),
    });
    previousCutoff = dates[i];
  }

  // Steady state: nothing carried over, only bills coming due that week.
  const steady = bills.filter(
    (b) =>
      b.dueDate !== "" &&
      b.balanceDue > 0 &&
      !isExcludedVendor(b.vendor) &&
      daysBetween(previousCutoff, b.dueDate) > 0 &&
      daysBetween(b.dueDate, dates[runCount]) >= 0,
  );
  runs.push({
    date: dates[runCount],
    label: "Steady state · current bills only",
    bills: [],
    overdueAmount: 0,
    newDueAmount: sumAmount(steady),
  });

  return runs;
}

/** Stable identity for a bill inside one CSV snapshot. */
function keyOf(b: BillRecord): string {
  return `${b.vendor}|${b.invoiceNo}|${b.dueDate}|${b.balanceDue}`;
}

/** Aging summary rows, always in bucket order. */
export function agingBuckets(overdue: OverdueBill[]): OverdueModel["buckets"] {
  const order: AgingBucket[] = ["1-14", "15-30", "31-60", "61-90", "90+"];
  return order.map((bucket) => {
    const rows = overdue.filter((b) => bucketOf(b.daysOverdue) === bucket);
    return { bucket, count: rows.length, amount: sumAmount(rows) };
  });
}

/** Vendor roll-up, largest balance first. */
export function vendorTotals(overdue: OverdueBill[]): OverdueModel["vendors"] {
  const map = new Map<string, { vendor: string; count: number; amount: number; oldestDue: string }>();
  for (const b of overdue) {
    const cur = map.get(b.vendor) ?? { vendor: b.vendor, count: 0, amount: 0, oldestDue: b.dueDate };
    cur.count += 1;
    cur.amount += b.balanceDue;
    if (b.dueDate < cur.oldestDue) cur.oldestDue = b.dueDate;
    map.set(b.vendor, cur);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Build the complete report model from raw CSV text.
 * @param csvText     Contents of the Bill.com All Bills export.
 * @param asOf        ISO as-of date (aging reference).
 * @param source      Label written in the PDF footer.
 * @param generatedAt ISO timestamp of generation.
 * @param paymentsCsv Optional Bill.com Payments Out export to net off balances.
 */
export function buildOverdueModel(
  csvText: string,
  asOf: string,
  source: string,
  generatedAt: string,
  paymentsCsv?: string,
): OverdueModel {
  const parsed = parseBillsCsv(csvText);
  const allocation = paymentsCsv ? applyPayments(parsed, parsePaymentsCsv(paymentsCsv), asOf) : null;

  // Net applied payments off the balance; keep the original for the detail table.
  const bills = parsed.map((b) => {
    const paidAmount = allocation?.paidByBill.get(billKey(b)) ?? 0;
    const originalBalance = b.balanceDue;
    return {
      ...b,
      originalBalance,
      paidAmount,
      balanceDue: Math.max(0, Number((originalBalance - paidAmount).toFixed(2))),
    };
  });
  const allOverdue = selectOverdue(bills, asOf);
  const excluded = allOverdue.filter((b) => isExcludedVendor(b.vendor));
  const overdue = allOverdue.filter((b) => !isExcludedVendor(b.vendor));
  const exclusionSummary = [...new Set(excluded.map((b) => exclusionFor(b.vendor)?.reason ?? "excluded"))]
    .map((reason) => {
      const rows = excluded.filter((b) => (exclusionFor(b.vendor)?.reason ?? "excluded") === reason);
      return {
        reason,
        count: rows.length,
        amount: sumAmount(rows),
        vendors: [...new Set(rows.map((b) => b.vendor))],
      };
    })
    .sort((a, b) => b.amount - a.amount);
  const horizon = addDays(asOf, 14);
  const futureDue = bills
    .filter(
      (b) =>
        b.dueDate !== "" &&
        b.balanceDue > 0 &&
        !isExcludedVendor(b.vendor) &&
        b.dueDate >= asOf &&
        b.dueDate <= horizon,
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.balanceDue - a.balanceDue);

  return {
    asOf,
    source,
    generatedAt,
    overdue,
    excluded,
    excludedAmount: sumAmount(excluded),
    exclusionSummary,
    paymentSummary: allocation
      ? {
          applied: allocation.rows.filter((r) => r.applied > 0),
          totalApplied: allocation.totalApplied,
          unappliedCount: allocation.unapplied.length,
          totalUnapplied: allocation.totalUnapplied,
        }
      : null,
    totalOverdue: sumAmount(overdue),
    totalOverdueIncludingExcluded: sumAmount(allOverdue),
    runs: buildPaymentPlan(allOverdue, asOf, bills, 3),
    buckets: agingBuckets(overdue),
    vendors: vendorTotals(overdue),
    futureDue,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Currency with cents — AP needs exact balances, not rounded dollars. */
export function money(n: number): string {
  return (Number(n) || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Escape text for HTML. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── HTML render (EOW purchasing-week visual language) ────────────────────────

const CSS = `
  @page { size: Letter; margin: 0.42in; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 9pt; line-height: 1.28; color: #222; margin: 0; }
  h1 { font-size: 14pt; margin: 0 0 1px 0; font-weight: 600; }
  .meta { font-size: 8pt; color: #666; margin-bottom: 6px; }
  h2 { font-size: 10pt; margin: 8px 0 3px 0; padding-bottom: 1px; border-bottom: 1px solid #ddd; font-weight: 600; page-break-after: avoid; }
  .summary { margin: 0 0 3px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 0 0 2px 0; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #555; color: #fff; text-align: left; padding: 2px 5px; font-weight: 600; }
  td { padding: 1px 5px; border-bottom: 1px solid #e5e5e5; vertical-align: top; word-wrap: break-word; }
  tr:nth-child(even) td { background: #f8f8f8; }
  .amt { text-align: right; white-space: nowrap; }
  th.amt { text-align: right; }
  .days { width: 7%; text-align: right; white-space: nowrap; }
  th.days { text-align: right; }
  .total-row td { font-weight: 600; background: #eee !important; }
  .keep { page-break-inside: avoid; }
  .foot { font-size: 8pt; color: #666; margin-top: 10px; }
  .crit td { font-weight: 600; }
  .note-list { margin: 0; padding-left: 14px; }
  .note-list li { margin: 0 0 2px 0; }
  .flag { color: #8a4b00; }
  .run-detail { font-size: 8pt; color: #444; }
  .bill-vendor { width: 26%; } .bill-inv { width: 14%; } .bill-po { width: 8%; }
  .bill-due { width: 9%; } .bill-sched { width: 9%; } .bill-amt { width: 12%; }
  .bill-paid { width: 10%; }
  .pay-method { width: 16%; } .pay-status { width: 14%; }
`;

/**
 * Render the overdue-bills report as a self-contained HTML document.
 * Mirrors the EOW purchasing-week layout: dark header rows, zebra body,
 * summary line above every table, and a total row.
 */
export function renderOverdueHtml(model: OverdueModel): string {
  const parts: string[] = [];
  const payableRuns = model.runs.filter((r) => r.bills.length > 0);
  const planTotal = payableRuns.reduce((a, r) => a + r.overdueAmount, 0);

  parts.push(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${CSS}</style></head><body>`);
  parts.push(`<h1>Overdue Bills</h1>`);
  parts.push(
    `<div class="meta">As of ${new Date(`${model.asOf}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    })} · Bill.com All Bills · BuildASoil · Bill Selee</div>`,
  );

  // Summary
  parts.push(`<div class="keep"><h2>Summary</h2>`);
  parts.push(
    `<p class="summary">${model.overdue.length} bills · <b>${money(
      model.totalOverdue,
    )}</b> past due</p>`,
  );
  if (model.paymentSummary) {
    const ps = model.paymentSummary;
    parts.push(
      `<p class="summary" style="font-size:7.5pt;color:#666">Payments out applied: ${ps.applied.length} payments, ${money(
        ps.totalApplied,
      )} netted against balances${
        ps.unappliedCount > 0
          ? ` · ${ps.unappliedCount} with ${money(ps.totalUnapplied)} unapplied (no open bill)`
          : ""
      }</p>`,
    );
  }
  if (model.exclusionSummary.length > 0) {
    const line = model.exclusionSummary
      .map(
        (g) =>
          `${esc(g.vendors.join(", "))} ${g.count} bill${g.count === 1 ? "" : "s"} (${money(
            g.amount,
          )}), ${esc(g.reason)}`,
      )
      .join(" · ");
    parts.push(
      `<p class="summary" style="font-size:7.5pt;color:#666">Not in this run: ${line}</p>`,
    );
    const arranged = STANDING_ARRANGEMENTS.filter((a) =>
      model.excluded.some((b) => a.pattern.test(b.vendor)),
    );
    if (arranged.length > 0) {
      parts.push(
        `<p class="summary" style="font-size:7.5pt;color:#666">${arranged
          .map((a) => esc(a.note))
          .join(" ")}</p>`,
      );
    }
  }
  parts.push(`<table>
  <thead><tr><th>Aging</th><th class="amt">Bills</th><th class="amt">Balance</th><th class="amt">Share</th></tr></thead>
  <tbody>`);
  for (const b of model.buckets) {
    if (b.count === 0) continue;
    const share = model.totalOverdue > 0 ? (b.amount / model.totalOverdue) * 100 : 0;
    parts.push(
      `<tr><td>${b.bucket} days</td><td class="amt">${b.count}</td><td class="amt">${money(
        b.amount,
      )}</td><td class="amt">${share.toFixed(0)}%</td></tr>`,
    );
  }
  parts.push(
    `<tr class="total-row"><td>Total payable</td><td class="amt">${model.overdue.length}</td><td class="amt">${money(
      model.totalOverdue,
    )}</td><td class="amt">100%</td></tr>`,
  );
  parts.push(`</tbody></table></div>`);

  // Payment plan
  parts.push(`<div class="keep"><h2>Payment Plan — Friday Releases</h2>`);
  parts.push(
    `<p class="summary">Oldest first. Catch-up ${money(planTotal)} over ${payableRuns.length} Fridays, then weekly steady state.</p>`,
  );
  parts.push(`<table>
  <col style="width:16%"><col style="width:30%"><col style="width:8%"><col style="width:15%"><col style="width:15%"><col style="width:16%">
  <thead><tr><th>Run</th><th>Clears</th><th class="amt">Bills</th><th class="amt">Overdue</th><th class="amt">New due</th><th class="amt">Release</th></tr></thead>
  <tbody>`);
  for (const run of model.runs) {
    parts.push(
      `<tr><td>${runLabel(run.date)}</td><td>${esc(run.label)}</td><td class="amt">${
        run.bills.length || "—"
      }</td><td class="amt">${run.bills.length ? money(run.overdueAmount) : "—"}</td><td class="amt">${
        run.newDueAmount > 0 ? money(run.newDueAmount) : "—"
      }</td><td class="amt">${money(run.overdueAmount + run.newDueAmount)}</td></tr>`,
    );
  }
  parts.push(`</tbody></table>`);
  parts.push(
    `<p class="run-detail">“New due” = bills in the export that come due between the prior run and this one; that is the cash to keep on hand on top of catch-up.</p>`,
  );
  parts.push(`</div>`);

  // Detail, oldest first
  parts.push(`<div><h2>Past Due — Oldest First</h2>`);
  parts.push(
    `<p class="summary">${model.overdue.length} bills · ${money(
      model.overdue.reduce((a, b) => a + b.originalBalance, 0),
    )} billed · ${money(model.totalOverdue)} remaining · oldest ${
      model.overdue.length ? `${model.overdue[0].daysOverdue} days` : "—"
    }</p>`,
  );
  parts.push(`<table>
  <col class="bill-vendor"><col class="bill-inv"><col class="bill-due"><col class="days"><col class="bill-amt"><col class="bill-paid"><col class="bill-amt">
  <thead><tr><th>Vendor</th><th>Invoice #</th><th>Date due</th><th class="days">Days</th><th class="amt">Amount</th><th class="amt">Paid</th><th class="amt">Remaining</th></tr></thead>
  <tbody>`);
  for (const b of model.overdue) {
    const cls = b.daysOverdue > 60 ? ' class="crit"' : "";
    parts.push(
      `<tr${cls}><td>${esc(b.vendor)}</td><td>${esc(b.invoiceNo)}</td><td>${md(
        b.dueDate,
      )}</td><td class="days">${b.daysOverdue}</td><td class="amt">${money(
        b.originalBalance,
      )}</td><td class="amt">${b.paidAmount > 0 ? money(b.paidAmount) : "—"}</td><td class="amt">${money(
        b.balanceDue,
      )}</td></tr>`,
    );
  }
  const originalTotal = model.overdue.reduce((a, b) => a + b.originalBalance, 0);
  const paidTotal = model.overdue.reduce((a, b) => a + b.paidAmount, 0);
  parts.push(
    `<tr class="total-row"><td>Total</td><td></td><td></td><td class="days"></td><td class="amt">${money(
      originalTotal,
    )}</td><td class="amt">${paidTotal > 0 ? money(paidTotal) : "—"}</td><td class="amt">${money(
      model.totalOverdue,
    )}</td></tr>`,
  );
  parts.push(`</tbody></table></div>`);

  // Payments out applied
  if (model.paymentSummary && model.paymentSummary.applied.length > 0) {
    const ps = model.paymentSummary;
    parts.push(`<div class="keep"><h2>Payments Out Applied</h2>`);
    parts.push(
      `<p class="summary">${ps.applied.length} payments · ${money(
        ps.totalApplied,
      )} netted against the bills above</p>`,
    );
    parts.push(`<table>
    <col class="bill-vendor"><col class="bill-inv"><col class="pay-method"><col class="pay-status"><col class="bill-amt">
    <thead><tr><th>Vendor</th><th>Invoice #</th><th>Method</th><th>Status</th><th class="amt">Amount</th></tr></thead>
    <tbody>`);
    for (const row of ps.applied) {
      parts.push(
        `<tr><td>${esc(row.payment.vendor)}</td><td>${esc(row.payment.invoiceNumber)}</td><td>${esc(
          row.payment.method,
        )}</td><td>${esc(row.payment.status)}</td><td class="amt">${money(row.applied)}</td></tr>`,
      );
    }
    parts.push(
      `<tr class="total-row"><td>Total</td><td></td><td></td><td></td><td class="amt">${money(
        ps.totalApplied,
      )}</td></tr>`,
    );
    parts.push(`</tbody></table></div>`);
  }

  // Coming due
  if (model.futureDue.length > 0) {
    parts.push(`<div class="keep"><h2>Coming Due — Next 14 Days</h2>`);
    parts.push(
      `<p class="summary">${model.futureDue.length} bills · ${money(
        sumAmount(model.futureDue),
      )} · keep this in the Friday run</p>`,
    );
    parts.push(`<table>
    <col class="bill-vendor"><col class="bill-inv"><col class="bill-due"><col class="bill-amt">
    <thead><tr><th>Vendor</th><th>Invoice #</th><th>Date due</th><th class="amt">Amount</th></tr></thead>
    <tbody>`);
    for (const b of model.futureDue) {
      parts.push(
        `<tr><td>${esc(b.vendor)}</td><td>${esc(b.invoiceNo)}</td><td>${md(b.dueDate)}</td><td class="amt">${money(
          b.balanceDue,
        )}</td></tr>`,
      );
    }
    parts.push(`</tbody></table></div>`);
  }

  // Notes
  parts.push(`<div class="keep"><h2>Notes — Paying On Time From Here</h2><ol class="note-list">`);
  for (const note of onTimeNotes(model)) parts.push(`<li>${note}</li>`);
  parts.push(`</ol></div>`);

  parts.push(
    `<div class="foot">Source: ${esc(model.source)} · ${esc(model.generatedAt)} · Aria overdue-bills report</div>`,
  );
  parts.push(`</body></html>`);
  return parts.join("\n");
}

/**
 * Data-driven notes for the "pay on time" section. Every claim is computed
 * from the export so the notes cannot drift from the numbers above them.
 */
export function onTimeNotes(model: OverdueModel): string[] {
  const notes: string[] = [];
  if (model.paymentSummary && model.paymentSummary.totalApplied > 0) {
    notes.push(
      `<b>Batch already out.</b> ${model.paymentSummary.applied.length} payments totalling ${money(
        model.paymentSummary.totalApplied,
      )} are netted against these bills, so the plan above covers only the remainder.`,
    );
  }
  if (model.paymentSummary && model.paymentSummary.unappliedCount > 0) {
    notes.push(
      `<b>Unapplied payments.</b> ${model.paymentSummary.unappliedCount} payments (${money(
        model.paymentSummary.totalUnapplied,
      )}) had no matching open bill in this export. Confirm they landed on invoices already off the report.`,
    );
  }
  const offFridayBills = model.overdue.filter((b) => {
    if (!b.processDate) return false;
    return new Date(`${b.processDate}T00:00:00Z`).getUTCDay() !== 5;
  });
  if (offFridayBills.length > 0) {
    const dates = [...new Set(offFridayBills.map((b) => md(b.processDate)))].sort();
    notes.push(
      `<b>Reset process dates.</b> ${offFridayBills.length} of ${model.overdue.length} bills are booked to process on ${dates.join(
        ", ",
      )}, none on a Friday. Point each bill at its planned run date so the release lands on the right day.`,
    );
  }

  const logan = model.vendors.find((v) => /logan labs/i.test(v.vendor));
  if (logan && logan.count >= 5) {
    notes.push(
      `<b>Move Logan Labs to ePayment.</b> ${logan.count} invoices, ${money(
        logan.amount,
      )}, most under $200. Check issuance adds days that ACH does not.`,
    );
  }

  const bigTerms = model.vendors.find((v) => /berger/i.test(v.vendor));
  if (bigTerms && bigTerms.amount > 10_000) {
    notes.push(
      `<b>Confirm Berger terms.</b> ${money(bigTerms.amount)} across ${
        bigTerms.count
      } bills, oldest due ${md(bigTerms.oldestDue)}. The dates imply roughly net 120, so confirm the term before the first run.`,
    );
  }

  const cardVendor = model.overdue.find((b) => /virtual card/i.test(b.paymentMethod));
  if (cardVendor) {
    const firstRun = model.runs[0]?.date ?? "";
    notes.push(
      `<b>Check the virtual card.</b> ${esc(cardVendor.vendor)} ${money(
        cardVendor.balanceDue,
      )} is set to pay by virtual card on ${md(cardVendor.processDate)}. Confirm the card is active before ${runLabel(
        firstRun,
      )}.`,
    );
  }

  const biggest = model.vendors[0];
  if (biggest && biggest.amount > 10_000 && !/berger/i.test(biggest.vendor)) {
    notes.push(
      `<b>${esc(biggest.vendor)} is the largest single exposure.</b> ${money(
        biggest.amount,
      )} across ${biggest.count} bills, oldest ${md(biggest.oldestDue)}.`,
    );
  }

  const maxDays = model.overdue[0]?.daysOverdue ?? 0;
  notes.push(
    `<b>45-day ceiling.</b> Oldest bill on this report is ${maxDays} days. Aging runs every Friday; anything crossing 45 days is paid that run regardless of band.`,
  );
  notes.push(
    `<b>Weekly cadence.</b> Bills entered within 24h of receipt, process date set to that week's Friday, one release per week. The three-week catch-up assumes new bills stay current.`,
  );
  return notes;
}
