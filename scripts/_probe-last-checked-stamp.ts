// Does anything ever stamp shipments.last_checked_at? carrier-poll filters on it
// but never writes it.
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

    const r = await c.query(`
        select count(*)::int total,
               count(*) filter (where last_checked_at is null)::int never_checked,
               count(*) filter (where last_checked_at is not null)::int stamped,
               min(last_checked_at)::text oldest_stamp,
               max(last_checked_at)::text newest_stamp
          from shipments
         where active = true and delivered_at is null`);
    console.log("active undelivered shipments:", JSON.stringify(r.rows[0]));

    const bycarrier = await c.query(`
        select carrier_name,
               count(*)::int total,
               count(*) filter (where last_checked_at is null)::int never_checked
          from shipments
         where active = true and delivered_at is null
         group by 1 order by 2 desc limit 8`);
    console.log("by carrier:", JSON.stringify(bycarrier.rows, null, 1));

    const stale = await c.query(`
        select tracking_number, status_category, status_display, updated_at::text
          from shipments
         where active = true and delivered_at is null and last_checked_at is null
           and updated_at > now() - interval '1 day'
         order by updated_at desc limit 6`);
    console.log("recent writes with a null last_checked_at (proof the writer never stamps it):");
    for (const x of stale.rows) console.log("  " + JSON.stringify(x));

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
