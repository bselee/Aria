// How many dropship POs actually resolve in Finale? Is the 404 systemic?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
import { FinaleClient } from "../src/lib/finale/client";
import { Client } from "pg";

const IDS = [
    "23582767-S-DropshipPO", "23581487-S-DropshipPO", "23580227-DropshipPO",
    "23579447-S-DropshipPO", "23550677-DropshipPO", "23580437-DropshipPO",
    "23582767", "23581487",
];

(async () => {
    const f = new FinaleClient();
    for (const id of IDS) {
        try {
            const d = await f.getOrderDetails(id);
            console.log(`${id}: OK type=${d?.orderTypeId} num=${d?.orderId}`);
        } catch (e: any) {
            console.log(`${id}: ${e.message}`);
        }
    }
    // What do our PG dropship POs look like — how many, and does any carry a Finale-facing id?
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const n = await c.query(`select count(*)::int n from purchase_orders where po_number ilike '%-DropshipPO' or po_number ilike '%-Dropship'`);
    console.log(`PG dropship-shaped POs: ${n.rows[0].n}`);
    const sample = await c.query(`select po_number, vendor_name, status from purchase_orders where po_number ilike '%-DropshipPO' order by created_at desc limit 5`);
    console.log("newest:", JSON.stringify(sample.rows));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
