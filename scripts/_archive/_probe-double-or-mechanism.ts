// Mechanism test: does THIS PostgREST honour two repeated `or=` params, or only one?
// Production data cannot discriminate for the real filters (0 delivered-with-null-date
// rows), so use a pair that partitions the table visibly.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import { createClient } from "../src/lib/db";

(async () => {
    const sb: any = createClient();
    const q: any = sb
        .from("shipments")
        .select("id,carrier_name")
        .eq("active", true)
        .is("delivered_at", null)
        .or("carrier_name.is.null,carrier_name.eq.UPS")
        .or("carrier_name.is.null,carrier_name.eq.FedEx");
    console.log("URL:", decodeURIComponent(String(q.url)));
    const r = await q;
    console.log(`API: ${r.data?.length ?? 0} rows, error=${r.error?.message ?? "none"}`);
    const carriers = new Map<string, number>();
    for (const row of r.data ?? []) {
        const k = row.carrier_name === null ? "(null)" : row.carrier_name;
        carriers.set(k, (carriers.get(k) ?? 0) + 1);
    }
    console.log("API carriers:", JSON.stringify([...carriers.entries()]));

    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const h = await c.query(
        `select
           count(*) filter (where carrier_name is null)::int as both,
           count(*) filter (where carrier_name is null or carrier_name = 'UPS')::int as first_only,
           count(*) filter (where carrier_name is null or carrier_name = 'FedEx')::int as second_only,
           count(*)::int as neither
         from shipments where active and delivered_at is null`,
    );
    console.log("SQL hypotheses:", JSON.stringify(h.rows[0]));
    const apiN = r.data?.length ?? 0;
    const s = h.rows[0];
    console.log(
        apiN === s.both ? "VERDICT: BOTH or() applied (AND) — chained ors are safe"
        : apiN === s.first_only ? "VERDICT: SECOND or() DROPPED (first wins)"
        : apiN === s.second_only ? "VERDICT: FIRST or() DROPPED (last wins)"
        : apiN === s.neither ? "VERDICT: NEITHER applied — both ors lost"
        : "VERDICT: unexplained",
    );
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
