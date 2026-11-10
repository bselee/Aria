// po_numbers stored in the WRONG CASE breaks the join to purchase_orders.
// Measure the blast radius: which shipment POs don't resolve case-sensitively
// but do resolve case-insensitively?
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

    const q = await c.query(`
        with refs as (
            select s.tracking_number, unnest(s.po_numbers) as po, s.created_at
              from shipments s
        )
        select
            count(*)::int as total_refs,
            count(*) filter (where p_exact.po_number is not null)::int as exact_match,
            count(*) filter (where p_exact.po_number is null and p_ci.po_number is not null)::int as case_mismatch,
            count(*) filter (where p_exact.po_number is null and p_ci.po_number is null)::int as no_po_row
          from refs
          left join purchase_orders p_exact on p_exact.po_number = refs.po
          left join lateral (
              select po_number from purchase_orders
               where lower(po_number) = lower(refs.po) limit 1
          ) p_ci on true
    `);
    console.log("all po refs on shipments:", JSON.stringify(q.rows[0]));

    const recent = await c.query(`
        with refs as (
            select s.tracking_number, unnest(s.po_numbers) as po, s.created_at
              from shipments s where s.created_at >= now() - interval '14 days'
        )
        select refs.tracking_number, refs.po as stored, p_ci.po_number as actual
          from refs
          left join purchase_orders p_exact on p_exact.po_number = refs.po
          left join lateral (
              select po_number from purchase_orders
               where lower(po_number) = lower(refs.po) limit 1
          ) p_ci on true
         where p_exact.po_number is null and p_ci.po_number is not null
         order by refs.created_at desc limit 20
    `);
    console.log(`\nlast 14 days: ${recent.rowCount} case-mismatched refs (showing up to 20)`);
    for (const r of recent.rows) console.log(`  ${r.tracking_number}  stored=${r.stored}  actual=${r.actual}`);

    // Are the three alert rows part of a wider pattern? Sample uppercase-looking refs.
    const up = await c.query(`
        select count(*)::int n from (
            select unnest(po_numbers) as po from shipments
        ) x where po = upper(po) and po ~ '[A-Z]'
    `);
    console.log("\nrefs that are fully uppercase (any case in table):", up.rows[0].n);
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
