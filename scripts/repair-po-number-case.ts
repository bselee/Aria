/**
 * Repair shipment po_numbers refs that were stored in the wrong case.
 *
 * The invoice-tracking bridge ran normalizePoString() (a comparison normalizer)
 * on the parsed PO number, so it wrote "23591647-S-DROPSHIPPO" where
 * purchase_orders holds "23591647-S-DropshipPO". The join is exact-match, so
 * those rows cannot be found from the PO side. Nine rows, all carrying an
 * ap_invoice @0.92 ref.
 *
 * Canonicalisation source is purchase_orders itself — never a constructed
 * spelling. A ref that matches no PO row is left exactly as it is.
 *
 * Usage:  node --import tsx --env-file=.env.local scripts/repair-po-number-case.ts [--apply]
 */
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const rows = await c.query(`
        with refs as (
            select s.id, s.tracking_number, s.po_numbers, unnest(s.po_numbers) as po
              from shipments s
        )
        select r.id, r.tracking_number, r.po as stored, p.po_number as actual
          from refs r
          join lateral (
              select po_number from purchase_orders
               where lower(po_number) = lower(r.po) limit 1
          ) p on true
         where r.po <> p.po_number
         order by r.tracking_number
    `);

    console.log(`case-mismatched refs: ${rows.rowCount}`);
    const byShipment = new Map<string, { tracking: string; po_numbers: string[]; fixes: [string, string][] }>();
    for (const r of rows.rows) {
        if (!byShipment.has(r.id)) {
            byShipment.set(r.id, { tracking: r.tracking_number, po_numbers: [], fixes: [] });
        }
        byShipment.get(r.id)!.fixes.push([r.stored, r.actual]);
    }
    // Fetch current arrays so we rewrite the whole value, not one element.
    for (const [id, entry] of byShipment) {
        const cur = await c.query(`select po_numbers from shipments where id = $1`, [id]);
        entry.po_numbers = cur.rows[0].po_numbers ?? [];
        console.log(`  ${entry.tracking}`);
        console.log(`    stored: ${JSON.stringify(entry.po_numbers)}`);
        const fixed = entry.po_numbers.map((p: string) => {
            const hit = entry.fixes.find(([s]) => s === p);
            return hit ? hit[1] : p;
        });
        entry.po_numbers = fixed;
        console.log(`    fixed:  ${JSON.stringify(fixed)}`);
    }

    if (!APPLY) {
        console.log("\n(dry run — pass --apply to write)");
        await c.end();
        return;
    }

    let pgWrites = 0;
    for (const [id, entry] of byShipment) {
        const r = await c.query(
            `update shipments set po_numbers = $2 where id = $1`,
            [id, entry.po_numbers],
        );
        pgWrites += r.rowCount ?? 0;
    }
    console.log(`\nPG rows updated: ${pgWrites}`);

    // The dashboard cache stores po_numbers as a JSON string, lowercase-keyed
    // tracking numbers — match case-insensitively.
    const db = new Database("aria-local.db");
    let cacheWrites = 0;
    for (const [, entry] of byShipment) {
        const r = db
            .prepare(`update shipments_cache set po_numbers = ? where lower(tracking_number) = lower(?)`)
            .run(JSON.stringify(entry.po_numbers), entry.tracking);
        cacheWrites += r.changes;
    }
    db.close();
    console.log(`cache rows updated: ${cacheWrites}`);

    // Verify by re-reading: every ref must now join exactly.
    const after = await c.query(`
        with refs as (select unnest(po_numbers) as po from shipments)
        select count(*)::int as total,
               count(*) filter (where p.po_number is null)::int as unresolved
          from refs left join purchase_orders p on p.po_number = refs.po
    `);
    console.log("verify (exact join):", JSON.stringify(after.rows[0]));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
