/**
 * @file    scripts/refresh-in-transit-received-po.ts
 * @purpose Shipment rows still marked in_transit while the PO they cite is already received:
 *          40 rows spanning 2026-04..2026-10, every one with last_checked_at = null. The dashboard
 *          therefore shows freight in motion for closed POs. This re-polls the carrier through the
 *          monotonic writer (delivered is terminal, never downgraded) and, for numbers the carrier
 *          no longer answers, annotates the display string instead of inventing a status.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/refresh-in-transit-received-po.ts [--apply] [--annotate-stale] [--limit N]
 */
import { Client } from "pg";
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { refreshShipmentStatus } from "../src/lib/tracking/shipment-intelligence";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ANNOTATE = args.includes("--annotate-stale");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const PREDICATE = `
      from shipments s
     where s.active
       and s.status_category = 'in_transit'
       and coalesce(array_length(s.po_numbers, 1), 0) > 0
       and exists (
         select 1 from purchase_orders p
          where p.po_number = any(s.po_numbers)
            and p.status = 'received')
     order by s.created_at`;

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const rows = (
    await c.query(`select s.* ${PREDICATE}${LIMIT ? ` limit ${LIMIT}` : ""}`)
  ).rows;
  console.log(`[refresh] candidate rows: ${rows.length}${APPLY ? "" : " (dry run)"}`);

  let moved = 0;
  let refused = 0;
  const stale: string[] = [];

  for (const row of rows) {
    const label = `${row.tracking_number} [${row.po_numbers.join(",")}]`;
    if (!APPLY) {
      console.log(`  ${label} -> ${row.status_category} (${row.status_display})`);
      continue;
    }
    try {
      const after: any = await refreshShipmentStatus(row as any);
      if (after.status_category !== row.status_category) {
        moved++;
        console.log(`  ${label}: ${row.status_category} -> ${after.status_category} (${after.status_display})`);
      } else {
        refused++;
        stale.push(String(row.tracking_number));
        console.log(`  ${label}: stays ${after.status_category} (${after.status_display})`);
      }
    } catch (e: any) {
      refused++;
      stale.push(String(row.tracking_number));
      console.log(`  ${label}: poll failed - ${e.message}`);
    }
  }

  if (APPLY && ANNOTATE && stale.length) {
    for (const tn of stale) {
      await c.query(
        `update shipments
            set status_display = 'PO already received - carrier data unavailable (' || coalesce(status_display,'') || ')',
                updated_at = now()
          where upper(tracking_number) = upper($1)
            and active
            and status_category = 'in_transit'`,
        [tn],
      );
    }
    console.log(`[refresh] annotated ${stale.length} rows whose carrier data is gone`);
  }

  const left = await c.query(
    `select count(*) n ${PREDICATE.replace("order by s.created_at", "")}`,
  );
  console.log(`[refresh] moved=${moved} refused/failed=${refused} still-in-transit=${left.rows[0].n}`);
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
