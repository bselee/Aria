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
    const apTables = await c.query(
        `select table_name from information_schema.tables where table_schema='public' and table_name like 'ap%' order by 1`,
    );
    console.log("ap* tables:", apTables.rows.map((r: any) => r.table_name).join(", ") || "(none)");

    const fwd = await c.query(
        `select table_name, column_name from information_schema.columns
          where table_schema='public' and column_name ilike '%forward%' order by 1`,
    );
    console.log("columns mentioning forward:", JSON.stringify(fwd.rows));

    const vp = await c.query(
        `select vendor_name, orders_email from vendor_profiles
          where vendor_name ilike '%tec%' or vendor_name ilike '%cen%' order by 1 limit 10`,
    );
    console.log("vendor_profiles (Cen-Tec-ish):", JSON.stringify(vp.rows));

    const aliases = await c.query(
        `select * from vendor_aliases where lower(alias) like '%centec%' or lower(alias) like '%cen-tec%' limit 5`,
    ).catch((e: any) => ({ rows: [{ err: e.message }] } as any));
    console.log("vendor_aliases:", JSON.stringify(aliases.rows));

    // Is Cen-Tec known at all as a vendor we buy from?
    const pos = await c.query(
        `select count(*)::int n, min(created_at)::date first_po, max(created_at)::date last_po
           from purchase_orders where vendor_name ilike '%cen-tec%' or vendor_name ilike '%centec%'`,
    );
    console.log("POs to Cen-Tec:", JSON.stringify(pos.rows[0]));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
