/**
 * @file    src/lib/ap/payments-out.ts
 * @purpose Parse the Bill.com "Payments Out" CSV and apply it against bill
 *          balances so the overdue report shows what is actually still owed.
 * @author  Hermia
 * @created 2026-10-26
 * @deps    none (pure — no fs, no db, no network)
 * @env     none
 *
 * Matching rules, deliberately conservative:
 *  - Only payments processed on or after the as-of date are applied. The Bills
 *    export is the balance state on that date, so anything earlier is already
 *    reflected and applying it again would double-count.
 *  - An invoice number that is not "Multiple" must match vendor + invoice.
 *  - "Multiple" covers a vendor's invoices: allocate oldest due date first.
 *  - Anything left over is reported as unapplied, never silently dropped.
 */

import type { BillRecord } from "./overdue-bills";

/** One row of the Bill.com Payments Out export. Dates are ISO. */
export interface PaymentOut {
  confirmation: string;
  vendor: string;
  processDate: string;
  status: string;
  method: string;
  amount: number;
  invoiceNumber: string;
  arrivalDate: string;
}

/** A payment with its allocation resolved against bill balances. */
export interface AllocatedPayment {
  payment: PaymentOut;
  applied: number;
  /** Bill keys this payment touched, in allocation order. */
  billKeys: string[];
}

/** Result of applying a Payments Out file to a bill set. */
export interface AllocationResult {
  paidByBill: Map<string, number>;
  rows: AllocatedPayment[];
  unapplied: { vendor: string; invoiceNumber: string; amount: number }[];
  totalApplied: number;
  totalUnapplied: number;
}

/** Stable identity for a bill row. */
export function billKey(bill: BillRecord): string {
  return `${bill.vendor}|${bill.invoiceNo}|${bill.dueDate}|${bill.balanceDue}`;
}

/** Vendor names come from Bill.com on both sides; normalize stray spacing. */
function vendorKey(vendor: string): string {
  return (vendor || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** MM/DD/YYYY or "Oct 27, 2026" to ISO. */
export function isoFromBillcom(value: string): string {
  const raw = (value || "").trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) {
    const [, mm, dd, yyyy] = us;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return "";
}

/** Minimal RFC4180 splitter; tolerates the BOM and CRLF. */
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

function colIndex(header: string[], prefix: string): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  return norm.findIndex((h) => h === prefix || h.startsWith(prefix));
}

/** Parse the Payments Out export. Voided rows are kept for reporting. */
export function parsePaymentsCsv(text: string): PaymentOut[] {
  const table = splitCsv(text);
  if (table.length < 2) return [];
  const header = table[0];
  const idx = {
    confirmation: colIndex(header, "confirmation"),
    vendor: colIndex(header, "vendor"),
    processDate: colIndex(header, "process date"),
    status: colIndex(header, "payment status"),
    method: colIndex(header, "payment method"),
    amount: colIndex(header, "payment amount"),
    arrival: colIndex(header, "arrival date"),
    invoice: colIndex(header, "invoice number"),
  };
  if (idx.vendor < 0 || idx.amount < 0) return [];

  const at = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? "").trim() : "");

  return table.slice(1).map((row) => ({
    confirmation: at(row, idx.confirmation),
    vendor: at(row, idx.vendor),
    processDate: isoFromBillcom(at(row, idx.processDate)),
    status: at(row, idx.status),
    method: at(row, idx.method),
    amount: Number(at(row, idx.amount).replace(/[^0-9.\-]/g, "")) || 0,
    invoiceNumber: at(row, idx.invoice),
    arrivalDate: isoFromBillcom(at(row, idx.arrival)),
  }));
}

/** Voided payments never moved money. */
export function isVoid(payment: PaymentOut): boolean {
  return /^voided$/i.test((payment.status || "").trim());
}

/**
 * Apply payments to bill balances oldest-first.
 *
 * @param bills     Bills parsed from the All Bills export.
 * @param payments  Payments parsed from the Payments Out export.
 * @param asOf      ISO date of the bills snapshot; earlier payments are skipped.
 * @returns Per-bill paid amounts, the applied rows, and any unapplied remainder.
 */
export function applyPayments(
  bills: BillRecord[],
  payments: PaymentOut[],
  asOf: string,
): AllocationResult {
  const remaining = new Map<string, number>();
  for (const bill of bills) remaining.set(billKey(bill), bill.balanceDue);

  const paidByBill = new Map<string, number>();
  const rows: AllocatedPayment[] = [];
  const unapplied: AllocationResult["unapplied"] = [];
  let totalApplied = 0;
  let totalUnapplied = 0;

  const ordered = [...payments]
    .filter((p) => !isVoid(p) && p.processDate !== "" && p.processDate >= asOf && p.amount > 0)
    .sort((a, b) => a.processDate.localeCompare(b.processDate) || a.vendor.localeCompare(b.vendor));

  for (const payment of ordered) {
    const key = vendorKey(payment.vendor);
    const isMultiple = /^multiple$/i.test(payment.invoiceNumber.trim());

    const candidates = bills
      .filter((b) => {
        if (vendorKey(b.vendor) !== key) return false;
        if (!isMultiple && b.invoiceNo.trim() !== payment.invoiceNumber.trim()) return false;
        return (remaining.get(billKey(b)) ?? 0) > 0.005;
      })
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) ||
          a.invoiceNo.localeCompare(b.invoiceNo),
      );

    let left = payment.amount;
    const touched: string[] = [];

    for (const bill of candidates) {
      if (left <= 0.005) break;
      const bk = billKey(bill);
      const open = remaining.get(bk) ?? 0;
      const take = Math.min(open, left);
      remaining.set(bk, open - take);
      paidByBill.set(bk, (paidByBill.get(bk) ?? 0) + take);
      touched.push(bk);
      left -= take;
      totalApplied += take;
    }

    rows.push({ payment, applied: payment.amount - left, billKeys: touched });

    if (left > 0.005) {
      unapplied.push({
        vendor: payment.vendor,
        invoiceNumber: payment.invoiceNumber,
        amount: Number(left.toFixed(2)),
      });
      totalUnapplied += left;
    }
  }

  return { paidByBill, rows, unapplied, totalApplied, totalUnapplied };
}
