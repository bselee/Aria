// Maplejet shipment SHP-00362 has no PO in our DB. Before calling it an
// unlinked consumable order, ask Finale: a PO created there today would not be
// in purchase_orders yet if the po-finale-sync job is behind the cron lock.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { FinaleClient } from "../src/lib/finale/client";

(async () => {
    const finale = new FinaleClient();
    const recent = await finale.getRecentPurchaseOrders(30, 500);
    console.log(`Finale POs last 30d: ${recent.length}`);
    const hit = (recent as any[]).filter((p) => {
        const blob = JSON.stringify(p).toLowerCase();
        return /maple|chronplast|17282/.test(blob);
    });
    console.log(`matching maple/chronplast/17282: ${hit.length}`);
    for (const p of hit) {
        console.log(`  ${p.poNumber ?? p.id} | ${p.vendorName ?? p.vendor?.name} | ${p.status ?? p.orderStatus} | ${p.total ?? p.totalAmount}`);
        for (const line of p.lineItems ?? p.lines ?? []) {
            console.log(`     ${line.itemId ?? line.sku ?? ""} ${line.description ?? line.itemName ?? ""} qty=${line.quantity ?? line.qty}`);
        }
    }
    // Also: the five newest POs, so we can see whether sync is current at all.
    console.log("\nfive newest Finale POs:");
    for (const p of recent.slice(0, 5)) {
        console.log(`  ${p.poNumber ?? p.id} | ${String(p.vendorName ?? p.vendor?.name ?? "?").slice(0, 30)} | ${p.status ?? p.orderStatus} | ${p.orderDate ?? p.dateCreated ?? ""}`);
    }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
