/**
 * @file    src/lib/purchasing/billcom-ap-audit.ts
 * @purpose Pure matching + classification logic for the Bill.com "All Bills" vs AP
 *          audit (run by `src/cli/reconcile-billcom.ts`). Extracted from that CLI
 *          so the rules can be unit-tested without touching Gmail, PostgREST or
 *          the SQLite file, and so there is ONE copy of the vendor/invoice
 *          comparators.
 *
 *          Two directions:
 *            1. forward -> bill   (does everything Aria forwarded exist in Bill.com)
 *            2. bill -> AP        (does every bill on the page have an AP record)
 *          This module owns direction 2's classification and the stuck-row
 *          reconciliation used to close ledger rows whose bill has arrived.
 *
 * @author  Hermia
 * @created 2026-10-07
 * @deps    none (pure)
 */

// ── Row shapes (subset of the columns the CLI selects) ───────────────────────

export interface ForwardRow {
  id: number;
  forwarded_at: string;
  status?: string | null;
  email_from: string | null;
  email_subject: string | null;
  pdf_filename: string | null;
  ocr_vendor_name: string | null;
  ocr_invoice_number: string | null;
  ocr_total: string | null;
  ocr_raw_text?: string | null;
  verified?: number | null;
  billcom_processed?: number | null;
  vendor_routing_action?: string | null;
  reconciliation_notes?: string | null;
  error_message?: string | null;
}

export interface RefRow {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_amount: number | null;
  invoice_date: string | null;
  due_date?: string | null;
  po_number?: string | null;
  created_at?: string | null;
}

/** `invoice_cache` row (local SQLite). */
export interface CacheRow {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  source?: string | null;
}

/** PostgREST `vendor_invoices` row. */
export interface VendorInvoiceRow {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  created_at?: string | null;
}

export interface AuditFacts {
  /** ALL forwards for the vendor window under audit (any status, any age). */
  forwards: ForwardRow[];
  cache: CacheRow[];
  vendorInvoices: VendorInvoiceRow[];
  /** Full Bill.com reference table, used to judge vendor history. */
  ref: RefRow[];
  /** Slack allowed when corroborating on amount+date instead of invoice#. */
  dateWindowDays?: number;
}

export interface ApEvidence {
  source: "forward" | "invoice_cache" | "vendor_invoices";
  detail: string;
}

export type NoRecordClass =
  /** Aria claimed the invoice and never delivered it to Bill.com. Actionable. */
  | "STUCK_NEVER_SENT"
  /** First bill from a vendor Aria has no record of at all. Look once. */
  | "NO_VENDOR_HISTORY"
  /** Vendor flows through Aria; this invoice was entered in Bill.com by hand. */
  | "HAND_FORWARDED"
  /** Vendor never reaches Aria's ledger (billed to Bill directly). */
  | "NO_AP_FORWARDS_EVER"
  /** FedEx is excluded from Bill.com forwarding by rule. */
  | "FEDEX_RULE";

export interface NoRecordVerdict {
  kind: NoRecordClass;
  detail: string;
  actionable: boolean;
}

// ── Normalization ────────────────────────────────────────────────────────────

const STOP_WORDS =
  /\b(inc|llc|l\.l\.c|ltd|co|corp|company|corporation|incorporated|the|usa|us|llc,|group|supply)\b/gi;

