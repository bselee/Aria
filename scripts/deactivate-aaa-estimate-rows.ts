/**
 * @file    scripts/deactivate-aaa-estimate-rows.ts
 * @purpose AAA Cooper invoices carry TWO 9-digit refs per page:
 *            - "PRO NUMBER"       64058xxx      (the real tracking)
 *            - "ESTIMATE NUMBER"  26xxxxxxx-1   (a pricing/service estimate)
 *          The LTL extractor takes BOTH, so every AAA Cooper invoice creates a
 *          pair of shipment rows and the "-1" estimate row is pure duplicate
 *          noise. Worse: AAA Cooper bills are for OUR OWN outbound customer
 *          freight, so neither ref is PO-attributable.
 *
 *          This script (a) empties po_numbers on the given estimate rows and
 *          (b) deactivates them, recording the reason in source_refs.
 *
 *          Guards: only rows whose tracking_number matches the estimate shape
 *          (^AAA Cooper:::<9 digits>-1$) are touched; rows still carrying a PO
 *          ref are refused unless listed explicitly with --force-linked.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/deactivate-aaa-estimate-rows.ts [--all-unlinked | <trackingKey>...] [--apply]
 */
import { readFileSync } from "fs";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all-unlinked");
const keys = args.filter((a) => !a.startsWith("--"));
const NOTE =
  "AAA Cooper ESTIMATE NUMBER mis-parsed as an LTL PRO. Estimate numbers are NOT tracking numbers; " +
  "the real PRO is the 64058xxx on the same invoice page. AAA Cooper bills cover our own OUTBOUND " +
  "customer freight (shipper = BUILDASOIL), so the ref is reconciliation-only and never PO-attributable.";

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const est = await c.query(
    `select id, tracking_key, tracking_number, po_numbers::text pos, active, source_refs::text src
       from shipments where tracking_number ~ '^AAA Cooper:::[0-9]{9}-1$' order by tracking_key`);
  console.log(`[aaa] estimate-shaped rows in shipments: ${est.rows.length}`);

  let targets = est.rows;
  if (!ALL) {
    const want = new Set(keys.map((k) => k.replace(/^aaa cooper:/, "")));
    targets = est.rows.filter((r: any) => want.has(r.tracking_number.replace("AAA Cooper:::", "")) || want.has(r.tracking_key.replace("aaa cooper:", "")));
  }
  console.log(`[aaa] targets: ${targets.length}${ALL ? " (all unlinked)" : ""}`);

  const blockers = targets.filter((r: any) => r.pos !== "{}");
  if (blockers.length) {
    console.error(`[aaa] REFUSING: ${blockers.length} target row(s) still carry a PO ref - unlink first:`);
    for (const b of blockers) console.error("   ", b.tracking_key, b.pos);
    await c.end();
    process.exit(2);
  }
  if (!targets.length) { console.log("[aaa] nothing to do"); await c.end(); return; }
  if (!APPLY) { console.log("[aaa] dry run; re-run with --apply"); await c.end(); return; }

  let done = 0;
  for (const r of targets) {
    const extra = JSON.stringify({
      seenAt: new Date().toISOString(),
      source: "manual_repair",
      sourceRef: "docs/plans/2026-10-06-tracking-ingest-po-attribution-defects.md",
      note: NOTE,
    });
    await c.query(
      `update shipments
          set po_numbers = '{}',
              active = false,
              status_display = 'Deactivated - AAA Cooper ESTIMATE NUMBER (not a PRO)',
              source_refs = coalesce(source_refs, '[]'::jsonb) || $2::jsonb,
              updated_at = now()
        where id = $1`,
      [r.id, `[${extra}]`]
    );
    done++;
  }
  console.log(`[aaa] deactivated ${done} estimate row(s)`);
  // shipments_cache has no active column, so a deactivated PG row that stays in the cache keeps
  // rendering on the dashboard as live freight. Delete the matching cache rows, case-insensitively:
  // cache keys keep the ingest's own prefix case while PG stores "AAA Cooper:::".
  try {
    const db = new Database("aria-local.db", { timeout: 8000 });
    const del = db.prepare(`delete from shipments_cache where upper(tracking_number) = upper(?)`);
    let removed = 0;
    for (const r of targets) removed += del.run(r.tracking_number).changes;
    db.close();
    console.log(`[aaa] cache rows removed: ${removed}`);
  } catch (e: any) {
    console.warn(`[aaa] cache cleanup skipped: ${e.message}`);
  }
  const left = await c.query(
    `select count(*) filter (where active) act, count(*) filter (where po_numbers <> '{}') linked
       from shipments where tracking_number ~ '^AAA Cooper:::[0-9]{9}-1$'`);
  console.log(`[aaa] remaining active estimate rows: ${JSON.stringify(left.rows[0])}`);
  const po = await c.query(`select count(*) n from shipments where po_numbers @> ARRAY['125393']`);
  console.log(`[aaa] shipments still citing 125393: ${po.rows[0].n}`);
  await c.end();
})();
