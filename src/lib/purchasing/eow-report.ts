/**
 * @file    eow-report.ts
 * @purpose Pure helpers for Friday purchasing-week PDF
 * @author  Hermia
 * @created 2026-09-03
 * @deps    none
 * @env     none
 */

const DROPSHIP = /autopot|evergreen|printful|dropship/i;
const NEVER_AUTONOMOUS = /asle|organics alive|sticker giant/i;

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

export function mdFromIso(isoDate: string): string {
  if (!isoDate || isoDate.length < 10) return "";
  return `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}`;
}

/** AAA Cooper Pro# PDFs are invoices even when the subject says Stmt. */
export function isStatement(from: string, subject: string, filename: string): boolean {
  const blob = `${from} ${subject} ${filename}`.toLowerCase();
  if (/aaa.?cooper|aaacooper/.test(blob)) return false;
  if (/relev[eé]|releve de compte/.test(blob)) return true;
  if (/beltpower/.test(blob) && /reminder/.test(blob) && !/^inv/i.test(filename || "")) return true;
  if (/\bstatement\b/.test(blob) && !/\binv(?:oice)?[\s#_:-]*\d/.test(blob)) return true;
  return false;
}

/** OCR text layer: statement packets with no invoice# must not go to Bill.com. */
export function isStatementOcrText(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (t.length < 40) return false;
  if (/aaa.?cooper|aaacooper/.test(t)) return false;
  const looksStmt =
    /statement of account|account statement|statement summary|aging summary|balance forward/.test(t);
  const looksInvoice = /invoice\s*(#|no\.?|number)/i.test(text);
  return looksStmt && !looksInvoice;
}

export function isDropshipVendor(vendor: string): boolean {
  return DROPSHIP.test(vendor || "");
}

export function invoiceAmountLabel(vendor: string, amount: number): string {
  if (amount > 0) {
    return Math.round(amount).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  }
  return isDropshipVendor(vendor) ? "Dropshipped" : "";
}

export function excludeManualVendor(vendor: string, sku: string): boolean {
  return NEVER_AUTONOMOUS.test(vendor || "") || NEVER_AUTONOMOUS.test(sku || "");
}

export function needByIso(todayIso: string, runwayDays: number): string {
  return addDays(todayIso, Math.max(0, Math.floor(runwayDays)));
}

export function withinDays(needIso: string, todayIso: string, days: number): boolean {
  return needIso >= todayIso && needIso <= addDays(todayIso, days);
}

export function money(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
