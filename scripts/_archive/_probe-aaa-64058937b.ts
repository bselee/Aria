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
    const s = await c.query(
        "select tracking_number, source_refs, status_display, active, last_source from shipments where tracking_number = $1",
        ["AAA Cooper:::64058937"],
    );
    console.log("shipment:", JSON.stringify(s.rows[0], null, 1));

    const t = await c.query(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and (table_name like '%email%' or table_name like '%track%' or table_name like '%bol%' or table_name like '%ingest%')
          order by 1`,
    );
    console.log("tables:", t.rows.map((r: any) => r.table_name).join(", "));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
