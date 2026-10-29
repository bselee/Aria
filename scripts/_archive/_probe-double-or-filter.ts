// Two chained .or() calls — do both survive to PostgREST, or does the second
// replace the first? If one is dropped, the cooldown filter disappears and the
// poll goes back to hammering every row on every run.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const CUTOFF = new Date(Date.now() - 2 * 3600_000).toISOString();

(async () => {
    // 1. What URL does supabase-js actually build for two chained .or() calls?
    const { createClient } = await import("../src/lib/db");
    const sb: any = createClient();
    const built: any = sb
        .from("shipments")
        .select("id", { count: "exact", head: true })
        .eq("active", true)
        .is("delivered_at", null)
        .or("status_category.is.null,status_category.neq.delivered")
        .or(`last_checked_at.is.null,last_checked_at.lte.${CUTOFF}`);
    console.log("URL:", decodeURIComponent(String(built.url)));

    const both = await built;
    console.log(`supabase result: count=${both.count} error=${both.error?.message ?? "none"} rows=${both.data?.length ?? 0}`);

    // 2. Ground truth in SQL for every hypothesis.
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const hyp = await c.query(
        `select
           count(*) filter (where active and delivered_at is null
                              and (status_category is null or status_category <> 'delivered')
                              and (last_checked_at is null or last_checked_at <= $1))::int as a_and_b,
           count(*) filter (where active and delivered_at is null
                              and (status_category is null or status_category <> 'delivered'))::int as a_only,
           count(*) filter (where active and delivered_at is null
                              and (last_checked_at is null or last_checked_at <= $1))::int as b_only,
           count(*) filter (where active and delivered_at is null)::int as neither
         from shipments`,
        [CUTOFF],
    );
    console.log("SQL hypotheses:", JSON.stringify(hyp.rows[0]));

    const r = hyp.rows[0];
    const api = both.count;
    const verdict =
        api === r.a_and_b ? "BOTH applied (AND) — correct"
        : api === r.a_only ? "SECOND or() DROPPED — cooldown filter is gone"
        : api === r.b_only ? "FIRST or() DROPPED — delivered-by-category filter is gone"
        : api === r.neither ? "NEITHER applied — both or() filters lost"
        : "unexplained: matches no hypothesis";
    console.log(`VERDICT: ${verdict}`);

    // 3. Same test with the ors in the opposite order, to identify "last wins".
    const built2: any = sb
        .from("shipments")
        .select("id", { count: "exact", head: true })
        .eq("active", true)
        .is("delivered_at", null)
        .or(`last_checked_at.is.null,last_checked_at.lte.${CUTOFF}`)
        .or("status_category.is.null,status_category.neq.delivered");
    const both2 = await built2;
    console.log(`reversed order: count=${both2.count} error=${both2.error?.message ?? "none"}`);
    console.log(`reversed verdict: ${both2.count === r.a_and_b ? "BOTH applied" : both2.count === r.a_only ? "first dropped" : both2.count === r.b_only ? "second dropped" : "other"}`);

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
