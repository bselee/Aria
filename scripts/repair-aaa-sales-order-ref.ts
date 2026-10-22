/**
 * @file    scripts/repair-aaa-sales-order-ref.ts
 * @purpose A carrier's "P.O.NUMBER" box is NOT proof the number is a purchase order.
 *          AAA Cooper invoice for PRO 64058928 (ACT statement 2978, ship 10/07/26,
 *          shipper BUILDASOIL -> consignee Jacob Pschirrer) prints:
 *              P.O.NUMBER 23566017   REF# 23566017   ESTIMATE NUMBER: 276170239-1
 *          Finale resolves 23566017 as orderTypeId=SALES_ORDER (ORDER_CANCELLED,
 *          BuildASoil.com), so it is OUR CUSTOMER ORDER, not a PO. The ingest linked
 *          both shipment rows to it and persisted a dangling po_numbers ref.
 *
 *          This script:
 *            1. PRO 64058928  - clear the sales-order ref, KEEP the row active as the
 *               freight evidence, record vendor names, annotate status_display with the
 *               sales order, and preserve the trace in source_refs.
 *            2. PRO 640589289 - clear the ref and DEACTIVATE: the number appears nowhere
 *               on the document; it is an OCR variant of 64058928 (same PO/ref pair).
 *
 *          Guards: refuses unless 23566017 resolves in Finale as SALES_ORDER; refuses
 *          unless every target row cites exactly that one ref (or none, for the variant);
 *          never deletes; mirrors both stores (PG + shipments_cache, deleting deactivated
 *          cache rows because the cache has no active column).
 *
 * @usage   node --import tsx --env-file=.env.local scripts/repair-aaa-sales-order-ref.ts [--apply]
 */
import { readFileSync } from "fs";
import { Client } from "pg";
import Database from "better-sqlite3";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { FinaleClient } from "../src/lib/finale/client";

const APPLY = process.argv.includes("--apply");
const REF = "23566017";
const KEEP = "AAA Cooper:::64058928";
const VARIANT = "AAA Cooper:::640589289";

const NOTE = {
  keep:
    "AAA Cooper invoice 2978 (Pro 64058928, ship 10/07/26, shipper BUILDASOIL -> consignee in Charleston IL). " +
    "The invoice's P.O.NUMBER/REF# 23566017 is a Finale SALES_ORDER (BuildASoil.com customer order, ORDER_CANCELLED), " +
    "not a purchase order. Sales-order ref moved out of po_numbers into source_refs; freight kept as evidence.",
  variant:
    "640589289 appears nowhere on AAA Cooper invoice 2978; the PRO NUMBER is 64058928. OCR variant duplicate of the same " +
    "shipment - deactivated, not deleted.",
};

async function main() {
  // Guard 1: the cited number must be a SALES_ORDER in Finale, never a PO.
  const f = new FinaleClient();
  const details: any = await f.getOrderDetails(REF);
  const orderType = details?.orderTypeId;
  const status = details?.statusId;
  console.log(`[guard] Finale ${REF}: orderTypeId=${orderType} statusId=${status} orderUrl=${details?.orderUrl}`);
  if (orderType !== "SALES_ORDER") {
    console.error(`ABORT: ${REF} is ${orderType}, not SALES_ORDER - this repair is only for a customer-order ref`);
    process.exit(2);
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const rows = (
    await c.query(
      `select id, tracking_key, tracking_number, po_numbers, active, status_display
         from shipments where tracking_number = any($1::text[]) order by tracking_number`,
      [[KEEP, VARIANT]],
    )
  ).rows;
  console.log("== target rows ==");
  for (const r of rows) console.log(JSON.stringify(r));
  if (rows.length !== 2) {
    console.error(`ABORT: expected 2 rows, found ${rows.length}`);
    await c.end();
    process.exit(2);
  }
  for (const r of rows) {
    const pos: string[] = (r.po_numbers ?? []).map(String);
    if (pos.length !== 1 || pos[0] !== REF) {
      console.error(`ABORT: ${r.tracking_key} cites ${JSON.stringify(pos)}, expected exactly ["${REF}"]`);
      await c.end();
      process.exit(2);
    }
  }

  if (!APPLY) {
    console.log("dry run - pass --apply");
    await c.end();
    return;
  }

  // Keep the real PRO: evidence preserved, sales order recorded in source_refs.
  await c.query(
    `update shipments
        set po_numbers = '{}',
            vendor_names = case when vendor_names is null or vendor_names = '{}'::text[]
                                then array['AAA COOPER TRANSPORTATION'] else vendor_names end,
            status_display = 'Freight PRO 64058928 - invoice 2978, ship 10/07/26 (customer sales order 23566017, no purchase order)',
            source_refs = coalesce(source_refs, '[]'::jsonb) || $2::jsonb,
            updated_at = now()
      where tracking_number = $1`,
    [KEEP, JSON.stringify([{ source: "manual_repair", sourceRef: "AAA Cooper invoice 2978 / ACT_STMD_ID_2978.PDF", seenAt: new Date().toISOString(), note: NOTE.keep }])],
  );

  // Kill the OCR variant: same guard as the estimate rows - clear refs, deactivate, keep the row.
  await c.query(
    `update shipments
        set po_numbers = '{}',
            active = false,
            status_display = 'Deactivated - OCR variant of PRO 64058928 (number absent from invoice)',
            source_refs = coalesce(source_refs, '[]'::jsonb) || $2::jsonb,
            updated_at = now()
      where tracking_number = $1`,
    [VARIANT, JSON.stringify([{ source: "manual_repair", sourceRef: "AAA Cooper invoice 2978 / ACT_STMD_ID_2978.PDF", seenAt: new Date().toISOString(), note: NOTE.variant }])],
  );

  console.log("\n== read-back PG ==");
  for (const r of (
    await c.query(
      `select tracking_key, po_numbers::text pos, active, status_display from shipments where tracking_number = any($1::text[]) order by tracking_number`,
      [[KEEP, VARIANT]],
    )
  ).rows) console.log(JSON.stringify(r));

  // Mirror: cache has no active column, so update the kept row and DELETE the deactivated one.
  const db = new Database("aria-local.db", { timeout: 8000 });
  const upd = db
    .prepare(
      `UPDATE shipments_cache SET po_numbers=?, status_display=?, updated_at=datetime('now') WHERE tracking_number = ?`,
    )
    .run(JSON.stringify([]), "Freight PRO 64058928 - invoice 2978, ship 10/07/26 (customer sales order 23566017, no purchase order)", KEEP);
  const del = db.prepare(`DELETE FROM shipments_cache WHERE tracking_number = ?`).run(VARIANT);
  console.log(`\n[cache] updated ${upd.changes} / deleted ${del.changes}`);
  const left = db
    .prepare(`SELECT tracking_number, po_numbers, status_display FROM shipments_cache WHERE upper(tracking_number) LIKE '%6405892%'`)
    .all();
  console.log("[cache] read-back:", JSON.stringify(left, null, 1));
  db.close();

  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
