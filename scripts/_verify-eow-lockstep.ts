/**
 * @file _verify-eow-lockstep.ts
 * @purpose Prove the Friday report's Upcoming list is the Ordering board's list.
 *          Every row on the report must exist on the live board with the same
 *          quantity, and every board item due this week must be accounted for.
 * @author Hermia
 * @created 2026-11-10
 * @deps live /api/dashboard/purchasing, reports/*.html, snoozes
 */

import fs from "node:fs";
import path from "node:path";
import { addDays, needByIso, excludeManualVendor, keepUpcomingAmount, mondayOf } from "../src/lib/purchasing/eow-report";
import { listActiveSnoozes, isItemSnoozed } from "../src/lib/purchasing/snoozes";

const REPORTS = path.resolve(__dirname, "..", "reports");
const TRUCKLOAD_CAP: Record<string, number> = { RAWMALIBUCOMPOST: 42_000 };

type Item = Record<string, any>;

function denverToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

function bucket(it: Item): string {
  const reasons: string[] = it?.assessment?.reasonCodes ?? [];
  if (reasons.includes("on_order_already_covers_need") || reasons.includes("recent_draft_exists")) return "on_order";
  if (it?.draftPO) return "on_order";
  if (it?.assessment?.decision === "order") return (Number(it?.stockOnOrder) || 0) > 0 ? "topping" : "need";
  return "other";
}

function reportRows(html: string): Array<{ sku: string; qty: number; amount: string; fg: string; note: string }> {
  const i = html.indexOf("Upcoming Purchases");
  const seg = html.slice(i, i + 4000);
  const out: Array<{ sku: string; qty: number; amount: string; fg: string; note: string }> = [];
  for (const tr of seg.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()
    );
    if (cells.length !== 7) continue;
    const m = cells[0].match(/^(\S+)(?: ×([\d,]+))?$/);
    if (!m || m[1] === "SKU") continue;
    out.push({
      sku: m[1],
      qty: m[2] ? Number(m[2].replace(/,/g, "")) : 0,
      amount: cells[4],
      fg: cells[5],
      note: cells[6],
    });
  }
  return out;
}

