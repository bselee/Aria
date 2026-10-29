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
    const dbs = await c.query("select datname, pg_size_pretty(pg_database_size(datname)) sz from pg_database where datistemplate = false order by 1");
    console.log("databases:", JSON.stringify(dbs.rows));

    // The resolver queries COLUMNS on vendor_profiles, not separate tables.
    const cols = await c.query(
        `select column_name, data_type from information_schema.columns
          where table_schema='public' and table_name='vendor_profiles'
            and column_name in ('vendor_emails','vendor_domains','orders_email','vendor_name')
          order by 1`,
    );
    console.log("vendor_profiles columns:", JSON.stringify(cols.rows));

    // Would the resolver's step 1 match this sender?
    const hit = await c.query(
        `select vendor_name, orders_email from vendor_profiles where lower(orders_email) = 'penny@centecsystems.com'`,
    );
    console.log("step-1 (orders_email) match:", JSON.stringify(hit.rows));
    const dom = await c.query(
        `select vendor_name, vendor_domains from vendor_profiles
          where vendor_domains is not null and 'centecsystems.com' = any(vendor_domains) limit 3`,
    ).catch((e: any) => ({ rows: [{ err: e.message.slice(0, 60) }] } as any));
    console.log("step-3 (vendor_domains[]) match:", JSON.stringify(dom.rows));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