export function normVendor(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(STOP_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normInvoice(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Industry-generic words that must never alone prove two vendors are the same.
 * "Century Equipment Company" and "Welch Equipment" share "equipment" but are
 * unrelated vendors; treating a shared generic token as a match made the
 * Century Equipment invoice (GJ17176-1) report "vendor matches ref" when no
 * Century bill has ever existed in 1300+ Bill.com rows. Only the token-overlap
 * branch of vendorsMatch is filtered — containment and the alias map are not.
 */
export const GENERIC_VENDOR_TOKENS = new Set([
  "equipment", "supply", "supplies", "company", "inc", "llc", "ltd", "corp",
  "services", "service", "group", "logistics", "transport", "transportation",
  "trucking", "packaging", "products", "industries", "solutions", "systems",
  "distributors", "distribution", "wholesale", "farms", "farm", "ranch",
  "trading", "enterprises", "holdings", "partners", "manufacturing",
  "organics", "organic", "soils", "soil", "america", "usa", "national",
  // Added 2026-10-07: the reverse sweep attributed real gaps to the wrong vendor
  // through ONE shared word. "worldwide" made WWEX forward subjects look like
  // Invico Worldwide's, "compost" made Malibu Compost's look like SeaCoast
  // Compost's, and "cooper" (a surname) made a Sustainable Village thread look
  // like AAA Cooper's. Vendors that share only a generic word must not merge; the
  // alias map still matches each vendor to itself (WWEX via worldwideexpress,
  // AAA Cooper via aaacooper).
  "worldwide", "compost", "cooper",
]);

/**
 * Loose vendor compare: containment OR shared meaningful token OR alias map.
 * Entries are matched with `includes()` against the normalized string, so a
 * spaced entry ("kyle takahashi") and a compact one ("kyletakahashi") are not
 * interchangeable — add the form that actually appears in the haystack.
 */
export const VENDOR_ALIASES: Array<string[]> = [
  ["fedex", "federalexpress"],
  ["aaacooper", "aaacoopertransportation", "aaa cooper", "aaa cooper transportation"],
  ["autopot", "autopotwateringsystems"],
  ["loganlabs", "loganlabs"],
  ["evergreen", "evergreengrowerssupply"],
  ["marionag", "marionagservice"],
  ["miles", "milesfilippelli"],
  ["newmoon", "newmoondevelopment", "kyle takahashi", "kyletakahashi"],
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
];

export function vendorsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normVendor(a);
  const nb = normVendor(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4 && !GENERIC_VENDOR_TOKENS.has(t)));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 4 && !GENERIC_VENDOR_TOKENS.has(t)));
  if ([...ta].some((t) => tb.has(t))) return true;
  for (const group of VENDOR_ALIASES) {
    if (group.some((g) => na.includes(g)) && group.some((g) => nb.includes(g))) return true;
  }
  return false;
}

/** Digits-only compare; shorter ≥6-digit core may prefix/suffix longer. */
export function invoicesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = normInvoice(a);
  const db = normInvoice(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 6 && (long.startsWith(short) || long.endsWith(short));
}

// ── Dates and amounts ────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp, ISO date, or M/D/YYYY into a UTC midnight epoch.
 * All three shapes appear in the sources (ref/CSV are ISO, `invoice_cache`
 * holds M/D/YYYY, forwards hold ISO datetimes). Returns null when unparseable.
 */
