// Does Finale know about PO 23582767-S-DropshipPO, or is the 404 a missing order?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
import { FinaleClient } from "../src/lib/finale/client";
(async () => {
    const f = new FinaleClient();
    for (const id of ["23582767-S-DropshipPO", "23582767"]) {
        try {
            const d = await f.getOrderDetails(id);
            console.log(`--- Finale ${id}: OK orderId=${d?.orderId} status=${d?.orderStatus?.name ?? d?.status} type=${d?.orderTypeId}`);
        } catch (e: any) { console.log(`--- Finale ${id}: ${e.message}`); }
    }
    const recent = await f.getRecentPurchaseOrders(60, 2000);
    const hits = recent.filter((p: any) => String(p.orderId).includes("23582767") || String(p.orderId).includes("23581947"));
    console.log("--- recent Finale POs matching 23582767 / 23581947 ---");
    console.log(JSON.stringify(hits.map((h: any) => ({ orderId: h.orderId, status: h.orderStatus?.name ?? h.status, type: h.orderTypeId, vendor: h.vendorName ?? h.vendor?.name })), null, 1));
    const autopot = recent.filter((p: any) => /autopot/i.test(String(p.vendorName ?? p.vendor?.name ?? ""))).slice(0, 8);
    console.log("--- recent Autopot Finale POs ---");
    console.log(JSON.stringify(autopot.map((h: any) => ({ orderId: h.orderId, status: h.orderStatus?.name ?? h.status, type: h.orderTypeId })), null, 1));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
