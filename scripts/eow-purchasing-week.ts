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
import { computeFreightDrift } from "../src/lib/freight/freight-drift";
import { resolvePoEta } from "../src/lib/purchasing/po-eta";
import { poolCartonGroups } from "../src/lib/purchasing/carton-pooling";

const NUMERIC = /^\d+$/;
const TO = "bill.selee@buildasoil.com";
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

type Row = { po: string; vendor: string; amount: number; note: string; sku?: string; eta?: string; status?: string; placed?: string; desc?: string; qty?: string; recvQty?: string; recvVariance?: string; placedIso?: string; plannedReceive?: string; etaIsEstimate?: boolean };

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
    "Vendor Response": "note", "Needed by": "note", Note: "note",
    Sent: "note", Issue: "note",
    Product: "vendor", "Old to New": "desc", "Est. Savings/Yr": "eta",
    "Received By": "eta", "Recv Qty": "eta", "±": "var",
    Item: "vendor", Detail: "desc",
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
  return `<p class="summary">(${n}) invoices sent</p>`;
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
}): string {
  const sum = (rows: Row[]) => rows.reduce((a, r) => a + (r.amount || 0), 0);
  const md = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
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
${table(["SKU", "Description", "Vendor", "Needed by", "Amount", "Note"], p.upcoming.map((r) => [r.qty ? `${r.sku || r.po} ×${r.qty}` : (r.sku || r.po), r.desc || "", r.vendor, mdFromIso(r.eta || ""), r.amount ? money(r.amount) : "", r.note]))}
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
): Promise<{ lastVendorIso: string | null; emailDueIso: string | null; backorder: boolean }> {
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `"${po}" -subject:"Purchasing week" -from:calendar-notification`,
    maxResults: 12,
  });
  let lastVendorIso: string | null = null;
  let lastVendorId: string | null = null;
  for (const m of list.data.messages || []) {
    const d = await gmail.users.messages.get({
      userId: "me",
      id: m.id!,
      format: "metadata",
      metadataHeaders: ["From", "Date"],
    });
    const from = hdr(d.data.payload?.headers, "From");
    const dateIso = iso(hdr(d.data.payload?.headers, "Date"));
    if (FROM_US.test(from) || !dateIso) continue;
    if (!lastVendorIso || dateIso > lastVendorIso) {
      lastVendorIso = dateIso;
      lastVendorId = m.id || null;
    }
  }
  let body = "";
  if (lastVendorId) {
    const full = await gmail.users.messages.get({ userId: "me", id: lastVendorId, format: "full" });
    body = gmailPlain(full.data.payload);
  }
  const own = vendorReplyOwnText(body);
  return {
    lastVendorIso,
    emailDueIso: parseVendorDueFromText(body),
    backorder: /backorder/i.test(own),
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
    for (const r of committed) {
      const m = byPo.get(r.po);
      const life = String(m?.lifecycle_stage || "").toUpperCase();
      if (/RECEIVED|COMPLETED/.test(life)) r.status = "Received";
      else if (m?.tracking_status_summary) r.status = "In Transit";
      else if (m?.vendor_acknowledged_at) r.status = "Acknowledged";
      else r.status = "Sent";
      // ETA — same shared resolution the Active Purchases dashboard uses
      // (po-eta → leadTimeService). A vendor-stated date still wins because
      // it is the most direct evidence.
      const vendorEta = iso(m?.vendor_stated_eta);
      if (vendorEta) {
        r.eta = mdFromIso(vendorEta);
        r.etaIsEstimate = false;
      } else {
        const eta = await resolvePoEta({
          vendorName: r.vendor,
          orderDate: r.placedIso,
          plannedReceiveDate: r.plannedReceive,
          today,
        });
        r.eta = mdFromIso(eta.date);
        r.etaIsEstimate = eta.provenance !== "finale_planned";
      }
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
  const skuRunway = new Map<string, number>();
  try {
    for (const name of ["api-bust.json", "purchasing-resale.json", "purchasing-bom.json"]) {
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
          const rw = o.adjustedRunwayDays ?? o.runwayDays;
          if (id && typeof rw === "number" && Number.isFinite(rw) && !skuRunway.has(id)) {
            skuRunway.set(id, rw);
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
      skus.split(",").map((s) => skuRunway.get(s.trim()))
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
  } catch {
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
    const weekOut = addDays(today, 7);

    // The dashboard pools each slot separately (resale, then BOM), so the
    // report must do the same — pooling both files together would sum the same
    // SKU's rate twice and invent a shortage. Same helper, same inputs.
    const cartonNames = Array.from(skuName, ([sku, name]) => ({ sku, name })).filter(
      (c) => boxDimKey(c.name)
    );
    const stockMemo = new Map<string, number | null>();
    const feeds: Array<{ vendor: string; it: any }> = [];
    for (const name of ["purchasing-resale.json", "purchasing-bom.json"]) {
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
      const qty0 = it.suggestedQty || 0;
      const oo = it.stockOnOrder || 0;
      const rw = it.adjustedRunwayDays;
      if (qty0 <= 0) continue;
      if (oo > 0) continue;
      if (rw == null) continue;
      const sku = String(it.productId || "");
      if (!sku || seen.has(sku)) continue;
      if (excludeManualVendor(vendor, sku)) continue;

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
        if (dimKey) seenDims.add(dimKey);
        continue;
      }

      let orderQty = qty0;
      let moq: number | null = null;
      const floor = standardOrderQty.get(vendor.trim().toLowerCase());
      if (floor && orderQty < floor) {
        orderQty = floor;
        moq = floor;
      }
      const amt = orderQty * (it.unitPrice || 0);
      if (!keepUpcomingAmount(amt)) continue;

      const flags: string[] = [];
      if (lead >= 30) flags.push(`${lead}d lead`);
      if (amt >= 2000) flags.push("Large");
      if (moq) flags.push(`MOQ ${moq.toLocaleString("en-US")}`);
      if (runwayDays <= 0) flags.push("Out now");

      seen.add(sku);
      if (dimKey) seenDims.add(dimKey);
      upcoming.push({
        po: sku,
        vendor,
        sku,
        qty: Number(orderQty).toLocaleString("en-US"),
        amount: amt,
        note: flags.join(" · "),
        eta: need,
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
      r.note = delayedVendorNote({
        emailDueIso: thread.emailDueIso,
        pgEtaIso: r.eta || null,
        lastVendorReplyIso: thread.lastVendorIso,
        todayIso: today,
        backorder: thread.backorder,
      });
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
  for (const r of delayed) {
    const skus = (r.sku || "").split(",").map((s) => s.trim()).filter(Boolean);
    const uses = skus.map((s) => skuUse.get(s) || "resale");
    const hasB = uses.includes("build");
    const hasR = uses.includes("resale");
    const hasC = uses.includes("combo");
    const use = hasC || (hasB && hasR) ? "Combo" : hasB ? "Build" : "Resale";
    r.note = `${use} · ${r.note}`;
  }
  for (const r of [...committed, ...received, ...delayed, ...upcoming, ...priceUpdates, ...research]) {
    r.desc = descOf(r.sku || "", skuDesc);
  }
  await pool.end();

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
