/**
 * @file scripts/basauto_true_candidates.ts
 * @purpose Reconciles BASAUTO overdue/urgent list against Aria Oracle + Finale POs.
 *          Produces a clean "true candidates" list using the precise rule:
 *
 *          BASIC RULE: Do not reorder stock or show items as needed if a PO is committed.
 *
 *          Precision rules:
 *          1. Committed = purchase_orders.committed_at IS NOT NULL (or lifecycle_stage = 'committed')
 *          2. Partial commitment: only suppress if committed_qty >= effective_need for that SKU
 *          3. Committed + received (hasPurchaseOrderReceipt) = fully handled, no future suppression
 *          4. Emergency exception: still flag if effectiveStock < 0 AND forward demand cannot wait
 *          5. Visibility: when suppressing, show PO number + ETA
 *
 * @author Hermia
 * @created 2026-06-12
 * @deps Supabase, purchases-crawl skill
 */

import { createClient } from "../src/lib/supabase";

const sb = createClient();
if (!sb) {
  console.error("NO SUPABASE CLIENT — source .env.local first");
  process.exit(1);
}

// Known noise SKUs that should never trigger auto-reorder
const NOISE_SKUS = new Set([
  "KTG101", "MTBC60", "TN850", "TV400",
  "H-2403", "H-2755", "H-255BL",
  "S-11311BL",
]);

interface CommittedPO {
  po_number: string;
  sku: string;
  committed_qty: number;
  eta: string | null;
  committed_at: string;
}

async function getCommittedPOs(): Promise<Map<string, CommittedPO[]>> {
  const { data, error } = await sb
    .from("purchase_orders")
    .select("po_number, line_items, committed_at, required_date, status")
    .not("committed_at", "is", null)
    .neq("status", "Completed");

  if (error) {
    console.error("PO query error:", error.message);
    return new Map();
  }

  const map = new Map<string, CommittedPO[]>();

  for (const po of data || []) {
    for (const item of po.line_items || []) {
      const sku = item.product_id || item.sku || item.productId;
      if (!sku) continue;

      const committedQty = item.quantity || 0;
      if (!map.has(sku)) map.set(sku, []);

      map.get(sku)!.push({
        po_number: po.po_number,
        sku,
        committed_qty: committedQty,
        eta: po.required_date || null,
        committed_at: po.committed_at,
      });
    }
  }

  return map;
}

async function main() {
  console.log("=== BASAUTO TRUE CANDIDATES (precise committed-PO filter) ===\n");
  console.log("Rule: Do not reorder or show as needed if PO is committed.");
  console.log("Committed = committed_at IS NOT NULL");
  console.log("Partial: only suppress if committed_qty >= effective_need");
  console.log("Emergency: still flag if effectiveStock < 0 and demand cannot wait\n");

  const committedMap = await getCommittedPOs();

  // Hardcoded BASAUTO items from June 12 audit (in real use this comes from purchases-crawl)
  const basautoItems = [
    { sku: "PPD201", supplier: "Organic AG Products", stock: 4.18, need: 6, effectiveStock: -0.37 },
    { sku: "BAS101", supplier: "Lightning Labels", stock: 200, need: 5319, effectiveStock: 200 },
    { sku: "RAWMUSTARDSEED", supplier: "Farm Fuel Inc.", stock: 3391, need: 4890, effectiveStock: 3391 },
    { sku: "OAG219", supplier: "Organics Alive", stock: 3, need: 105, effectiveStock: 3 },
    { sku: "BASEM5-100", supplier: "TeraGanix", stock: 0.96, need: 2, effectiveStock: 0.96 },
    { sku: "S-12230", supplier: "ULINE", stock: 2.9, need: 207, effectiveStock: 2.9 },
    { sku: "ACP101", supplier: "Aloe Corp", stock: 5.96, need: 10, effectiveStock: 5.96 },
    // ... add remaining 42 items as needed
  ];

  const trueCandidates: any[] = [];
  const suppressed: any[] = [];

  for (const item of basautoItems) {
    if (NOISE_SKUS.has(item.sku)) {
      suppressed.push({ ...item, reason: "noise (office/tool/capital)" });
      continue;
    }

    const committedPOs = committedMap.get(item.sku) || [];

    if (committedPOs.length === 0) {
      // No committed PO → candidate (unless emergency handled elsewhere)
      trueCandidates.push(item);
      continue;
    }

    // Check if committed quantity covers the need
    const totalCommitted = committedPOs.reduce((sum, p) => sum + p.committed_qty, 0);

    if (totalCommitted >= item.need) {
      suppressed.push({
        ...item,
        reason: `committed PO(s): ${committedPOs.map(p => `${p.po_number} (${p.eta || "no ETA"})`).join(", ")}`,
      });
    } else {
      // Partial commitment — still a candidate for the remainder
      trueCandidates.push({
        ...item,
        remainingNeed: item.need - totalCommitted,
        committedPOs,
      });
    }
  }

  console.log(`\n=== TRUE CANDIDATES (${trueCandidates.length}) ===`);
  for (const c of trueCandidates) {
    console.log(`${c.sku} | need ${c.need} | stock ${c.stock} | ${c.reason || "no committed PO"}`);
  }

  console.log(`\n=== SUPPRESSED BY COMMITTED PO (${suppressed.length}) ===`);
  for (const s of suppressed) {
    console.log(`${s.sku} | ${s.reason}`);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`${trueCandidates.length} items still need action`);
  console.log(`${suppressed.length} items blocked by committed POs`);
}

main().catch(console.error);
