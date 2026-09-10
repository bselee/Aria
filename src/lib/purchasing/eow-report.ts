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
