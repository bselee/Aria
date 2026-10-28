// Blast radius: how many POs have active shipments citing them yet an empty
// tracking_numbers column (i.e. already blanked by the broken derivation)?
import { Client } from "pg";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const totals = await c.query(`
        select count(*)::int pos_with_shipments,
               count(*) filter (where coalesce(array_length(po.tracking_numbers,1),0) = 0)::int empty_column
          from purchase_orders po
         where exists (select 1 from shipments s where s.active and po.po_number = any(s.po_numbers))`);
    console.log("POs with active shipments:", JSON.stringify(totals.rows[0]));

    const sample = await c.query(`
        select po.po_number, po.status, po.vendor_name,
               (select count(*) from shipments s where s.active and po.po_number = any(s.po_numbers))::int n_ship
          from purchase_orders po
         where exists (select 1 from shipments s where s.active and po.po_number = any(s.po_numbers))
           and coalesce(array_length(po.tracking_numbers,1),0) = 0
         order by n_ship desc limit 12`);
    console.log("\nsample empty-column POs:");
    for (const r of sample.rows) console.log("  " + JSON.stringify(r));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
