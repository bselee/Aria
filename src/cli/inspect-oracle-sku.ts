/** Inspect Oracle decision for a specific SKU.
 *  node --import tsx src/cli/inspect-oracle-sku.ts KMS101
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@/lib/db";

async function main() {
    const sku = (process.argv[2] || "").toUpperCase();
    if (!sku) { console.error("usage: inspect-oracle-sku.ts <SKU>"); process.exit(1); }

    const sb = createClient();
    if (!sb) throw new Error("supabase not configured");
    const { data } = await sb
        .from("build_risk_snapshots")
        .select("generated_at, components")
        .order("generated_at", { ascending: false })
        .limit(1);
    const snap = data?.[0] as any;
    if (!snap) { console.log("no snapshot"); process.exit(0); }
    console.log(`snapshot generated_at: ${snap.generated_at}`);
    const comp = snap.components?.[sku];
    if (!comp) {
        const keys = Object.keys(snap.components ?? {}).filter(k => k.includes(sku.replace(/[0-9]+$/, ""))).slice(0, 10);
        console.log(`SKU ${sku} not in snapshot. Possible similar:`, keys);
        process.exit(0);
    }
    console.log(`\n--- ${sku} ---`);
    console.log(`productName        : ${comp.productName}`);
    console.log(`onHand             : ${comp.onHand}`);
    console.log(`onOrder            : ${comp.onOrder}`);
    console.log(`stockoutDays       : ${comp.stockoutDays}`);
    console.log(`leadTimeDays       : ${comp.leadTimeDays}`);
    console.log(`riskLevel          : ${comp.riskLevel}`);
    console.log(`totalRequiredQty   : ${comp.totalRequiredQty}`);
    console.log(`consumptionQuantity: ${comp.consumptionQuantity}`);
    console.log(`demandQuantity     : ${comp.demandQuantity}`);
    console.log(`incomingPOs        : ${comp.incomingPOs?.length ?? 0}`);
    for (const po of (comp.incomingPOs ?? [])) {
        console.log(`  - PO #${po.orderId}  qty=${po.quantity}  date=${po.orderDate}  supplier=${po.supplier}`);
    }
    console.log(`usedIn             : ${(comp.usedIn ?? []).join(", ")}`);

    // Recompute oracle status
    const { computeOracleStatus, computeBuildDemandOracle } = await import("@/lib/builds/build-demand-oracle");
    const incomingPOQty = (comp.incomingPOs ?? []).reduce((s: number, p: any) => s + (p.quantity ?? 0), 0);
    const wk14Need = comp.totalRequiredQty ?? 0;
    console.log(`\nOracle decision inputs:`);
    console.log(`  onHand              : ${comp.onHand ?? 0}`);
    console.log(`  incomingPOQty       : ${incomingPOQty}`);
    console.log(`  totalSupply         : ${(comp.onHand ?? 0) + incomingPOQty}`);
    console.log(`  wk14Need (= totalReq): ${wk14Need}`);
    console.log(`  totalSupply < wk14? : ${(comp.onHand ?? 0) + incomingPOQty < wk14Need}`);
    console.log(`  ⇒ oracleStatus     : ${computeOracleStatus(comp.onHand, incomingPOQty, wk14Need, 0, 0)}`);
    process.exit(0);
}

main().catch(e => { console.error("err:", e?.message ?? e); process.exit(1); });
