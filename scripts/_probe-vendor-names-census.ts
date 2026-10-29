// Is the empty vendor_names on the Cen-Tec parcel systemic or specific?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const byDay = await c.query(
        `select created_at::date d,
                count(*)::int n,
                count(*) filter (where vendor_names is null or cardinality(vendor_names) = 0)::int no_vendor
           from shipments
          where created_at >= now() - interval '10 days'
          group by 1 order by 1 desc`,
    );
    console.log("recent shipments by day (n / without vendor):");
    for (const r of byDay.rows) console.log(`  ${r.d}  ${String(r.n).padStart(4)} / ${r.no_vendor}`);

    const recent = await c.query(
        `select tracking_number, last_source, source_confidence, vendor_names, po_numbers, created_at
           from shipments order by created_at desc limit 8`,
    );
    console.log("\nnewest 8 rows:");
    for (const r of recent.rows) {
        console.log(`  ${String(r.created_at).slice(0, 19)}  ${r.last_source}  vendor=${JSON.stringify(r.vendor_names)}  po=${JSON.stringify(r.po_numbers)}  ${r.tracking_number}`);
    }

    const totals = await c.query(
        `select count(*)::int n,
                count(*) filter (where vendor_names is null or cardinality(vendor_names) = 0)::int no_vendor
           from shipments where active`,
    );
    console.log("\nall active rows:", JSON.stringify(totals.rows[0]));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
