// List AAA Cooper PROs the ledger still calls in_transit (or that have no
// delivered_at), so the page-based repair can be swept over the whole family.
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
    const r = await c.query(
        `select normalized_tracking_number pro, status_category, created_at::date::text d
           from shipments
          where carrier_name = 'AAA Cooper' and active
            and (status_category <> 'delivered' or delivered_at is null)
          order by created_at`,
    );
    console.log(`undelivered AAA Cooper rows: ${r.rowCount}`);
    for (const x of r.rows) console.log("  " + JSON.stringify(x));
    console.log("\n" + r.rows.map((x: any) => x.pro).join(" "));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
