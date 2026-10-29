// Is DATABASE_URL the same database PostgREST serves? The missing relations
// (ap_local_forwards, vendor_domains, vendor_profiles) say maybe not.
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
    const me = await c.query("select current_database() db, current_schema() sch, count(*)::int from shipments");
    console.log("DATABASE_URL ->", JSON.stringify(me.rows[0]));
    const schemas = await c.query("select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'");
    console.log("schemas:", schemas.rows.map((r: any) => r.nspname).join(", "));
    const rels = await c.query(
        `select table_schema, table_name, table_type from information_schema.tables
          where table_name ilike '%forward%' or table_name ilike '%vendor_domain%' or table_name ilike '%vendor_profile%'
          order by 1,2`,
    );
    console.log("matching relations:", JSON.stringify(rels.rows));
    const cnt = await c.query("select count(*)::int n from ap_local_forwards").catch(async (e: any) => ({ rows: [{ n: "ERR " + e.message }] } as any));
    console.log("ap_local_forwards count:", JSON.stringify(cnt.rows));

    // What does PostgREST say? Ask it for the table roster via an OpenAPI request.
    const base = process.env.PGRST_URL || "http://localhost:5434";
    const r = await fetch(base + "/", { headers: { Accept: "application/openapi+json" } });
    if (r.ok) {
        const spec: any = await r.json();
        const paths = Object.keys(spec.paths || {});
        console.log(`PostgREST rosters ${paths.length} paths; vendor/forward matches:`);
        console.log("  " + paths.filter((p) => /vendor|forward|profile/i.test(p)).join(", "));
    } else {
        console.log("PostgREST openapi status:", r.status);
    }
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
