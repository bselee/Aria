/**
 * @file    eow-purchasing-week.ts
 * @purpose Friday purchasing-week PDF: collect, render, email bill.selee@
 * @author  Hermia
 * @created 2026-09-03
 * @deps    finale client, pg, local-db, gmail send-email
 * @env     FINALE_* DATABASE_URL via .env.local
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/eow-purchasing-week.ts
 *   node --env-file=.env.local --import tsx scripts/eow-purchasing-week.ts --send
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { FinaleClient } from "../src/lib/finale/client";
import { getLocalDb } from "../src/lib/storage/local-db";
import { sendGmailPdfEmail } from "../src/lib/gmail/send-email";
import { getAuthenticatedClient } from "../src/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import {
  addDays,
  boxDimKey,
  excludeManualVendor,
  isPartialFromFinaleReceive,
  isStatement,
  keepSilentVendorDelay,
  keepUpcomingAmount,
  lineQtyOf,
  mdFromIso,
  mdFromIsoYearAware,
  fgCoverage,
  fgLabel,
  minRunway,
  mondayOf,
  money,
  needByIso,
  openPricingWins,
  parseVendorDueFromText,
  delayedVendorNote,
  priceVendorName,
  receiverFromStatusHistory,
  researchHit,
  shortPriceNote,
  skuListOf,
  vendorReplyOwnText,
  withQty,
  withinDays,
} from "../src/lib/purchasing/eow-report";
import { formatDelayNote, isOurOwnSender, pickDelaySentence, stripQuotedText } from "../src/lib/purchasing/delay-evidence";
import { computeFreightDrift } from "../src/lib/freight/freight-drift";
import { resolvePoEta } from "../src/lib/purchasing/po-eta";
import { poolCartonGroups } from "../src/lib/purchasing/carton-pooling";
import { loadShipmentSignals } from "../src/lib/purchasing/shipment-signal";
import { leadTimeService } from "../src/lib/builds/lead-time-service";
import { listActiveSnoozes, isItemSnoozed } from "../src/lib/purchasing/snoozes";

const NUMERIC = /^\d+$/;
const TO = "bill.selee@buildasoil.com";

/**
 * Bulk commodities ship by the truckload. A 90-day cover number is meaningless
 * above one truck, so cap the suggested order and state the cap in the note.
 * Bill: "at most we would order one truckload."
 */
const TRUCKLOAD_CAP: Record<string, { qty: number; label: string }> = {
  // Bill, 2026-11-10: a Malibu TL runs about 21 totes / 42,000 lb. Varies, but
  // 42k is the safe ceiling.
  RAWMALIBUCOMPOST: { qty: 42_000, label: "21 totes / 42,000 lb" },
};
/** Dashboard origin. Overridable so the abort path can be exercised in a test. */
const DASH = (process.env.ARIA_DASH_URL || "http://localhost:3001").replace(/\/$/, "");

/** One vendor's row on the Ordering board, as the panel receives it. */
type BoardGroup = { vendorName?: string; vendorPartyId?: string; items?: any[] };

/**
 * Fetch the exact payload the Ordering panel renders.
 *
 * The report must never rebuild the board from `.aria-cache` files. The panel's
 * route applies open-PO crediting, draft guards, carton pooling and the
 * assessment decision before anything reaches the screen; a cache read silently
 * drifts from what the buyer sees (it kept showing items the board had credited
 * and dropped items the board showed as topping up an open PO).
 *
 * @returns The board payload, or null when the dashboard is unreachable.
 */
async function fetchOrderingBoard(): Promise<{ groups: BoardGroup[] } | null> {
  const url = `${DASH}/api/dashboard/purchasing?mode=all`;
  // The dashboard is the source of truth for this list. It may be mid-restart
  // at 10:00 Friday, so retry briefly — but never fall back to the cache files:
  // a report built from stale runway numbers is worse than no report.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      if (!Array.isArray(j?.groups)) throw new Error("payload has no groups");
      console.log(`[eow] ordering board: ${j.groups.length} vendors from ${url}`);
      return { groups: j.groups as BoardGroup[] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[eow] ordering board attempt ${attempt}/3 failed: ${msg}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  return null;
}

/**
 * Mirror of the panel's `lifecycleBucket`. Ordering shows only `need` and
 * `topping`; on-order and held items are deliberately invisible there.
 *
 * @param it Ordering item row.
 * @returns The lifecycle bucket the panel would assign.
 */
function orderingBucket(it: any): "need" | "topping" | "on_order" | "other" {
  const reasons: string[] = it?.assessment?.reasonCodes ?? [];
  if (reasons.includes("on_order_already_covers_need") || reasons.includes("recent_draft_exists")) {
    return "on_order";
  }
  if (it?.draftPO) return "on_order";
  if (it?.assessment?.decision === "order") {
    return (Number(it?.stockOnOrder) || 0) > 0 ? "topping" : "need";
  }
  return "other";
}
/**
 * Fetch the open-PO set the Active Purchases panel renders.
 *
 * Arriving Soon is a delivery schedule, so it must be built from every open PO,
 * not from the subset that happened to be placed this week.
 *
 * @returns Purchase rows, or null when the dashboard is unreachable.
 */
async function fetchActivePurchases(): Promise<any[] | null> {
  const url = `${DASH}/api/dashboard/active-purchases`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      if (!Array.isArray(j?.purchases)) throw new Error("payload has no purchases");
      console.log(`[eow] active purchases: ${j.purchases.length} open POs from ${url}`);
      return j.purchases;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[eow] active purchases attempt ${attempt}/3 failed: ${msg}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  return null;
}

const ARIA = path.resolve(__dirname, "..");
const REPORTS = path.join(ARIA, "reports");

function denverToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

function iso(d: unknown): string {
  if (!d) return "";
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Row = { po: string; vendor: string; amount: number; note: string; sku?: string; eta?: string; status?: string; placed?: string; desc?: string; qty?: string; recvQty?: string; recvVariance?: string; placedIso?: string; plannedReceive?: string; etaIsEstimate?: boolean; etaSource?: string; etaIso?: string; risk?: string; slip?: number; etaAdjusted?: string; fg?: { days: number; rawEquiv: number; items: Array<{ sku: string; qty: number }> } };

/** Shorten a Finale product name for the report. Keeps the product identity
 *  and pack size, drops long brand prefixes and redundant suffix punctuation. */
function abbrevDesc(name: string): string {
  let s = (name || "").trim();
  if (!s) return "";
  s = s.replace(/^BuildASoil\s+/i, "");
  s = s.replace(/^Organics Alive\s+/i, "OA ");
  s = s.replace(/\s*-\s*\(([^)]+)\)\s*$/i, " $1");
  s = s.replace(/\s*:\s*(\d+(?:\.\d+)?)\s*Cubic\s+Foot\b/gi, " $1cf");
  s = s.replace(/\s*:\s*(\d+(?:\.\d+)?)\s*Cubic\s+Yard\b/gi, " $1cy");
  s = s.replace(/\s*:\s*(\d+(?:\.\d+)?)\s*Quarts?\s*$/i, " $1qt");
  s = s.replace(/\s*:\s*(\d+(?:\.\d+)?)\s*(lb|lbs|gal|oz)\s*$/i, " $1$2");
  if (s.length > 32) s = s.slice(0, 31).trimEnd() + "…";
  return s;
}

/** Map a comma-joined SKU list to abbreviated Finale names (same order). */
function descOf(skus: string, map: Map<string, string>): string {
  return (skus || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => map.get(s) || "")
    .filter(Boolean)
    .join(", ");
}

function table(headers: string[], rows: string[][], total?: string[]): string {
  const amtIdx = headers.findIndex((h) => h === "Amount");
  const cell = (c: string, i: number, th = false) => {
    const tag = th ? "th" : "td";
    const cls = i === amtIdx ? ' class="amt"' : "";
    return `<${tag}${cls}>${esc(c)}</${tag}>`;
  };
  const head = headers.map((h, i) => cell(h, i, true)).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => cell(c, i)).join("")}</tr>`)
    .join("\n");
  const tot = total
    ? `<tr class="total-row">${total.map((c, i) => cell(c, i)).join("")}</tr>`
    : "";
  const WIDTHS: Record<string, string> = {
    PO: "po", Vendor: "vendor", SKU: "sku", Description: "desc", Amount: "amt",
    Placed: "note", ETA: "eta", Status: "stat", Received: "note",
    "Vendor Response": "resp", "Needed by": "note", Note: "note",
    Sent: "note", Issue: "note",
    Product: "vendor", "Old to New": "desc", "Est. Savings/Yr": "eta",
    "Received By": "eta", "Recv Qty": "eta", "±": "var",
    Item: "vendor", Detail: "desc", Arrives: "arr", "Covered until": "stock", "FG in stock": "fg",
  };
  const cols = headers.map((h) => `<col class="${WIDTHS[h] || "note"}">`).join("");
  return `<table>
  ${cols}
  <thead><tr>${head}</tr></thead>
  <tbody>
  ${body}
  ${tot}
  </tbody>
