/**
 * @file    scripts/rebuild-po-tracking-column.ts
 * @purpose Rebuild purchase_orders.tracking_numbers from the shipments table for a given PO.
 *
 *          Why: backfill-po-tracking-numbers.ts APPENDS, so a magnet-poisoned column keeps
 *          its junk after the shipments rows are unlinked (125212=638, 125213=678,
 *          125280=725 outbound labels that no longer cite the PO). This makes the column
 *          derived: exactly the tracking numbers of the shipment rows that cite the PO.
 *
 *          Mirrors into the dashboard's SQLite po_cache.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/rebuild-po-tracking-column.ts <po> [<po>...] [--apply]
 */
import { readFileSync } from "fs";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const POS = argv.filter((a) => !a.startsWith("--"));
if (!POS.length) { console.error("usage: rebuild-po-tracking-column.ts <po> [...] [--apply]"); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const derived: Record<string, string[]> = {};

  for (const po of POS) {
    // HERMIA(2026-11-10): case-insensitive containment. Shipment evidence stores
    // PO tokens normalized to UPPER (23591917-DROPSHIPPO) while purchase_orders
    // keeps mixed case (23591917-DropshipPO). The old `po_numbers @> ARRAY[$1]`
    // silently derived 0 for every *-DropshipPO / -S-DropshipPO row.
    const rows = (await c.query(
      `select tracking_number from shipments
        where exists (select 1 from unnest(po_numbers) x where upper(x) = upper($1))
        order by tracking_number`, [po])).rows;
    const tns = rows.map((r: any) => r.tracking_number);
    const before = (await c.query(`select array_length(tracking_numbers,1) n from purchase_orders where po_number=$1`, [po])).rows[0];
    derived[po] = tns;
    console.log(`[${po}] column before=${before ? (before.n ?? 0) : "no row"} derived=${tns.length}`);
    if (!APPLY) continue;
    if (!before) { console.log(`   skipped: no purchase_orders row`); continue; }
    await c.query(`update purchase_orders set tracking_numbers = $2::text[], updated_at = now() where po_number=$1`, [po, tns]);
    const after = (await c.query(`select array_length(tracking_numbers,1) n, tracking_numbers::text t from purchase_orders where po_number=$1`, [po])).rows[0];
    console.log(`   column after=${after.n ?? 0} ${after.t}`);
  }

  if (!APPLY) { console.log("dry run — pass --apply"); await c.end(); return; }

  // Mirror into the dashboard cache.
  try {
    const db = new Database("aria-local.db", { timeout: 8000 });
    const cols = (db.prepare(`PRAGMA table_info(po_cache)`).all() as any[]).map((r) => r.name);
    const has = (n: string) => cols.includes(n);
    console.log(`[cache] po_cache columns: ${cols.join(",")}`);
    const tcol = has("tracking_numbers") ? "tracking_numbers" : has("tns") ? "tns" : null;
    if (tcol) {
      const upd = db.prepare(`UPDATE po_cache SET ${tcol} = ? WHERE po_number = ?`);
      for (const [po, tns] of Object.entries(derived)) {
        const r = upd.run(JSON.stringify(tns), po);
        console.log(`[cache] ${po} -> ${tns.length} (rows touched ${r.changes})`);
      }
    } else {
      console.log("[cache] no tracking column on po_cache — nothing to mirror");
    }
    db.close();
  } catch (e: any) { console.log(`[cache] skipped: ${e.message}`); }

  const bad = (await c.query(
    `select po_number, vendor_name, array_length(tracking_numbers,1) n from purchase_orders
      where array_length(tracking_numbers,1) >= 30 order by n desc`)).rows;
  console.log(`[check] POs with >=30 trackings: ${JSON.stringify(bad)}`);
  await c.end();
})();
