/**
 * @file _audit-eow-sources.ts
 * @purpose Audit the two lockstep sources for silent drops: board rows filtered
 *          out before the report, POs missing line items, duplicate PO ids, and
 *          arrival rows whose SKU has no runway lookup.
 * @author Hermia
 * @created 2026-11-10
 * @deps live purchasing + active-purchases endpoints, snoozes
 */

import { addDays, needByIso, excludeManualVendor, keepUpcomingAmount, mondayOf } from "../src/lib/purchasing/eow-report";
import { listActiveSnoozes, isItemSnoozed } from "../src/lib/purchasing/snoozes";

type It = Record<string, any>;

function bucket(it: It): string {
  const r: string[] = it?.assessment?.reasonCodes ?? [];
  if (r.includes("on_order_already_covers_need") || r.includes("recent_draft_exists")) return "on_order";
  if (it?.draftPO) return "on_order";
  return it?.assessment?.decision === "order" ? (it.stockOnOrder > 0 ? "topping" : "need") : "other";
}

async function main(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const weekOut = addDays(mondayOf(today), 11);
  const snoozes = listActiveSnoozes();

  const board: any = await (await fetch("http://localhost:3001/api/dashboard/purchasing?mode=all")).json();
  const items: Array<{ vendor: string; it: It }> = [];
  for (const g of board.groups ?? []) for (const it of g.items ?? []) items.push({ vendor: g.vendorName ?? "", it });

  const stats = { total: items.length, need: 0, topping: 0, onOrder: 0, other: 0 };
  const candidates = items
    .map(({ vendor, it }) => {
      const b = bucket(it);
      if (b === "need") stats.need++;
      else if (b === "topping") stats.topping++;
      else if (b === "on_order") stats.onOrder++;
      else stats.other++;
      const qty = Number(it.assessment?.recommendedQty ?? it.suggestedQty ?? 0);
      const rw = it.adjustedRunwayDays ?? it.runwayDays;
      const lead = Number(it.effectiveLeadTimeDays ?? it.leadTimeDays ?? 21) || 21;
      const need = rw == null ? null : needByIso(today, Number(rw) || 0);
      return {
        sku: String(it.productId ?? ""),
        vendor,
        bucket: b,
        qty,
        amt: qty * (Number(it.unitPrice) || 0),
        need,
        mustOrder: need ? addDays(need, -lead) : null,
        snoozed: isItemSnoozed(String(it.productId), it.supplierPartyId ?? null, snoozes),
        excluded: excludeManualVendor(vendor, String(it.productId)),
      };
    })
    .filter((r) => r.sku);

  const live = candidates.filter((r) => (r.bucket === "need" || r.bucket === "topping") && r.qty > 0 && r.need);
  const inWindow = live.filter((r) => r.mustOrder && r.mustOrder <= weekOut);
  const shown = inWindow.filter((r) => !r.snoozed && !r.excluded && keepUpcomingAmount(r.amt));
  const dropped = inWindow.filter((r) => !shown.includes(r));

  console.log(`board items: ${stats.total} | need ${stats.need} topping ${stats.topping} on_order ${stats.onOrder} other ${stats.other}`);
  console.log(`purchasable (need/topping, qty>0): ${live.length} | order-by in next 7d: ${inWindow.length} | printed: ${shown.length}`);
  if (dropped.length) {
    console.log("filtered out of the window:");
    for (const d of dropped) {
      const why = d.snoozed ? "snoozed" : d.excluded ? "manual vendor" : "amount floor";
      console.log(`  ${d.sku.padEnd(20)} ${d.bucket.padEnd(8)} $${d.amt.toFixed(0).padStart(6)}  ${why}`);
    }
  }
  console.log("printed rows:");
  for (const s of shown) {
    console.log(`  ${s.sku.padEnd(20)} ${s.bucket.padEnd(8)} qty ${String(s.qty).padStart(6)} order-by ${s.mustOrder}`);
  }

  // ── active purchases ──
  const ap: any = await (await fetch("http://localhost:3001/api/dashboard/active-purchases")).json();
  const rows: any[] = ap.purchases ?? [];
  const start = mondayOf(today);
  const nextMon = addDays(start, 7);
  const followingFri = addDays(start, 18);

  const noItems = rows.filter((p) => !Array.isArray(p.items) || p.items.length === 0);
  const ids = rows.map((p) => String(p.orderId));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const inWindowAp = rows.filter((p) => {
    const eta = String(p.expectedDate || "").slice(0, 10);
    return eta >= nextMon && eta <= followingFri;
  });
  const noRunway = inWindowAp.filter((p) => {
    const skus = (p.items ?? []).map((i: any) => String(i.productId));
    return skus.some((s: string) => !items.some(({ it }) => String(it.productId) === s));
  });

  console.log(`\nopen POs: ${rows.length} | no line items: ${noItems.length} | duplicate ids: ${dupes.length}`);
  console.log(`in window ${nextMon}..${followingFri}: ${inWindowAp.length} | with a SKU absent from the board: ${noRunway.length}`);
  for (const p of noRunway) {
    console.log(`  ${p.orderId} ${p.vendorName} → ${(p.items ?? []).map((i: any) => i.productId).join(", ")} (Covered until will be blank)`);
  }

  const bad = dropped.filter((d) => !d.snoozed && !d.excluded).length === 0 && noItems.length === 0 && dupes.length === 0;
  console.log(bad ? "\nCLEAN" : "\nREVIEW");
}

void main();
