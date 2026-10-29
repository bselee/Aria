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
    const recent = await c.query(
        `select tracking_number, po_numbers, vendor_names, status_category, status_display,
                created_at::text created, last_source, source_confidence
           from shipments where carrier_name = 'AAA Cooper' and created_at > now() - interval '2 days'
          order by created_at desc`,
    );
    console.log(`AAA rows created in 48h: ${recent.rowCount}`);
    for (const r of recent.rows) console.log("  " + JSON.stringify(r));
    const all = await c.query(
        `select status_category, count(*)::int n from shipments where carrier_name = 'AAA Cooper' group by 1 order by 2 desc`,
    );
    console.log("status split:", JSON.stringify(all.rows));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
