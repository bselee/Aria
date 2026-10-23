/**
 * @file    scripts/_mirror-recent-status.ts
 * @purpose After a carrier refresh sweep, push the changed rows into the dashboard cache
 *          (aria-local.db shipments_cache). The dashboard reads SQLite, not Postgres, so a correct
 *          PG row that is not mirrored is invisible in the UI.
 *
 *          Cache keys keep the carrier prefix in the ingest's own case, so match case-insensitively
 *          and update the stored key rather than inserting a second spelling. ETA and delivered_at
 *          are carried explicitly (a mirror that forgets them blanks the dashboard).
 *
 * @usage   node --import tsx --env-file=.env.local scripts/_mirror-recent-status.ts [--minutes 30] [--apply]
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
const mi = args.indexOf("--minutes");
const MINUTES = mi >= 0 ? Number(args[mi + 1]) : 30;

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const rows = (
    await c.query(
      `select tracking_number, po_numbers, status_category, status_display,
              estimated_delivery_at, delivered_at, last_checked_at
         from shipments
        where active and last_checked_at > now() - ($1 || ' minutes')::interval
        order by last_checked_at desc`,
      [String(MINUTES)],
    )
  ).rows;
  console.log(`[mirror] rows checked in the last ${MINUTES} min: ${rows.length}`);

  const db = new Database("aria-local.db", { timeout: 10000 });
  const find = db.prepare(`SELECT tracking_number FROM shipments_cache WHERE upper(tracking_number) = upper(?)`);
  const upd = db.prepare(`
    UPDATE shipments_cache
       SET po_numbers = ?, status_category = ?, status_display = ?,
           estimated_delivery_at = ?, delivered_at = ?, last_checked_at = ?, updated_at = datetime('now')
     WHERE upper(tracking_number) = upper(?)`);
  const ins = db.prepare(`
    INSERT INTO shipments_cache (tracking_number, po_numbers, status_category, status_display,
                                 estimated_delivery_at, delivered_at, last_checked_at, updated_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))`);

  let updated = 0;
  let inserted = 0;
  // pg hands back JS Date objects for timestamptz columns; better-sqlite3 only binds
  // numbers/strings/bigints/buffers/null, so coerce every temporal value to ISO text.
  const txt = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  for (const r of rows) {
    const po = JSON.stringify(r.po_numbers ?? []);
    if (!APPLY) continue;
    const eta = txt(r.estimated_delivery_at);
    const del = txt(r.delivered_at);
    const checked = txt(r.last_checked_at);
    const hit = find.get(r.tracking_number) as { tracking_number: string } | undefined;
    if (hit) {
      upd.run(po, r.status_category, r.status_display, eta, del, checked, hit.tracking_number);
      updated++;
    } else {
      ins.run(r.tracking_number, po, r.status_category, r.status_display, eta, del, checked);
      inserted++;
    }
  }
  db.close();
  console.log(APPLY ? `[mirror] updated=${updated} inserted=${inserted}` : "[mirror] dry run - pass --apply");
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
