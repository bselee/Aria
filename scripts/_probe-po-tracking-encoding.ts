// After the repair: does the PO side now find its shipments, and is the PO
// tracking column written in the same encoding shipments uses?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const POS = ["23591917-DropshipPO", "23591647-S-DropshipPO", "23591137-DropshipPO"];

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    for (const po of POS) {
        const citers = await c.query(
            `select tracking_number, status_category, estimated_delivery_at, last_checked_at
               from shipments where $1 = any(po_numbers)`,
            [po],
        );
        const row = await c.query(`select tracking_numbers, status from purchase_orders where po_number = $1`, [po]);
        console.log(`${po}`);
        for (const s of citers.rows) console.log(`   shipment ${s.tracking_number} ${s.status_category} eta=${s.estimated_delivery_at} checked=${String(s.last_checked_at).slice(0, 19)}`);
        console.log(`   PO.tracking_numbers=${JSON.stringify(row.rows[0]?.tracking_numbers)} status=${row.rows[0]?.status}`);
    }

    // Encoding census: how are tracking numbers stored on the PO side overall?
    const enc = await c.query(`
        select case when t like '%:::%' then 'prefixed' else 'bare' end as shape, count(*)::int n
          from purchase_orders, unnest(tracking_numbers) t group by 1 order by 1
    `);
    console.log("\nPO tracking_numbers encoding:", JSON.stringify(enc.rows));

    const shipEnc = await c.query(`
        select case when tracking_number like '%:::%' then 'prefixed' else 'bare' end as shape, count(*)::int n
          from shipments group by 1 order by 1
    `);
    console.log("shipments.tracking_number encoding:", JSON.stringify(shipEnc.rows));

    // For a bare PO-side entry, can it join shipments at all?
    const joinTest = await c.query(`
        select count(*)::int n from purchase_orders p, unnest(p.tracking_numbers) t
         where not exists (select 1 from shipments s where s.tracking_number = t)
    `);
    console.log("PO tracking entries with NO matching shipments.tracking_number:", joinTest.rows[0].n);
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
