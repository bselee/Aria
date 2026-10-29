import { Client } from "pg";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const TN = "1Z22YV580359576490";
const PO = "23582767-S-DropshipPO";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const s = await c.query(
        `select tracking_number, po_numbers, vendor_names, status_category, status_display,
                estimated_delivery_at, delivered_at, active, last_source, source_confidence,
                source_refs, created_at::text created, last_checked_at::text checked
           from shipments where normalized_tracking_number = $1 or tracking_number ilike $2`,
        [TN, `%${TN}%`],
    );
    console.log(`shipment rows for ${TN}: ${s.rowCount}`);
    for (const r of s.rows) console.log(JSON.stringify(r, null, 1));

    const po = await c.query(
        `select po_number, vendor_name, status, lifecycle_state, total_amount, created_at::date::text created,
                tracking_numbers
           from purchase_orders where po_number = $1`,
        [PO],
    );
    console.log("PO:", JSON.stringify(po.rows, null, 1));

    const fam = await c.query(
        `select po_number, vendor_name, status, total_amount, tracking_numbers
           from purchase_orders where po_number like '23582767%'`,
    );
    console.log("PO family 23582767*:", JSON.stringify(fam.rows, null, 1));

    if (po.rowCount) {
        const items = po.rows[0].line_items;
        const arr = Array.isArray(items) ? items : [];
        console.log(`line_items: ${arr.length}`);
        for (const it of arr) console.log("  " + JSON.stringify(it));
        const sum = arr.reduce((a: number, it: any) => a + (Number(it.total ?? it.extended ?? 0) || 0), 0);
        console.log(`line_items sum: ${sum.toFixed(2)} vs total_amount ${po.rows[0].total_amount}`);
    }

    const auto = await c.query(
        `select po_number, vendor_name, status, tracking_numbers, created_at::date::text created
           from purchase_orders where vendor_name ilike '%autopot%' order by created_at desc limit 6`,
    );
    console.log("recent Autopot POs:", JSON.stringify(auto.rows));

    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