</table>`;
}

function invoicesSentSummary(n: number): string {
  // A plain tally, in the words Bill uses. No verdict, no alarm on zero.
  return `<p class="summary">${n} ${n === 1 ? "invoice" : "invoices"} forwarded from the AP inbox this week</p>`;
}

function renderHtml(p: {
  start: string;
  end: string;
  committed: Row[];
  received: Row[];
  delayed: Row[];
  billVerified: Row[];
  issues: Row[];
  upcoming: Row[];
  priceUpdates: Row[];
  research: Row[];
  arriving: Row[];
  arrivingWeek1: Row[];
  arrivingWeek2: Row[];
  followingFriIso: string;
  nextMonIso: string;
  nextFriIso: string;
  todayIso: string;
}): string {
  const sum = (rows: Row[]) => rows.reduce((a, r) => a + (r.amount || 0), 0);
  const todayIso = p.todayIso;
  const md = (iso: string) => mdFromIso(iso);
  // "Next week" is the Mon–Fri after the report week. The team avoids Friday
  // arrivals (thin dock crew), so those are counted in the summary line.
  const nextMon = addDays(p.start, 7);
  const nextFri = addDays(p.start, 11);
  const fridayIso = addDays(nextMon, 4);
  const weekday = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? "" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  };
  const etaSourceLabel = (src?: string): string =>
    src === "delivered" ? "Delivered, await receive"
      : src === "carrier" ? "Tracking"
      : src === "vendor" ? "Vendor confirmed"
      : src === "finale_planned" ? "Vendor plan"
      : src === "lead_time" ? "History"
      : "Default";
  // Arriving rows: a bare date when it is real evidence, "~" when it is
  // estimate-derived. The vendor's slip is already baked into the date, so the
  // team reads one number instead of a date plus an arithmetic prompt.
  const ARRIVE_HEAD = ["PO", "Vendor", "SKU", "Description", "Arrives", "Covered until"];
  const arriveRows = (rows: Row[]) =>
    rows.map((r) => {
      const real = r.etaSource === "delivered" || r.etaSource === "carrier" || r.etaSource === "vendor";
      // One date is the vendor's own expectation; when that vendor's history
      // says it slips, the planning date follows the arrow. Two dates read as a
      // sentence; "11/20 (+4d)" made the team do arithmetic.
      const slipped = r.etaAdjusted && r.etaIso && r.etaAdjusted !== r.etaIso;
      return [
        r.po,
        r.vendor,
        withQty(r.sku || "", r.qty || ""),
        r.desc || "",
        `${real ? "" : "~"}${weekday(r.etaIso || "")} ${mdFromIsoYearAware(r.etaIso || "", todayIso)}${slipped ? ` → ${mdFromIsoYearAware(r.etaAdjusted || "", todayIso)}` : ""}`,
        r.risk || "",
      ];
    });
  const arriveTable = (rows: Row[]) => table(ARRIVE_HEAD, arriveRows(rows));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
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
  .po { width: 8%; } .vendor { width: 14%; } .sku { width: 15%; } .desc { width: 16%; } .amt { width: 10%; text-align: right; white-space: nowrap; }
  th.amt { text-align: right; color: #fff; } .note { width: 9%; } .eta { width: 8%; } .stat { width: 14%; }
  /* Vendor Response carries a quoted sentence — give it the width or it stacks
     five lines tall and pushes the report onto a third page. */
  .resp { width: 30%; } .stock { width: 13%; } .arr { width: 11%; } .fg { width: 14%; }
  .legend { font-size: 7.5pt; color: #6b7280; margin: 2px 0 0; }
  h3 { font-size: 8.5pt; font-weight: 600; margin: 6px 0 2px; color: #374151; page-break-after: avoid; }
  .var { width: 14%; }
  .total-row td { font-weight: 600; background: #eee !important; }
  .keep { page-break-inside: avoid; }
  .foot { font-size: 8pt; color: #666; margin-top: 10px; }
  p.line { margin: 0 0 4px 0; }
  .bill .vendor { width: 34%; }
  .bill .note { width: 50%; }
  .bill .amt { width: 16%; }
</style></head><body>
<h1>Purchasing Week</h1>
<div class="meta">Mon ${md(p.start)} - Fri ${md(p.end)} · BuildASoil · Bill Selee</div>
<div class="keep">
<h2>POs Committed</h2>
<p class="summary">${p.committed.length} POs · ${money(sum(p.committed))}</p>
${table(["PO", "Vendor", "SKU", "Description", "Amount", "Placed", "ETA", "Status"], p.committed.map((r) => [r.po, r.vendor, withQty(r.sku || "", r.qty || ""), r.desc || "", r.amount ? money(r.amount) : "", r.note, (r.etaIsEstimate ? "~" : "") + (r.eta || ""), r.status || ""]), ["", "Total", "", "", money(sum(p.committed)), `${p.committed.length} POs`, "", ""])}
</div>
<div class="keep">
<h2>POs Received</h2>
<p class="summary">${p.received.length} POs · ${money(sum(p.received))}</p>
${table(["PO", "Vendor", "SKU", "Description", "Amount", "Received", "Received By", "Status"], p.received.map((r) => [r.po, r.vendor, withQty(r.sku || "", r.qty || ""), r.desc || "", r.amount ? money(r.amount) : "", r.note, r.status || "", r.recvVariance || ""]), ["", "Total", "", "", money(sum(p.received)), `${p.received.length} POs`, "", ""])}
</div>
<div class="keep">
<h2>POs Delayed</h2>
<p class="summary">${p.delayed.length} POs · ${money(sum(p.delayed))}</p>
${table(["PO", "Vendor", "SKU", "Description", "Amount", "Placed", "Vendor Response"], p.delayed.map((r) => [r.po, r.vendor, withQty(r.sku || "", r.qty || ""), r.desc || "", r.amount ? money(r.amount) : "", r.placed || "", r.note]))}
</div>
<div class="keep">
<h2>Arriving Soon</h2>
<p class="summary">${p.arriving.length} POs over two weeks${p.arriving.filter((r) => r.etaIso === fridayIso).length ? ` · ${p.arriving.filter((r) => r.etaIso === fridayIso).length} on Friday ${md(fridayIso)}` : ""}</p>
${p.arrivingWeek1.length ? `<h3>Next week · Mon ${md(p.nextMonIso)} - Fri ${md(p.nextFriIso)}</h3>${arriveTable(p.arrivingWeek1)}` : ""}
${p.arrivingWeek2.length ? `<h3>Week after · Mon ${md(addDays(p.nextFriIso, 3))} - Fri ${md(p.followingFriIso)}</h3>${arriveTable(p.arrivingWeek2)}` : ""}
</div>
<div class="keep">
<h2>Invoices to Bill.com</h2>
${invoicesSentSummary(p.billVerified.length)}
</div>
<div class="keep">
<h2>Invoice Issues</h2>
${table(["Vendor", "Issue"], p.issues.map((r) => [r.vendor, r.note]))}
</div>
<div class="keep">
<h2>Vendor Price Updates</h2>
${table(["SKU", "Description", "Vendor", "Note"], p.priceUpdates.map((r) => [r.sku || r.po, r.desc || "", r.vendor, r.note]))}
</div>
<div class="keep">
<h2>Upcoming Purchases (Estimated)</h2>
<p class="summary">Next week estimated · ${money(sum(p.upcoming))}</p>
${table(["SKU", "Description", "Vendor", "Needed by", "Amount", "FG in stock", "Note"], p.upcoming.map((r) => [r.qty ? `${r.sku || r.po} ×${r.qty}` : (r.sku || r.po), r.desc || "", r.vendor, mdFromIsoYearAware(r.eta || "", todayIso), r.amount ? money(r.amount) : "", r.fg ? fgLabel(r.fg) : "", r.note]))}
</div>
<div class="keep">
<h2>Research &amp; Pricing Wins</h2>
${table(
  ["SKU", "Item", "Vendor", "Detail", "Est. Savings/Yr", "Status"],
  [
    ...p.research.map((r) => [r.sku || "", r.desc || "", r.vendor, r.note, "", ""]),
    ...openPricingWins().map((w) => [w.sku, w.product, w.vendor, w.detail, w.annual, w.status]),
  ]
)}
</div>
</body></html>`;
}

