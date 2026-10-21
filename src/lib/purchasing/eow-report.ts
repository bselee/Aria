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
  if (/\bstatement\b/.test(blob) && !/\binv(?:oice)?[\s#_:-]*\d/.test(blob)) return true;
  return false;
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

/** Vendors that never reply. Delayed only if a line SKU is close to out of stock. */
export const SILENT_DELAY_VENDOR = /rootwise/i;
export const CLOSE_TO_OOS_DAYS = 21;

export function minRunway(days: Array<number | null | undefined>): number | null {
  const nums = days.filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  return nums.length ? Math.min(...nums) : null;
}

export function keepSilentVendorDelay(vendor: string, minRunwayDays: number | null): boolean {
  if (!SILENT_DELAY_VENDOR.test(vendor || "")) return true;
  return minRunwayDays != null && minRunwayDays <= CLOSE_TO_OOS_DAYS;
}

/** Any receipt against an open PO is a partial, not a silent delay. */
export function isPartialReceived(received: number | null, remaining: number | null): boolean {
  return (received ?? 0) > 0 && (remaining == null || remaining > 0);
}

/**
 * No vendor ETA + Finale already stamped a receive date = goods have moved.
 * Do not use PG receive_date (North Mason / Certis stay delayed).
 */
export function isPartialFromFinaleReceive(
  vendorEtaIso: string | null,
  finaleReceiveIso: string | null,
  todayIso: string
): boolean {
  if (vendorEtaIso) return false;
  if (!finaleReceiveIso || finaleReceiveIso.length < 10) return false;
  return finaleReceiveIso.slice(0, 10) <= todayIso;
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** Strip quoted history so we parse the vendor's own words. */
export function vendorReplyOwnText(body: string): string {
  const cut = body.search(/\nFrom: |\nOn [A-Z][a-z]{2}, |\n_{5,}/);
  return (cut > 0 ? body.slice(0, cut) : body).replace(/\s+/g, " ").trim();
}

function mdSlashToIso(s: string): string | null {
  const p = s.split(/[/-]/).map(Number);
  if (p.length < 2 || !p[0] || !p[1]) return null;
  let y = p[2] || new Date().getUTCFullYear();
  if (y < 100) y += 2000;
  return `${y}-${String(p[0]).padStart(2, "0")}-${String(p[1]).padStart(2, "0")}`;
}

/** Due / ship date from the vendor's own reply. Null if they only stalled. */
export function parseVendorDueFromText(text: string): string | null {
  const own = vendorReplyOwnText(text);
  if (!own) return null;
  if (/know by friday|trying to get it done|staffing issues/i.test(own) && !/\buntil\b|\bETA\b|\bdue\b/i.test(own)) {
    return null;
  }
  const monthYear = own.match(
    /\buntil\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})/i
  );
  if (monthYear) {
    const mm = MONTHS[monthYear[1].toLowerCase()];
    if (mm) return `${monthYear[2]}-${mm}-01`;
  }
  const eta = own.match(/\bETA[:\s]+(?:[A-Za-z]+,?\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (eta) return mdSlashToIso(eta[1]);
  const due = own.match(
    /\b(?:due|ship(?:ping)?|delivery)\s+(?:date\s+)?(?:by\s+|on\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
  );
  if (due) return mdSlashToIso(due[1]);
  return null;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

export function delayedVendorNote(input: {
  emailDueIso: string | null;
  pgEtaIso: string | null;
  lastVendorReplyIso: string | null;
  todayIso: string;
  backorder?: boolean;
}): string {
  if (input.emailDueIso) {
    const label = input.backorder ? "Backorder" : "Vendor ETA";
    const iso = input.emailDueIso;
    if (iso.endsWith("-01") && input.backorder) {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${label} ${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
    }
    return `${label} ${mdFromIso(iso)}`;
  }
  if (input.lastVendorReplyIso && daysBetween(input.lastVendorReplyIso, input.todayIso) >= 21) {
    return `No reply since ${mdFromIso(input.lastVendorReplyIso)}`;
  }
  if (input.pgEtaIso) return `Vendor ETA ${mdFromIso(input.pgEtaIso)}`;
  return "No update from vendor";
}

export function shortPriceNote(vendor: string, subject: string, snippet: string): string {
  const blob = `${vendor} ${subject} ${snippet}`.toLowerCase();
  if (/fish meal|fm104|concentrates/.test(blob)) return "FM104 raised. Cut to 1 pallet.";
  if (/aquabac|wdg101|clarke/.test(blob)) return "WDG101 2026 $750/unit.";
  if (/frass|cornerstone|cfr101/.test(blob) && /cornerstone|cfr101|processed/.test(blob))
    return "Processed frass $0.50 to $1.00/lb. Not switched.";
  const cleaned = snippet.replace(/^hi[^,]*,?/i, "").replace(/\s+/g, " ").trim();
  return cleaned.split(/\s+/).slice(0, 10).join(" ");
}

export function priceVendorName(from: string, subject: string): string {
  const blob = `${from} ${subject}`.toLowerCase();
  if (/concentrates/.test(blob)) return "Concentrates";
  if (/clarke/.test(blob)) return "Clarke";
  if (/cornerstone/.test(blob)) return "Cornerstone";
  return from.replace(/.*<|>.*/g, "").replace(/@.*/, "").slice(0, 40) || from.slice(0, 40);
}

export type ResearchHit = { sku: string; vendor: string; note: string };

/** Company + product only. Null if the thread is noise. */
export function researchHit(from: string, subject: string, snippet: string): ResearchHit | null {
  const blob = `${from} ${subject} ${snippet}`.toLowerCase();
  if (/symton|lauren@symton|frass tote|frass by the tote/.test(blob)) {
    return {
      sku: "",
      vendor: "Symton",
      note: "Frass tote. Freight on us. 2/mo. Testing pending.",
    };
  }
  if (/green cover|greencover/.test(blob)) {
    return {
      sku: "CLVR04",
      vendor: "Green Cover",
      note: "Clover blend 2,484 lb landed $1.74/lb vs Pulse $3.45/lb.",
    };
  }
  if (/majestic|soybean meal/.test(blob)) {
    return {
      sku: "SB104",
      vendor: "Majestic Milling",
      note: "Organic soybean meal. Spec pending.",
    };
  }
  if (/driven sol|drivensol|landon@/.test(blob) && /bag/.test(blob)) {
    return null;
  }
  if (/grove bags|grovebags/.test(blob)) {
    return { sku: "", vendor: "Grove Bags", note: "Hold off." };
  }
  if (/lind marine|shell flour/.test(blob)) {
    return {
      sku: "RAWSHELLFLOUR",
      vendor: "Lind Marine",
      note: "Particle size explained. Standard product works.",
    };
  }
  return null;
}
