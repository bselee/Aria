// Evergreen Growers pair. Two things to prove: the PO attribution, and whether
// these rows were written BEFORE or AFTER the po_numbers case fix (1a36ea16) —
// production runs October code behind the cron lock, so a fresh uppercase row
// here means the fix is not live yet.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const PAIRS = [
    ["520484911104", "23593207-DropshipPO"],
    ["520484911295", "23591857-DropshipPO"],
];

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    for (const [tn, expected] of PAIRS) {
        console.log(`\n=== ${tn} (alert says ${expected}) ===`);
        const s = await c.query(
            `select tracking_number, status_category, status_display, estimated_delivery_at,
                    delivered_at, last_checked_at, po_numbers, vendor_names, last_source,
                    source_confidence, source_refs, active, created_at
               from shipments where normalized_tracking_number = $1`,
            [tn],
        );
        for (const r of s.rows) {
            console.log(`  stored po_numbers: ${JSON.stringify(r.po_numbers)}`);
            console.log(`  exact match to alert ref? ${JSON.stringify((r.po_numbers ?? []).includes(expected))}`);
            console.log(`  carrier=${r.status_category} (${r.status_display}) eta=${r.estimated_delivery_at} delivered=${r.delivered_at}`);
            console.log(`  active=${r.active} last_checked=${r.last_checked_at} created=${r.created_at}`);
            console.log(`  source=${r.last_source}@${r.source_confidence}`);
            for (const ref of r.source_refs ?? []) {
                console.log(`     ref ${ref.source}:${ref.sourceRef}@${ref.confidence}`);
            }
        }

        const po = await c.query(
            `select po_number, vendor_name, status, total_amount, tracking_numbers, created_at
               from purchase_orders where lower(po_number) = lower($1)`,
            [expected],
        );
        for (const r of po.rows) {
            console.log(`  PO ${r.po_number} | ${r.vendor_name} | ${r.status} | $${r.total_amount}`);
            console.log(`     tracking (${(r.tracking_numbers ?? []).length}): ${JSON.stringify(r.tracking_numbers)}`);
        }
        if (po.rowCount === 0) console.log("  PO row: MISSING");
        // Canonical spelling present?
        const exact = po.rows[0]?.po_number ?? null;
        if (exact && exact !== expected) console.log(`  !! alert ref spelling differs from purchase_orders: ${exact}`);

        const citers = await c.query(
            `select count(*)::int n from shipments where $1 = any(po_numbers)`,
            [expected],
        );
        console.log(`  shipments citing the exact alert ref: ${citers.rows[0].n}`);
    }

    // All rows created since the fix was committed (2026-11-10T22:41Z), checked
    // for the uppercase defect: does any of them still store a mangled ref?
    const since = await c.query(`
        select count(*) filter (where po = upper(po) and po ~ '[A-Z]')::int as uppercase_refs,
               count(*)::int as refs
          from (select unnest(po_numbers) as po from shipments where created_at > '2026-11-10T22:41:00Z') x
    `);
    console.log("\nrefs on rows created after the fix commit:", JSON.stringify(since.rows[0]));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