function hdr(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string {
  return (headers || []).find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";
}

const NEWSLETTER =
  /newsletter|unsubscribe|alibaba|coursera|bubble|grok|vevor|greenhouse|zenport|urban worm|langflow|kleen-rite|mrosupply|tasklet|googleai/i;

async function gmailClient() {
  const auth = await getAuthenticatedClient("default");
  return GmailApi({ version: "v1", auth });
}

const FROM_US = /bill\.selee|buildasoil|noreply@mail\.finale|google calendar|calendar-notification/i;

function gmailPlain(payload: unknown): string {
  const out: string[] = [];
  const walk = (p: unknown) => {
    if (!p || typeof p !== "object") return;
    const rec = p as { body?: { data?: string }; mimeType?: string; parts?: unknown[] };
    if (rec.body?.data) {
      const decoded = Buffer.from(rec.body.data, "base64url").toString("utf8");
      if (rec.mimeType === "text/plain") out.push(decoded);
      else if (rec.mimeType === "text/html") {
        out.push(
          decoded
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
        );
      }
    }
    for (const part of rec.parts || []) walk(part);
  };
  walk(payload);
  return out.join("\n");
}

async function gmailDelayThread(
  gmail: Awaited<ReturnType<typeof gmailClient>>,
  po: string
): Promise<{
  lastVendorIso: string | null;
  emailDueIso: string | null;
  backorder: boolean;
  quote: string | null;
  quoteIso: string | null;
}> {
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `"${po}" -subject:"Purchasing week" -from:calendar-notification`,
    maxResults: 12,
  });

  // Read each message ONCE, in full. The metadata format returned empty header
  // arrays on this mailbox, so every mail looked like a vendor mail and our own
  // "any update?" nudges were quoted as the vendor's answer. `SENT` is the
  // reliable discriminator; the From header is the fallback.
  const vendor: Array<{ iso: string; body: string }> = [];
  for (const m of list.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
    const labels = full.data.labelIds || [];
    const from = hdr(full.data.payload?.headers, "From");
    if (labels.includes("SENT") || isOurOwnSender(from)) continue;
    const ms = Number(full.data.internalDate || 0);
    if (!ms) continue;
    vendor.push({ iso: new Date(ms).toISOString().slice(0, 10), body: gmailPlain(full.data.payload) });
  }
  vendor.sort((a, b) => b.iso.localeCompare(a.iso));

  let quote: string | null = null;
  let quoteIso: string | null = null;
  let quoteScore = -1;
  let emailDueIso: string | null = null;
  let backorder = false;

  // Prefer the sentence that names a date and a commitment ("ETA", "ship date",
  // "backorder") over a passing mention, and only ever quote a sentence that
  // survives `pickDelaySentence` on the vendor's own text.
  const score = (s: string): number => {
    let n = 0;
    if (/\beta\b|ship[- ]date|backorder|back order/i.test(s)) n += 2;
    if (/\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(s)) n += 2;
    if (/\b(arriv|ship|deliver)/i.test(s)) n += 1;
    return n;
  };

  for (const v of vendor) {
    // Only the vendor's own, unquoted text counts as evidence — otherwise our
    // own follow-up questions come back as quotes.
    const bodyOwn = stripQuotedText(v.body);
    const own = vendorReplyOwnText(v.body) || bodyOwn;
    if (!backorder && /backorder|back order/i.test(bodyOwn)) backorder = true;
    const due = parseVendorDueFromText(bodyOwn);
    if (!emailDueIso && due) emailDueIso = due;
    const sentence = pickDelaySentence(own) || pickDelaySentence(bodyOwn);
    if (sentence) {
      const s = score(sentence);
      if (s > quoteScore) {
        quote = sentence;
        quoteIso = v.iso;
        quoteScore = s;
      }
    }
  }

  return {
    lastVendorIso: vendor[0]?.iso ?? null,
    emailDueIso,
    backorder,
    quote,
    quoteIso,
  };
}

