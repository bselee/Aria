/**
 * @file    scripts/deactivate-glued-tracking-rows.ts
 * @purpose PDF column-glue creates fake tracking numbers: a real FedEx 12-digit number
 *          followed by "1eaNN" lifted from the Qty/Unit/Price columns
 *          ("1" + "ea" + "56" from "56.16") - e.g. Generic:::5204849085531ea56 for the
 *          real 520484908553 on Evergreen Growers invoice 151119.
 *
 *          These rows are never tracking numbers. Deactivate them (keep the row and its
 *          evidence), delete them from the dashboard cache, and report the corrected
 *          number so it can be linked properly.
 *
 *          Guards: only rows matching ^<prefix>:::5204[0-9]{8}1ea[0-9]{2}$; refuses a row
 *          that still carries PO refs unless --force-linked (a glued row must be cleaned
 *          by hand if it somehow got linked).
 *
 * @usage   node --import tsx --env-file=.env.local scripts/deactivate-glued-tracking-rows.ts [<trackingKey>...] [--apply] [--force-linked]
 */
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force-linked");
const keys = args.filter((a) => !a.startsWith("--"));
const GLUED = /^.+:::5204[0-9]{8}1ea[0-9]{2}$/;

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const all = (
    await c.query(
      `select id, tracking_key, tracking_number, po_numbers, active
         from shipments where tracking_number ~ '5204[0-9]{8}1ea[0-9]{2}$' order by tracking_number`,
    )
  ).rows;
  console.log(`[glue] glued rows in shipments: ${all.length}`);

  let targets = all;
  if (keys.length) {
    const want = new Set(keys.map((k) => k.toUpperCase()));
    targets = all.filter(
      (r: any) => want.has(String(r.tracking_number).toUpperCase()) || want.has(String(r.tracking_key).toUpperCase()),
    );
  }
  console.log(`[glue] targets: ${targets.length}`);

  for (const r of targets) {
    if (!GLUED.test(String(r.tracking_number))) {
      console.error(`REFUSING ${r.tracking_number}: does not match the glued pattern`);
      await c.end();
      process.exit(2);
    }
    const pos: string[] = r.po_numbers ?? [];
    if (pos.length && !FORCE) {
      console.error(`REFUSING ${r.tracking_number}: still carries PO refs ${JSON.stringify(pos)} - clear them first or pass --force-linked`);
      await c.end();
      process.exit(2);
    }
    const real = String(r.tracking_number).replace(/^.*:::/, "").replace(/1ea[0-9]{2}$/, "");
    console.log(`  ${r.tracking_number} -> real ${real}${pos.length ? ` (clearing ${JSON.stringify(pos)})` : ""}`);
  }

  if (!APPLY) {
    console.log("[glue] dry run - pass --apply");
    await c.end();
    return;
  }

  for (const r of targets) {
    const real = String(r.tracking_number).replace(/^.*:::/, "").replace(/1ea[0-9]{2}$/, "");
    const note = JSON.stringify([
      {
        source: "manual_repair",
        sourceRef: "pdf column-glue",
        seenAt: new Date().toISOString(),
        note:
          `Fake tracking number: real ${real} with "1eaNN" glued on from the Qty/Unit/Price columns ` +
          `("1" + "ea" + first digits of the price). Deactivated; the real number is tracked on its own row.`,
      },
    ]);
    await c.query(
      `update shipments
          set po_numbers = '{}',
              active = false,
              status_display = $2,
              source_refs = coalesce(source_refs, '[]'::jsonb) || $3::jsonb,
              updated_at = now()
        where id = $1`,
      [r.id, `Deactivated - PDF column-glue artifact of ${real}`, note],
    );

    const db = new Database("aria-local.db", { timeout: 8000 });
    // Cache keys keep the ingest's lowercase carrier prefix (generic:::) while PG stores
    // "Generic:::" - delete case-insensitively or nothing matches.
    const del = db
      .prepare(`DELETE FROM shipments_cache WHERE upper(tracking_number) = upper(?)`)
      .run(r.tracking_number);
    db.close();
    console.log(`[glue] ${r.tracking_number} deactivated | cache deleted ${del.changes}`);
  }

  const left = await c.query(
    `select count(*) filter (where active) act, count(*) n
       from shipments where tracking_number ~ '5204[0-9]{8}1ea[0-9]{2}$'`,
  );
  console.log(`[glue] remaining: ${JSON.stringify(left.rows[0])}`);
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