async function main(): Promise<void> {
  const today = denverToday();
  const weekOut = addDays(mondayOf(today), 11);
  const res = await fetch("http://localhost:3001/api/dashboard/purchasing?mode=all");
  const board: any = await res.json();
  const snoozes = listActiveSnoozes();

  const items: Array<{ vendor: string; it: Item }> = [];
  for (const g of board.groups ?? []) {
    for (const it of g.items ?? []) items.push({ vendor: g.vendorName ?? "", it });
  }

  const due = items
    .filter(({ it }) => ["need", "topping"].includes(bucket(it)))
    .map(({ vendor, it }) => {
      const qty = Number(it.assessment?.recommendedQty ?? it.suggestedQty ?? 0) || 0;
      const rw = it.adjustedRunwayDays ?? it.runwayDays;
      const lead = Number(it.effectiveLeadTimeDays ?? it.leadTimeDays ?? 21) || 21;
      const need = rw == null ? null : needByIso(today, Number(rw) || 0);
      return {
        sku: String(it.productId ?? ""),
        vendor,
        bucket: bucket(it),
        qty,
        unitPrice: Number(it.unitPrice) || 0,
        need,
        mustOrder: need ? addDays(need, -lead) : null,
        snoozed: isItemSnoozed(String(it.productId), it.supplierPartyId ?? null, snoozes),
        excluded: excludeManualVendor(vendor, String(it.productId)),
        onHand: Number(it.stockOnHand) || 0,
      };
    })
    .filter((r) => r.sku && r.qty > 0 && r.need);

  const html = fs.readFileSync(
    path.join(REPORTS, "eow-purchasing-2026-11-09.html"),
    "utf8"
  );
  const rows = reportRows(html);
  const bySku = new Map(rows.map((r) => [r.sku, r]));

  let bad = 0;
  console.log("── report rows vs board ──");
  for (const r of rows) {
    const b = due.find((d) => d.sku === r.sku);
    if (!b) {
      console.log(`MISSING ON BOARD: ${r.sku} (report wants ${r.qty})`);
      bad++;
      continue;
    }
    const cap = TRUCKLOAD_CAP[r.sku];
    const expected = cap ? Math.min(b.qty, Math.max(0, cap - b.onHand)) : b.qty;
    const qtyOk = expected === r.qty;
    const amtOk = Math.abs(expected * b.unitPrice - Number(r.amount.replace(/[$,]/g, ""))) < 1;
    if (!qtyOk || !amtOk) {
      console.log(`DIVERGED ${r.sku}: report ${r.qty}/${r.amount} board ${expected}/${(expected * b.unitPrice).toFixed(2)}`);
      bad++;
    } else {
      console.log(`ok ${r.sku.padEnd(20)} qty ${String(r.qty).padStart(7)}  board ${b.bucket.padEnd(7)} ${b.vendor}`);
    }
  }

  console.log("\n── board items due this week, missing from the report ──");
  for (const b of due) {
    if (b.snoozed || b.excluded) continue;
    if (!b.mustOrder || b.mustOrder > weekOut) continue;
    if (bySku.has(b.sku)) continue;
    const amt = b.qty * b.unitPrice;
    const why = !keepUpcomingAmount(amt) ? "amount floor" : "window/dedupe";
    console.log(`  absent ${b.sku.padEnd(20)} qty ${String(b.qty).padStart(7)} $${amt.toFixed(0).padStart(6)}  ${b.bucket}  (${why})`);
  }

  console.log(`\n${bad === 0 ? "PASS" : `FAIL (${bad})`}`);

  // ── Arriving Soon must be the Active Purchases set, nothing added or lost ──
  const ap: any = await (await fetch("http://localhost:3001/api/dashboard/active-purchases")).json();
  const start = mondayOf(today);
  const nextMon = addDays(start, 7);
  const followingFri = addDays(start, 18);
  const expectedPos = (ap.purchases ?? [])
    .filter((p: any) => !p.isReceived && String(p.completionState || "").toLowerCase() !== "received")
    .filter((p: any) => (p.items ?? []).some((i: any) => Number(i.remainingQty ?? i.quantity ?? 0) > 0))
    .map((p: any) => ({ po: String(p.orderId), eta: String(p.expectedDate || "").slice(0, 10) }))
    .filter((p: any) => p.eta && p.eta >= nextMon && p.eta <= followingFri);

  const seg = html.slice(html.indexOf("Arriving Soon"), html.indexOf("Invoices to Bill.com"));
  const shownPos = [...seg.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").trim()))
    .filter((c) => c.length === 6 && c[0] !== "PO")
    .map((c) => ({ po: c[0], eta: c[4] }));

  console.log("\n── arriving vs active purchases ──");
  let apBad = 0;
  for (const e of expectedPos) {
    const s = shownPos.find((x) => x.po === e.po);
    if (!s) {
      console.log(`  MISSING FROM REPORT: ${e.po} expected ${e.eta}`);
      apBad++;
    } else if (!s.eta.includes(e.eta.slice(5).replace("-", "/"))) {
      console.log(`  DATE DIVERGED ${e.po}: report "${s.eta}" board ${e.eta}`);
      apBad++;
    } else {
      console.log(`  ok ${e.po} ${e.eta}`);
    }
  }
  for (const s of shownPos) {
    if (!expectedPos.some((e) => e.po === s.po)) {
      console.log(`  EXTRA IN REPORT: ${s.po} (not an open PO in this window)`);
      apBad++;
    }
  }
  console.log(`arriving: ${apBad === 0 ? "PASS" : `FAIL (${apBad})`}`);

  process.exitCode = bad === 0 && apBad === 0 ? 0 : 1;
}

void main();