async function gmailDigest(
  gmail: Awaited<ReturnType<typeof gmailClient>>,
  after: string
): Promise<{ priceUpdates: Row[]; research: Row[] }> {
  const afterQ = after.replace(/-/g, "/");
  const price: Row[] = [];
  const research: Row[] = [];
  const seen = new Set<string>();
  const q =
    `after:${afterQ} -subject:"Purchasing week" (quote OR quoted OR "price increase" OR "new price" OR "2026 pricing" OR sample OR tote OR "cover crop" OR frass OR soybean OR grove OR "lind marine")`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 25 });
  for (const m of list.data.messages || []) {
    const d = await gmail.users.messages.get({
      userId: "me",
      id: m.id!,
      format: "metadata",
      metadataHeaders: ["From", "Subject"],
    });
    const from = hdr(d.data.payload?.headers, "From");
    const sub = hdr(d.data.payload?.headers, "Subject");
    if (NEWSLETTER.test(from + sub)) continue;
    if (/bill\.selee|buildasoil/i.test(from)) continue;
    const vendor = priceVendorName(from, sub);
    const key = `${vendor}|${sub}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = (d.data.snippet || "").replace(/\s+/g, " ").slice(0, 140);
    const priceNote = shortPriceNote(vendor, sub, snippet);
    const isPrice = /price increase|new price|2026 pricing|raised|FM104 raised|WDG101 2026|Processed frass/i.test(
      sub + snippet + priceNote
    );
    if (isPrice) {
      if (seen.has(`note:${priceNote}`)) continue;
      seen.add(`note:${priceNote}`);
      const sku = /^(FM104|WDG101|CFR101)/.test(priceNote) ? priceNote.slice(0, 6).trim() : "";
      price.push({ po: "", vendor, amount: 0, note: priceNote, sku });
    } else {
      const hit = researchHit(from, sub, snippet);
      if (!hit) continue;
      if (seen.has(`research:${hit.vendor}`)) continue;
      seen.add(`research:${hit.vendor}`);
      research.push({ po: "", vendor: hit.vendor, amount: 0, note: hit.note, sku: hit.sku });
    }
    if (price.length >= 4 && research.length >= 6) break;
  }
  return { priceUpdates: price.slice(0, 4), research: research.slice(0, 6) };
}

function chromePdf(htmlPath: string, pdfPath: string) {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const r = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`chrome pdf failed: ${r.stderr || r.stdout || r.status}`);
  }
}

async function main() {
  const send = process.argv.includes("--send");
  const weekArg = process.argv.find((a) => a.startsWith("--week="))?.slice(7);
  const today = denverToday();
  const start = mondayOf(weekArg || today);
  const friday = addDays(start, 4);
  const end = weekArg ? friday : today < friday ? today : friday;
  const receiptEnd = addDays(end, 1);

  const finale = new FinaleClient();
  const pos = await finale.getRecentPurchaseOrders(14, 500);
  let committed: Row[] = pos
    .filter((p) => {
      const d = iso(p.orderDate);
      return d >= start && d <= end && NUMERIC.test(p.orderId) && !/cancel/i.test(p.status || "");
    })
    .sort((a, b) => {
      const da = iso(a.orderDate);
      const db = iso(b.orderDate);
      if (da !== db) return da.localeCompare(db);
      return Number(a.orderId) - Number(b.orderId);
    })
    .map((p) => {
      const d = iso(p.orderDate);
      const placed = d.length >= 10 ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : d;
      return {
        po: p.orderId,
        vendor: p.vendorName || "",
        sku: skuListOf(p.items),
        qty: lineQtyOf(p.items),
        amount: Number(p.total) || 0,
        note: placed,
        placedIso: d,
        plannedReceive: iso(p.receiveDate) || undefined,
      };
    });

  const receivedRaw = await finale.getTodaysReceivedPOs(start, receiptEnd);
  const receivedIds = (receivedRaw || [])
    .filter((p: any) => NUMERIC.test(String(p.orderId || "")))
    .map((p: any) => ({
      po: String(p.orderId),
      amount: Number(p.total) || 0,
      receiveDate: String(p.receiveDate || ""),
    }));

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL || "postgresql://aria:***@localhost:5432/aria",
  });

  // SKU -> abbreviated Finale product name, for the Description column.
  const skuDesc = new Map<string, string>();
  try {
    const q = await pool.query(
      `SELECT sku, raw_detail->>'name' AS name FROM finale_sku_cache`
    );
    for (const r of q.rows) {
      const n = abbrevDesc(String(r.name || ""));
      if (r.sku && n) skuDesc.set(String(r.sku), n);
    }
  } catch {
    /* desc optional */
  }

  const recvLookup = await pool.query(
    `SELECT po_number, vendor_name, line_items FROM purchase_orders WHERE po_number = ANY($1)`,
    [receivedIds.map((r) => r.po)]
  );
  const recvByPo = new Map<string, any>(recvLookup.rows.map((r: any) => [r.po_number, r]));
  receivedIds.sort((a, b) => {
    if (a.receiveDate !== b.receiveDate) return a.receiveDate.localeCompare(b.receiveDate);
    return Number(a.po) - Number(b.po);
  });
  const received: Row[] = receivedIds.map((r) => {
    const row = recvByPo.get(r.po);
    return {
      po: r.po,
      vendor: row?.vendor_name || "",
      sku: skuListOf(row?.line_items),
      qty: lineQtyOf(row?.line_items),
      amount: r.amount,
      note: r.receiveDate.includes("/")
        ? r.receiveDate.replace(/^(\d{1,2})\/(\d{1,2}).*/, (_, a, b) => `${Number(a)}/${Number(b)}`)
        : mdFromIso(iso(r.receiveDate)),
    };
  });

  const receivedPo = new Set(received.map((r) => r.po));
  committed = committed.filter((r) => !receivedPo.has(r.po));

  // Received By: Finale shipment statusIdHistoryList carries the user who
  // flipped the shipment to SHIPMENT_DELIVERED. ~2 extra Finale calls per
  // received PO, once a week at 10am Friday — inside rate-limit discipline.
  for (const r of received) {
    try {
      const q = {
        query: `{ orderViewConnection(first: 1, type: ["PURCHASE_ORDER"], orderId: "${r.po}") {
          edges { node { shipmentList { shipmentUrl status receiveDate } } } } }`,
      };
      const data = await (finale as any).graphql(q, "eow receivedBy");
      const ships = data?.orderViewConnection?.edges?.[0]?.node?.shipmentList || [];
      const names = new Set<string>();
      const recvBySku = new Map<string, number>();
      for (const s of ships) {
        if (!s?.shipmentUrl) continue;
        if (s?.status && !/received|delivered/i.test(String(s.status))) continue;
        const detail = await (finale as any).get(s.shipmentUrl);
        const n = receiverFromStatusHistory(detail?.statusIdHistoryList);
        if (n) names.add(n);
        for (const line of detail?.shipmentItemList || []) {
          const pid = String(line?.productId || "");
          const qty = Number(line?.quantity);
          if (pid && Number.isFinite(qty) && qty > 0) {
            recvBySku.set(pid, (recvBySku.get(pid) || 0) + qty);
          }
        }
      }
      r.status = [...names].join(", ");
      // Only surface quantity differences — a matching line needs no ink.
      // On multi-SKU POs, name the SKU: a bare "-2" doesn't say which line.
      if (recvBySku.size > 0) {
        const orderedIds = (r.sku || "").split(",").map((s) => s.trim()).filter(Boolean);
        const orderedQs = (r.qty || "").split(",").map((s) => s.trim());
        const multi = orderedIds.length > 1;
        const diffs: Array<{ sku: string; d: number; missing: boolean }> = [];
        orderedIds.forEach((id, i) => {
          const ordered = Number(orderedQs[i]);
          if (!Number.isFinite(ordered) || ordered <= 0) return;
          const got = recvBySku.get(id) ?? 0;
          const d = got - ordered;
          if (d !== 0) diffs.push({ sku: id, d, missing: got === 0 });
        });
        r.recvVariance =
          diffs.length === 0
            ? "Complete"
            : diffs
                .map((x) => {
                  if (x.missing) {
                    const n = Math.abs(x.d);
                    return multi ? `${x.sku} (${n}) missing` : `(${n}) missing`;
                  }
                  const signed = `${x.d > 0 ? "+" : ""}${x.d}`;
                  return multi ? `${x.sku} ${signed}` : signed;
                })
                .join(", ");
      }
    } catch {
      /* receiver optional — never block the PDF */
    }
  }
  const recvResolved = received.filter((r) => r.status).length;
  console.log(`receivedBy resolved ${recvResolved}/${received.length}`);

  // Freight drift (booked vs actual): annotate the received PO's own line in
  // place — no separate section. Only POs on the week's received list get the
  // note, so the reader sees the reweigh delta exactly where the PO already is.
  try {
    const { fetchFinalFreightInvoices } = await import("../src/lib/freight/freight-drift");
    const inbound = await fetchFinalFreightInvoices();
    const rows = await computeFreightDrift(inbound, 5);
    const driftByPo = new Map(rows.filter((r) => r.poNumber).map((r) => [r.poNumber, r]));
    for (const r of received) {
      const d = driftByPo.get(r.po);
      if (!d) continue;
      const sign = d.drift >= 0 ? "+" : "";
      r.note = `${r.note} · freight ${sign}$${d.drift.toFixed(2)}`;
    }
  } catch {
    /* drift optional — never block the EOW PDF */
  }

  if (committed.length) {
    const meta = await pool.query(
      `SELECT po_number, lifecycle_stage, vendor_acknowledged_at, po_sent_verified_at,
              tracking_status_summary, vendor_stated_eta, receive_date
       FROM purchase_orders WHERE po_number = ANY($1)`,
      [committed.map((r) => r.po)]
    );
    const byPo = new Map<string, any>(meta.rows.map((row: any) => [row.po_number, row]));

    // Real movement evidence: carrier ETA or delivery scan per PO, resolved
    // across the PO's own tracking numbers as well as shipments.po_numbers.
    let shipByPo = new Map<string, { deliveredAt: string | null; carrierEta: string | null }>();
    try {
      shipByPo = await loadShipmentSignals(committed.map((r) => r.po), today);
    } catch {
      /* tracking optional — never block the report */
    }

    for (const r of committed) {
      const m = byPo.get(r.po);
      const life = String(m?.lifecycle_stage || "").toUpperCase();
      if (/RECEIVED|COMPLETED/.test(life)) r.status = "Received";
      else if (m?.tracking_status_summary) r.status = "In Transit";
      else if (m?.vendor_acknowledged_at) r.status = "Acknowledged";
      else r.status = "Sent";
      // ETA — same shared resolution the Active Purchases dashboard uses.
      // Order: carrier scan → carrier ETA → vendor email → Finale planned →
      // lead time from the PO date. Real tracking always wins.
      const ship = shipByPo.get(r.po);
      const eta = await resolvePoEta({
        vendorName: r.vendor,
        orderDate: r.placedIso,
        plannedReceiveDate: r.plannedReceive,
        vendorStatedEta: iso(m?.vendor_stated_eta),
        shipment: ship
          ? { deliveredAt: ship.deliveredAt, estimatedDeliveryAt: ship.carrierEta }
          : null,
        today,
      });
      r.eta = mdFromIso(eta.date);
      r.etaIso = eta.date;
      r.etaIsEstimate = eta.provenance === "lead_time" || eta.provenance === "fallback";
      r.etaSource = eta.provenance;
    }
  }

  const delayedQ = await pool.query(`
    SELECT po_number, vendor_name, COALESCE(total_amount,total,0)::float AS amount,
           required_date, receive_date, status, lifecycle_stage, line_items, vendor_stated_eta, issue_date
    FROM purchase_orders
    WHERE po_number ~ '^[0-9]+$'
      AND COALESCE(status,'') = 'open'
      AND COALESCE(vendor_name,'') !~* 'amazon|autopot|printful|dropship|evergreen|uline|axiom'
      AND COALESCE(lifecycle_stage,'') NOT ILIKE '%cancel%'
      AND COALESCE(lifecycle_stage,'') NOT IN ('COMPLETED','INVOICED')
      AND (
        (receive_date IS NULL AND required_date IS NOT NULL AND required_date::date < CURRENT_DATE)
        OR (vendor_stated_eta IS NOT NULL AND vendor_stated_eta::date < CURRENT_DATE)
        OR (issue_date IS NOT NULL AND issue_date::date < CURRENT_DATE - 45)
      )
    ORDER BY COALESCE(vendor_stated_eta, required_date) ASC
    LIMIT 20
  `);
  // One board, one dataset. Fetch it before anything reads runway so every
  // number below is the one the Ordering screen renders, not last night's cache.
  const board = await fetchOrderingBoard();
  if (!board) {
    console.error(
      "[eow] ABORT: the Ordering board is unreachable. Refusing to emit a report whose order list is not the board's."
    );
    process.exit(1);
  }
  const skuRunway = new Map<string, { combined: number; raw: number; fg: number | null }>();
  try {
    if (board) {
      for (const g of board.groups) {
        for (const it of g.items || []) {
          const id = String(it.productId || "");
          if (!id || skuRunway.has(id)) continue;
          const combined = Number(it.adjustedRunwayDays ?? it.runwayDays);
          if (!Number.isFinite(combined)) continue;
          const cov = fgCoverage(it.feedsFinishedGoods, Number(it.dailyRate));
          skuRunway.set(id, {
            combined,
            raw: Number.isFinite(Number(it.runwayDays)) ? Number(it.runwayDays) : combined,
            fg: cov ? cov.days : null,
          });
        }
      }
    }
    // Same two caches the purchasing panel renders. `api-bust.json` is a stale
    // debug snapshot with different runway numbers — reading it here made the
    // report's Covered-until disagree with the ordering dashboard for the very
    // same SKU (CEN102: 175d here vs 67d on the board).
    for (const name of ["purchasing-resale.json", "purchasing-bom.json"]) {
      const p = path.join(ARIA, ".aria-cache", "purchasing", name);
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const walk = (x: unknown) => {
        if (!x) return;
        if (Array.isArray(x)) {
          x.forEach(walk);
          return;
        }
        if (typeof x === "object") {
          const o = x as Record<string, unknown>;
          const id = String(o.productId || o.sku || "");
          const rw = Number(o.adjustedRunwayDays ?? o.runwayDays);
          const rawOnly = Number(o.runwayDays);
          const daily = Number(o.dailyRate);
          // Raw components feed finished goods that are already packed and on
          // the shelf. That shelf is real supply, so show its own date next to
          // the raw one instead of blending them into a single number nobody
          // can take apart.
          let fgDays: number | null = null;
          if (Array.isArray(o.feedsFinishedGoods) && o.feedsFinishedGoods.length > 0 && daily > 0) {
            const fgRawEquiv = (o.feedsFinishedGoods as any[]).reduce(
              (s, f) => s + (Number(f?.stockOnHand) || 0) * (Number(f?.qtyPerUnit) || 0),
              0
            );
            if (fgRawEquiv > 0) fgDays = fgRawEquiv / daily;
          }
          if (id && Number.isFinite(rw) && !skuRunway.has(id)) {
            skuRunway.set(id, {
              combined: rw,
              raw: Number.isFinite(rawOnly) ? rawOnly : rw,
              fg: fgDays,
            });
          }
          for (const k of ["value", "items", "groups"]) walk(o[k]);
        }
      };
      walk(raw);
    }
  } catch {
    /* cache optional */
  }
  const delayedRows = delayedQ.rows.filter((r) => !receivedPo.has(String(r.po_number)));
  const delayed: Row[] = [];
  for (const r of delayedRows) {
    const eta = iso(r.vendor_stated_eta);
    const skus = skuListOf(r.line_items);
    const rw = minRunway(
      skus.split(",").map((s) => skuRunway.get(s.trim())?.combined)
    );
    if (!keepSilentVendorDelay(r.vendor_name || "", rw)) continue;
    if (!eta) {
      try {
        const d = await finale.getOrderDetails(String(r.po_number));
        const recv = iso((d as { receiveDate?: unknown }).receiveDate);
        if (isPartialFromFinaleReceive(null, recv || null, today)) continue;
      } catch {
        /* Finale optional */
      }
    }
    delayed.push({
      po: r.po_number,
      vendor: r.vendor_name || "",
      sku: skus,
      qty: lineQtyOf(r.line_items),
      amount: Number(r.amount) || 0,
      note: eta ? `Vendor ETA ${mdFromIso(eta)}` : "No update from vendor",
      eta,
      placed: mdFromIso(iso(r.issue_date)),
    });
  }

  // Invoice issues intentionally empty this week; section header stays.
  const issues: Row[] = [];

  const invWeekQ = await pool.query(`
    SELECT vendor_name, invoice_number, total::float AS total, po_number
    FROM vendor_invoices
    WHERE created_at >= $1::timestamptz
      AND created_at < ($2::date + interval '1 day')
    ORDER BY created_at DESC
    LIMIT 80
  `, [`${start}T00:00:00-06:00`, end]);

  const invByNum = new Map<string, { vendor: string; total: number; po: string }>();
  for (const r of invWeekQ.rows) {
    const key = String(r.invoice_number || "").replace(/\s+/g, "");
    if (key) invByNum.set(key.toLowerCase(), {
      vendor: r.vendor_name || "",
      total: Number(r.total) || 0,
      po: r.po_number && /^\d+$/.test(r.po_number) ? r.po_number : "",
    });
  }

  let billVerified: Row[] = [];
  try {
    const sqlite = getLocalDb();
    const fwds = sqlite
      .prepare(
        `SELECT email_from, email_subject, pdf_filename, matched_po_number, ocr_total
         FROM ap_local_forwards
         WHERE status='FORWARDED' AND forwarded_at >= ? AND forwarded_at < ?
         ORDER BY forwarded_at DESC`
      )
      .all(`${start} 00:00:00`, `${receiptEnd} 00:00:00`) as Array<{
        email_from: string;
        email_subject: string;
        pdf_filename: string;
        matched_po_number: string | null;
        ocr_total: string | null;
      }>;
    const seen = new Set<string>();
    for (const f of fwds) {
      const blob = `${f.pdf_filename || ""} ${f.email_subject || ""}`;
      if (/^image\.pdf$/i.test(f.pdf_filename || "")) continue;
      if (/photo|rsimage|receipt/i.test(blob)) continue;
      if (isStatement(f.email_from || "", f.email_subject || "", f.pdf_filename || "")) continue;
      const invMatch = blob.match(/(?:inv(?:oice)?[#_:\s-]*)?([A-Z]{0,6}-?\d{5,}|\d{5,}|9-\d{3}-\d{5}|APUS-?\d+)/i);
      const inv = (invMatch?.[1] || "").replace(/^APUS(\d)/i, "APUS-$1");
      const key = (inv || f.pdf_filename || blob).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = inv ? invByNum.get(inv.toLowerCase()) : undefined;
      const poRaw = f.matched_po_number || hit?.po || "";
      const po = /^\d+$/.test(poRaw) ? poRaw : "";
      let vendor = hit?.vendor || "";
      if (!vendor) {
        const from = (f.email_from || "").toLowerCase();
        if (from.includes("uline")) vendor = "Uline";
        else if (from.includes("aaa") || from.includes("cooper")) vendor = "AAA Cooper";
        else if (from.includes("fedex")) vendor = blob.toLowerCase().includes("express") ? "FedEx Express" : "FedEx Ground";
        else if (from.includes("marion")) vendor = "Marion Ag";
        else if (from.includes("autopot")) vendor = "AutoPot";
        else if (from.includes("evergreen")) vendor = "Evergreen";
        else if (from.includes("novelty")) vendor = "Novelty";
        else if (from.includes("wagner")) vendor = "Wagner";
        else if (from.includes("berger")) vendor = "Berger";
        else vendor = (f.email_from || "").replace(/.*<|>.*/g, "").slice(0, 40);
      }
      const ocrAmt = Number(f.ocr_total);
      billVerified.push({
        po,
        vendor,
        amount: Number.isFinite(ocrAmt) && ocrAmt > 0 ? ocrAmt : 0,
        note: inv || (f.pdf_filename || "").replace(/\.pdf$/i, ""),
      });
    }
  } catch (e: unknown) {
    // Never swallow this: a silent fallback is how the tally read "0 invoices
    // sent" while 5 had in fact been forwarded.
    console.warn(
      "[eow] AP forward tally failed, falling back to invoice week query:",
      e instanceof Error ? e.message : String(e),
    );
    billVerified = invWeekQ.rows.map((r) => ({
      po: r.po_number && /^\d+$/.test(r.po_number) ? r.po_number : "",
      vendor: r.vendor_name || "",
      amount: Number(r.total) || 0,
      note: r.invoice_number || "",
    }));
  }

  // Vendor MOQ floors (vendor_reorder_policies.standard_order_qty).
  const standardOrderQty = new Map<string, number>();
  try {
    const sq = await pool.query(
      `SELECT vendor_name, standard_order_qty FROM vendor_reorder_policies WHERE standard_order_qty IS NOT NULL`
    );
    for (const r of sq.rows) {
      const n = Number(r.standard_order_qty);
      if (r.vendor_name && Number.isFinite(n) && n > 0) {
        standardOrderQty.set(String(r.vendor_name).trim().toLowerCase(), n);
      }
    }
  } catch {
    /* moq optional */
  }

  // Cartons are the same physical size under different vendor SKUs (Uline
  // `S-`, SP USA `SP-`, internal `BOX` builds). Judge them by pooled stock on
  // hand for the size, never SKU by SKU, or we re-buy a box we already have.
  const skuName = new Map<string, string>();
  try {
    const nr = await pool.query(
      `SELECT sku, raw_detail->>'name' AS name FROM finale_sku_cache WHERE raw_detail->>'name' IS NOT NULL`
    );
    for (const r of nr.rows) skuName.set(String(r.sku), String(r.name));
  } catch {
    /* cache optional */
  }

  const upcoming: Row[] = [];
  try {
    const seen = new Set<string>();
    const seenDims = new Set<string>();
    // The ordering window ends with NEXT week, not seven days from whenever the
    // script happens to run. On a Friday run both are the same day; generating a
    // sample mid-week used to cut the window short and hide items due next week.
    const weekOut = addDays(start, 11);

    // The dashboard pools each slot separately (resale, then BOM), so the
    // report must do the same — pooling both files together would sum the same
    // SKU's rate twice and invent a shortage. Same helper, same inputs.
    const cartonNames = Array.from(skuName, ([sku, name]) => ({ sku, name })).filter(
      (c) => boxDimKey(c.name)
    );
    const stockMemo = new Map<string, number | null>();
    // Anything snoozed in the purchasing panel is hidden there, so it has no
    // business appearing here. Same keys the panel writes.
    const activeSnoozes = listActiveSnoozes();
    const feeds: Array<{ vendor: string; it: any }> = [];
    if (board) {
      // One dataset: exactly the rows the Ordering screen renders.
      for (const g of board.groups) {
        for (const it of g.items || []) {
          feeds.push({ vendor: g.vendorName || it.supplierName || "", it });
        }
      }
    } else for (const name of ["purchasing-resale.json", "purchasing-bom.json"]) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(ARIA, ".aria-cache", "purchasing", name), "utf8")
      );
      const groups = (raw.value || []) as any[];
      const pooledGroups =
        cartonNames.length > 0
          ? (
              await poolCartonGroups(groups as any, {
                cartonNames,
                stockFor: async (s) => {
                  if (stockMemo.has(s)) return stockMemo.get(s) ?? null;
                  let v: number | null = null;
                  try {
                    v = (await finale.getStockLevel(s)) as number | null;
                  } catch {
                    v = null;
                  }
                  stockMemo.set(s, v);
                  return v;
                },
              })
            ).groups
          : groups;
      for (const g of pooledGroups) {
        for (const it of g.items || []) {
          feeds.push({ vendor: g.vendorName || it.supplierName || "", it });
        }
      }
    }

    for (const { vendor, it } of feeds) {
      // Same gate the panel uses: Ordering shows need and topping only.
      if (board) {
        const bucket = orderingBucket(it);
        if (bucket !== "need" && bucket !== "topping") continue;
      }
      // Same quantity the panel puts in the box: the assessment's recommended
      // qty, falling back to suggestedQty. Anything else is a second opinion.
      const qty0 = board
        ? Number(it.assessment?.recommendedQty ?? it.suggestedQty ?? 0) || 0
        : Number(it.suggestedQty) || 0;
      // Cache fallback has no assessment, so keep the old on-order skip there.
      if (!board && (Number(it.stockOnOrder) || 0) > 0) continue;
      const rw = it.adjustedRunwayDays ?? it.runwayDays;
      if (qty0 <= 0) continue;
      if (rw == null) continue;
      const sku = String(it.productId || "");
      if (!sku || seen.has(sku)) continue;
      if (excludeManualVendor(vendor, sku)) continue;
      if (isItemSnoozed(sku, it.supplierPartyId || null, activeSnoozes)) continue;

      const dimKey = boxDimKey(it.productName || skuName.get(sku) || "");
      if (dimKey && seenDims.has(dimKey)) continue;

      const lead = Number(it.effectiveLeadTimeDays ?? it.leadTimeDays ?? 21) || 21;
      // Runway already reflects pooled on-hand for this carton size.
      const runwayDays = Number(rw) || 0;
      const need = needByIso(today, runwayDays);
      // "Next week" means anything that must be ORDERED in the coming week
      // to land in time. Long-lead items (CWP, quillaja) surface early;
      // short-lead items surface late. Not a flat wish list.
      const mustOrder = addDays(need, -lead);
      if (mustOrder > weekOut) {
        // Do NOT reserve the carton dimension here: an out-of-window sibling
        // would then block a same-size box that IS due, silently hiding it.
        continue;
      }

      let orderQty = qty0;
      let moq: number | null = null;
      const floor = standardOrderQty.get(vendor.trim().toLowerCase());
      if (floor && orderQty < floor) {
        orderQty = floor;
        moq = floor;
      }
      const cap = TRUCKLOAD_CAP[sku];
      let capped = false;
      if (cap) {
        // A truckload is a ceiling on what sits in the yard, not just on what
        // we add. Half a truck already on hand means room for half a truck.
        const onHand = Number(it.stockOnHand) || 0;
        const room = Math.max(0, cap.qty - onHand);
        if (orderQty > room) {
          orderQty = room;
          capped = true;
        }
        if (orderQty <= 0) continue;
      }
      const amt = orderQty * (it.unitPrice || 0);
      if (!keepUpcomingAmount(amt)) continue;

      const flags: string[] = [];
      if (capped && cap) {
        const onHand = Number(it.stockOnHand) || 0;
        flags.push(`topped up to 1 truckload · ${cap.label} (${onHand.toLocaleString("en-US")} on hand)`);
      }
      if (lead >= 30) flags.push(`${lead}d lead`);
      if (amt >= 2000) flags.push("Large");
      if (moq) flags.push(`MOQ ${moq.toLocaleString("en-US")}`);
      if (runwayDays <= 0) flags.push("Out now");

      seen.add(sku);
      if (dimKey) seenDims.add(dimKey);
      // Raw components only: packed finished goods already in stock are real
      // cover, and the team forgets to count them. Days come from the board's
      // own metric when it has one, so the report and the panel never disagree.
      const cov = fgCoverage(it.feedsFinishedGoods, Number(it.dailyRate));
      const engineFgDays = Number(it.assessment?.metrics?.finishedGoodsCoverageDays);
      const fg = cov
        ? {
            ...cov,
            days: Number.isFinite(engineFgDays) && engineFgDays > 0 ? engineFgDays : cov.days,
          }
        : undefined;
      upcoming.push({
        po: sku,
        vendor,
        sku,
        qty: Number(orderQty).toLocaleString("en-US"),
        amount: amt,
        note: flags.join(" · "),
        eta: need,
        fg,
      });
    }
    upcoming.sort((a, b) => (a.eta || "").localeCompare(b.eta || ""));
  } catch {
    /* cache optional */
  }

  const skuUse = new Map<string, "build" | "combo" | "resale">();
  try {
    for (const name of ["purchasing-bom.json", "purchasing-resale.json"]) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(ARIA, ".aria-cache", "purchasing", name), "utf8")
      );
      const fromBom = name.includes("bom");
      for (const g of raw.value || []) {
        for (const it of g.items || []) {
          const sku = it.productId;
          if (!sku) continue;
          const t = String(it.itemType || "");
          let use: "build" | "combo" | "resale" = "resale";
          if (t === "bom-component") use = "build";
          else if (t === "resale-bom") use = "combo";
          else if (fromBom && it.feedsFinishedGoods?.length) use = "build";
          const prev = skuUse.get(sku);
          if (prev && prev !== use) skuUse.set(sku, "combo");
          else if (!prev) skuUse.set(sku, use);
        }
      }
    }
  } catch {
    /* cache optional */
  }

  let priceUpdates: Row[] = [];
  let research: Row[] = [];
  try {
    const gmail = await gmailClient();
    for (const r of delayed) {
      const thread = await gmailDelayThread(gmail, r.po);
      // The note must be the vendor's own words with the mail date. Never say
      // "no reply" — that was wrong on every delayed PO checked, and when the
      // thread carries no delay language we cite the last vendor email instead
      // of asserting silence.
      r.note =
        thread.quote && thread.quoteIso
          ? formatDelayNote(thread.quote, thread.quoteIso)
          : thread.lastVendorIso
            ? `No delay stated; last vendor email ${mdFromIso(thread.lastVendorIso)}`
            : "No vendor email on this PO";
      if (thread.emailDueIso && thread.emailDueIso !== r.eta) {
        try {
          await pool.query(
            `UPDATE purchase_orders
             SET vendor_stated_eta = $1::date,
                 vendor_stated_eta_confidence = 'high',
                 vendor_stated_eta_extracted_at = NOW(),
                 vendor_stated_eta_rationale = $2
             WHERE po_number = $3
               AND (vendor_stated_eta IS NULL OR vendor_stated_eta::date IS DISTINCT FROM $1::date)`,
            [thread.emailDueIso, `Gmail delayed assess: ${r.note}`, r.po]
          );
        } catch (e) {
          console.error("delayed eta persist", r.po, e instanceof Error ? e.message : e);
        }
        r.eta = thread.emailDueIso;
      }
    }
    const digest = await gmailDigest(gmail, addDays(today, -14));
    priceUpdates = digest.priceUpdates;
    research = digest.research;
  } catch {
    /* gmail optional */
  }
  for (const r of [...committed, ...received, ...delayed, ...upcoming, ...priceUpdates, ...research]) {
    r.desc = descOf(r.sku || "", skuDesc);
  }
  await pool.end();

  // "Arriving soon" — open POs whose resolved ETA lands in the two weeks after
  // the report week. Dates are adjusted to the vendor's own p90 arrival before
  // they are bucketed, so the team plans against the date these vendors
  // actually hit, not the optimistic one.
  const nextMonIso = addDays(start, 7);
  const nextFriIso = addDays(start, 11);
  const followingFriIso = addDays(start, 18);

  // Vendor slip: p90 − p50 from that vendor's own delivery history.
  const slipByVendor = new Map<string, number>();
  for (const v of Array.from(new Set(committed.map((r) => r.vendor)))) {
    const dist = await leadTimeService.getDistribution(v).catch(() => null);
    if (dist && dist.p90 > dist.p50) slipByVendor.set(v, dist.p90 - dist.p50);
  }

  const isRealEta = (source?: string) =>
    source === "delivered" || source === "carrier" || source === "vendor";

  const apRows = await fetchActivePurchases();
  if (!apRows) {
    console.error(
      "[eow] ABORT: Active Purchases is unreachable. Refusing to emit a delivery schedule that is not the panel's."
    );
    process.exit(1);
  }
  const arriving = (apRows
    ? apRows
        .filter(
          (p: any) =>
            !p.isReceived && String(p.completionState || "").toLowerCase() !== "received"
        )
        .map((p: any): Row | null => {
          const items = Array.isArray(p.items) ? p.items : [];
          const open = items.filter((i: any) => Number(i.remainingQty ?? i.quantity ?? 0) > 0);
          const etaIso = String(p.expectedDate || "").slice(0, 10);
          if (open.length === 0 || !etaIso) return null;
          const prov = String(p.leadProvenance || "");
          // The board's date already carries the vendor's slip, so it is shown
          // as one date. "~" only disappears when the date is real movement.
          const realEta = /carrier|delivered|vendor stated/i.test(prov);
          return {
            po: String(p.orderId),
            vendor: String(p.vendorName || ""),
            sku: open.map((i: any) => String(i.productId || "")).join(", "),
            amount: Number(p.total) || 0,
            note: "",
            etaIso,
            etaAdjusted: etaIso,
            etaSource: realEta ? "carrier" : "finale_planned",
          };
        })
        .filter((r): r is Row => Boolean(r))
    : committed.map((r) => {
        const slip = slipByVendor.get(r.vendor) ?? 0;
        const etaAdjusted = !isRealEta(r.etaSource) && slip > 0 && r.etaIso
          ? addDays(r.etaIso, slip)
          : r.etaIso;
        return { ...r, etaAdjusted };
      }))
    .filter((r) => r.etaIso && r.etaIso >= nextMonIso && r.etaIso <= followingFriIso)
    .sort((a, b) => String(a.etaIso).localeCompare(String(b.etaIso)))
    .map((r) => {
      // Descriptions come from Finale's name map, same as every other section.
      r.desc = r.desc || descOf(r.sku || "", skuDesc);
      // Does the SKU run out before this delivery lands? That is the question
      // the list exists to answer — a date alone does not tell the team whether
      // they are covered. Phrase it as a date someone can act on, not a grade.
      const skus = (r.sku || "").split(",").map((s) => s.trim()).filter(Boolean);
      const rows = skus
        .map((s) => skuRunway.get(s))
        .filter((x): x is { combined: number; raw: number; fg: number | null } => Boolean(x));
      if (rows.length === 0 || !r.etaIso) return { ...r, risk: "" };
      const soonest = (pick: (x: { combined: number; raw: number; fg: number | null }) => number) =>
        addDays(today, Math.floor(Math.min(...rows.map(pick))));
      const stockoutIso = soonest((x) => x.combined);
      // Header already says "Covered until", so the positive cell is just the
      // date. The negative case must say so plainly.
      const risk = stockoutIso >= r.etaIso
        ? mdFromIsoYearAware(stockoutIso, today)
        : `Out ${mdFromIsoYearAware(stockoutIso, today)}`;
      return { ...r, risk };
    });

  const arrivingWeek1 = arriving.filter((r) => String(r.etaIso) <= nextFriIso);
  const arrivingWeek2 = arriving.filter((r) => String(r.etaIso) > nextFriIso);

  const html = renderHtml({
    start,
    end,
    committed,
    received,
    delayed,
    billVerified,
    issues,
    upcoming: upcoming.slice(0, 12),
    priceUpdates,
    research,
    arriving,
    arrivingWeek1,
    arrivingWeek2,
    followingFriIso,
    nextMonIso,
    nextFriIso,
    todayIso: today,
  });

  fs.mkdirSync(REPORTS, { recursive: true });
  const stem = `eow-purchasing-${start}`;
  const htmlPath = path.join(REPORTS, `${stem}.html`);
  const pdfPath = path.join(REPORTS, `${stem}.pdf`);
  fs.writeFileSync(htmlPath, html);
  chromePdf(htmlPath, pdfPath);
  console.log(`WROTE ${pdfPath}`);
  console.log(`committed ${committed.length} ${money(committed.reduce((a, r) => a + r.amount, 0))}`);
  console.log(`received ${received.length} delayed ${delayed.length}`);

  if (send) {
    const res = await sendGmailPdfEmail({
      tokenName: "default",
      to: TO,
      subject: `Purchasing week ${start.slice(5)} to ${end.slice(5)}`.replace(/-/g, "/"),
      body: `Purchasing week Mon ${start} - Fri ${end}. PDF attached.`,
      pdfBuffer: fs.readFileSync(pdfPath),
      pdfFilename: path.basename(pdfPath),
    });
    console.log(JSON.stringify(res));
    if (!res.messageId || !res.verified) process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
