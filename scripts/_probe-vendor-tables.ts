// vendor resolution depends on tables the resolver names. Do they exist now?
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
    for (const t of ["vendor_emails", "vendor_domains", "vendor_profiles", "vendor_aliases", "ap_inbox_queue", "ap_local_forwards"]) {
        const r = await c.query(
            `select count(*)::int n from information_schema.tables where table_schema='public' and table_name=$1`,
            [t],
        );
        let rows: any = null;
        if (r.rows[0].n > 0) {
            const cnt = await c.query(`select count(*)::int n from ${t}`).catch((e: any) => ({ rows: [{ n: e.message.slice(0, 40) }] } as any));
            rows = cnt.rows[0].n;
        }
        console.log(`${t.padEnd(20)} exists=${r.rows[0].n > 0} rows=${rows}`);
    }
    // Does the inbox queue carry a PO match column (the successor of the forward queue)?
    const cols = await c.query(
        `select table_name, column_name from information_schema.columns
          where table_schema='public' and table_name in ('ap_inbox_queue','ap_activity_log')
            and (column_name ilike '%po%' or column_name ilike '%vendor%' or column_name ilike '%gmail%')
          order by 1,2`,
    );
    console.log("queue columns:", JSON.stringify(cols.rows));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
