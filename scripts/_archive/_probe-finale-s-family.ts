// Is the -S- family uniquely absent from Finale, and where does the suffix come from?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
import { FinaleClient } from "../src/lib/finale/client";
import { Client } from "pg";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const cols = await c.query(`select column_name, data_type from information_schema.columns where table_name='purchase_orders' order by ordinal_position`);
    console.log("purchase_orders columns:", cols.rows.map((r: any) => `${r.column_name}:${r.data_type}`).join(", "));

    const f = new FinaleClient();

    const letters = await c.query(`select po_number from purchase_orders where po_number ~ '^[0-9]{8}[A-Z]-DropshipPO$' order by created_at desc limit 4`);
    console.log("\n--- letter -X-DropshipPO samples ---");
    for (const r of letters.rows) {
        let a = "?";
        try { await f.getOrderDetails(r.po_number); a = "OK"; } catch (e: any) { a = e.message.includes("404") ? "404" : e.message.slice(0, 40); }
        console.log(`${r.po_number}: as-is=${a}`);
    }

    const one = await c.query(`select * from purchase_orders where po_number = '23582767-S-DropshipPO'`);
    console.log("\n--- PG row 23582767-S-DropshipPO ---");
    const row: any = one.rows[0];
    for (const k of Object.keys(row)) {
        const v = row[k];
        if (v === null) continue;
        console.log(`  ${k} = ${typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200)}`);
    }

    console.log("\n--- Finale sales order 23582767 shape ---");
    try {
        const d: any = await f.getOrderDetails("23582767");
        console.log(`  orderId=${d?.orderId} type=${d?.orderTypeId} status=${d?.status} vendor=${d?.vendorName}`);
        console.log("  keys:", Object.keys(d || {}).join(", "));
        for (const k of Object.keys(d || {})) {
            const v = (d as any)[k];
            if (Array.isArray(v)) console.log(`  ${k}: array(${v.length})`);
        }
        const lineItems = d?.lineItemList ?? d?.lineItems ?? [];
        console.log(`  lineItems: ${lineItems.length}`);
        for (const li of lineItems.slice(0, 6)) {
            console.log("   " + JSON.stringify({ sku: li.sku ?? li.itemSku, qty: li.quantity, desc: String(li.description ?? li.itemName ?? "").slice(0, 40), dropship: li.isDropShip ?? li.dropShip }));
        }
    } catch (e: any) { console.log("  ERR", e.message); }

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