export function parseDay(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

/** Parse a dollar string ("1,234.56", "$1,234.56") to a number; null if not a pure amount. */
export function parseDollars(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[$£€,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** True when two day-stamps are within `days` of each other. Null-safe: false. */
export function withinDays(a: number | null, b: number | null, days: number): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= days * 86_400_000;
}

// ── Identity derivation from a forward row ──────────────────────────────────

export function parseSender(from: string | null): { display: string; addr: string; domain: string } {
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
export function vendorHaystack(fwd: ForwardRow): string {
  const { display, domain } = parseSender(fwd.email_from);
  const parts: string[] = [];
  if (fwd.ocr_vendor_name && !/unknown/i.test(fwd.ocr_vendor_name)) parts.push(fwd.ocr_vendor_name);
  if (display) parts.push(display);
  if (domain) parts.push(domain.replace(/\..*$/, "")); // ferti-organic.com → ferti-organic
  if (fwd.email_subject) parts.push(fwd.email_subject);
  return parts.join(" | ");
}

/**
 * Vendor identity WITHOUT the subject line: OCR vendor, sender display, domain root.
 *
 * classifyNoRecord and selectStuckRowsToClose use this instead of vendorHaystack,
 * because a subject that merely MENTIONS a vendor is not evidence about that
 * vendor. Bill's own thread "Re: BuildASoil PO # 125316 - Seacoast Compost" put
 * "seacoast compost" into another forward's haystack, and the reverse sweep then
 * reported SeaCoast as a vendor that flows through Aria.
 */
export function vendorIdentityHaystack(fwd: ForwardRow): string {
  const { display, domain } = parseSender(fwd.email_from);
  const parts: string[] = [];
  if (fwd.ocr_vendor_name && !/unknown/i.test(fwd.ocr_vendor_name)) parts.push(fwd.ocr_vendor_name);
  if (display) parts.push(display);
  if (domain) parts.push(domain.replace(/\..*$/, ""));
  return parts.join(" | ");
}

/**
 * Best invoice identity for a forward, in priority order. The subject wins over
 * OCR for carrier mail (AAA Cooper scans OCR the ACCOUNT number, the subject
 * carries the Pro#; "Invoice# N" subjects beat a PO number OCR picks up).
 */
export function deriveInvoice(fwd: ForwardRow): string {
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
  const proSubj = (fwd.email_subject || "").match(/\bPro#?:?\s*(\d{6,10})\b/i);
  if (proSubj) return proSubj[1];

  // 0.5 Subject explicit "Invoice# N" — authoritative when the subject states the
  //    invoice number but OCR grabs a different number (the PO#).
  const subjInv = (fwd.email_subject || "").match(/\b(?:invoice|inv|facture)\s*[#:._-]*\s*(\d[A-Za-z0-9-]{2,})/i);
  if (subjInv) return subjInv[1];

  // 1. OCR invoice number second (comma-form ok)
  const ocr = (fwd.ocr_invoice_number || "").trim().replace(/,/g, "");
  if (ocr && /[A-Za-z0-9]{4,}/.test(ocr) && !/^unknown$/i.test(ocr)) return ocr;

  // 2. FedEx billing: 9-454-04878 (underscore/dash tolerant boundaries)
  const fedex = hay.match(/(?<![A-Za-z0-9])\d-\d{3}-\d{5}(?![A-Za-z0-9])/);
  if (fedex) return fedex[0];

  // 3. "Invoice 135879" / Inv# / Facture — capture must start with a digit
  const kw = hay.match(/\b(?:invoice|inv|facture|n[ºo])\s*[:#._-]*\s*(\d[A-Za-z0-9-]{2,})/i);
  if (kw) return kw[1];

  // 4. APUS-247215 / INV12928 style alphanumeric ID
  const alpha = hay.match(/(?<![A-Za-z0-9])[A-Z]{2,6}[-_]?\d{4,8}(?![A-Za-z0-9])/i);
  if (alpha) return alpha[0];

  // 5. Bare long digit run (destination 9476798, novelty 41131586)
  const bare = hay.match(/(?<![A-Za-z0-9])\d{5,10}(?![A-Za-z0-9])/);
  if (bare) return bare[0];

  // 6. Filename digit-strip (BAS invoice 8.27.2026.pdf → 8272026)
  const filenameDigits = (fwd.pdf_filename || "").replace(/\D/g, "");
  if (/^\d{5,12}$/.test(filenameDigits)) return filenameDigits;

  return "";
}

// ── Direction 2: bill -> AP record ──────────────────────────────────────────

/**
 * True for FedEx bills (FBO parcel + Freight). Never forwarded to Bill.com by
 * rule (Bill, 2026-09-23) — a missing AP record for one is expected, not a gap.
 */
export function isFedexBill(bill: Pick<RefRow, "vendor_name" | "invoice_number">): boolean {
  if (/fedex|federal express/i.test(bill.vendor_name || "")) return true;
  return /^\d-\d{3}-\d{5}$/.test((bill.invoice_number || "").trim());
}

/**
 * Every AP record that corroborates a bill: same vendor AND (same invoice# OR
 * same amount inside the date window). The amount path is date-bounded because
 * several vendors bill the same amount every cycle (Benny Martinez, $2,450
 * bi-weekly) — an unbounded amount match would silently "explain" a real gap.
 *
 * Matching on invoice# alone is not enough in the other direction either: the
 * forward may carry the invoice number while the cache holds it, or vice versa,
 * so all three sources are consulted.
 */
export function findApRecord(bill: RefRow, facts: AuditFacts): ApEvidence[] {
  const out: ApEvidence[] = [];
  const window = facts.dateWindowDays ?? 10;
  const amt = bill.invoice_amount;
  const billDay = parseDay(bill.invoice_date) ?? parseDay(bill.created_at);
  const vendor = bill.vendor_name || "";

  const push = (source: ApEvidence["source"], detail: string) => {
    out.push({ source, detail });
  };

  for (const f of facts.forwards) {
    if (!vendorsMatch(vendorHaystack(f), vendor)) continue;
    const inv = deriveInvoice(f);
    if (invoicesMatch(inv, bill.invoice_number)) {
      push("forward", `${(f.forwarded_at || "").slice(0, 10)} #${inv || "-"} $${f.ocr_total ?? "?"} ${f.pdf_filename ?? ""}`);
      continue;
    }
    const famt = parseDollars(f.ocr_total);
    if (amt !== null && famt !== null && Math.abs(famt - amt) <= 0.02
      && withinDays(billDay, parseDay(f.forwarded_at), window)) {
      push("forward", `${(f.forwarded_at || "").slice(0, 10)} vendor+amount $${famt.toFixed(2)} ${f.pdf_filename ?? ""}`);
    }
  }

  for (const c of facts.cache) {
    if (!vendorsMatch(c.vendor_name, vendor)) continue;
    if (invoicesMatch(c.invoice_number, bill.invoice_number)) {
      push("invoice_cache", `#${c.invoice_number ?? "-"} $${c.total} ${c.invoice_date ?? ""}`);
      continue;
    }
    if (amt !== null && c.total !== null && Math.abs(c.total - amt) <= 0.02
      && withinDays(billDay, parseDay(c.invoice_date), window)) {
      push("invoice_cache", `vendor+amount $${c.total} ${c.invoice_date ?? ""}`);
    }
  }

  for (const v of facts.vendorInvoices) {
    if (!vendorsMatch(v.vendor_name, vendor)) continue;
    if (invoicesMatch(v.invoice_number, bill.invoice_number)) {
      push("vendor_invoices", `#${v.invoice_number ?? "-"} $${v.total} ${v.invoice_date ?? ""}`);
      continue;
    }
    if (amt !== null && v.total !== null && Math.abs(v.total - amt) <= 0.02
      && withinDays(billDay, parseDay(v.invoice_date), window)) {
      push("vendor_invoices", `vendor+amount $${v.total} ${v.invoice_date ?? ""}`);
    }
  }

  // Dedupe identical evidence lines (a forward and the cache often agree).
  return [...new Map(out.map((e) => [`${e.source}|${e.detail}`, e])).values()];
}

/**
 * Explain a Bill.com bill that has no AP record. The classes are the ones the
 * 2026-10-07 audit established by hand; two of them are worth a human look, the
 * rest are the vendor's normal payment path and should be reported once as a
 * count, not as an exception.
 */
export function classifyNoRecord(bill: RefRow, facts: AuditFacts): NoRecordVerdict {
  const vendor = bill.vendor_name || "";

  if (isFedexBill(bill)) {
    return {
      kind: "FEDEX_RULE",
      actionable: false,
      detail: "FedEx is excluded from Bill.com forwarding by rule (2026-09-23); entered in Bill.com by hand.",
    };
  }

  const vendorForwards = facts.forwards.filter((f) => vendorsMatch(vendorIdentityHaystack(f), vendor));

  const stuck = vendorForwards.filter(
    (f) => !!f.status && !["FORWARDED", "SKIPPED"].includes(f.status)
      && invoicesMatch(deriveInvoice(f), bill.invoice_number),
  );
  if (stuck.length > 0) {
    const s = stuck[0];
    return {
      kind: "STUCK_NEVER_SENT",
      actionable: true,
      detail: `Aria claim row ${s.id} is ${s.status} (${String(s.error_message || "no error message").slice(0, 80)}) — never delivered; re-forward via /apretry if the bill is genuinely new`,
    };
  }

  if (vendorForwards.length > 0) {
    const last = vendorForwards.map((f) => f.forwarded_at || "").sort().pop() || "";
    return {
      kind: "HAND_FORWARDED",
      actionable: false,
      detail: `${vendorForwards.length} forward(s) exist for this vendor (last ${last.slice(0, 10)}); this invoice reached Bill.com outside Aria`,
    };
  }

  const priorBills = facts.ref.filter((r) => vendorsMatch(r.vendor_name, vendor)).length;
  if (priorBills >= 2) {
    return {
      kind: "NO_AP_FORWARDS_EVER",
      actionable: false,
      detail: `${priorBills} prior bills, no forward ever: this vendor bills Bill directly (bill.selee@, paper, or the Bill.com network)`,
    };
  }

  return {
    kind: "NO_VENDOR_HISTORY",
    actionable: true,
    detail: `${priorBills} prior bill(s) and no forward ever: first-time or one-off vendor, confirm the invoice is real and entered correctly`,
  };
}

// ── Direction 2, part 2: close ledger rows whose bill has arrived ───────────

export interface StuckClose {
  id: number;
  invoice: string;
  bill: RefRow;
}

/**
 * Ledger rows sitting in a non-terminal status whose invoice is now a bill in
 * Bill.com. The escalation cron pings on ERROR/CLAIMED/PENDING_SEND rows until
 * something closes them; Bill.com is the source of truth, so an exact
 * vendor+invoice# match there means the ledger row has served its purpose.
 *
 * Deliberately strict: exact-ish invoice# match (never amount-only) so a
 * repeated-amount vendor cannot close the wrong row, and a non-null amount so
 * a placeholder ref row cannot close anything.
 */
export function selectStuckRowsToClose(stuck: ForwardRow[], ref: RefRow[]): StuckClose[] {
  const out: StuckClose[] = [];
  for (const s of stuck) {
    if (!s.status || !["ERROR", "CLAIMED", "PENDING_SEND"].includes(s.status)) continue;
    const inv = deriveInvoice(s);
    if (normInvoice(inv).length < 4) continue;
    const hit = ref.find(
      (r) => r.invoice_amount !== null
        && invoicesMatch(inv, r.invoice_number)
        && vendorsMatch(vendorIdentityHaystack(s), r.vendor_name || ""),
    );
    if (hit) out.push({ id: s.id, invoice: inv, bill: hit });
  }
  return out;
}
