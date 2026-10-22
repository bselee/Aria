/**
 * @file    scripts/clear-sales-order-refs.ts
 * @purpose A bare 235xxxxx number in po_numbers may be a Finale SALES_ORDER
 *          (BuildASoil.com customer order), not a purchase order. Carrier paperwork prints
 *          it in its P.O.NUMBER/REF# boxes, so the ingest links shipments to a customer
 *          order that has no PO row behind it - a dangling ref that makes freight look
 *          PO-attributed and inflates PO-level coverage.
 *
 *          Found live on 2026-10-21: 23566017 (AAA Cooper PRO 64058928), 23565727, 23566087
 *          and 23545317 (7 parcel rows) - all orderTypeId=SALES_ORDER in Finale.
 *
 *          For each ref given: verify in Finale that orderTypeId is SALES_ORDER, then clear
 *          the ref from every citing shipment, keep the row active (it is real freight
 *          evidence), record the sales-order trace in source_refs, and mirror the dashboard
 *          cache. Refuses any ref that is a real purchase order or is not a SALES_ORDER.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/clear-sales-order-refs.ts <ref> [<ref>...] [--apply]
 */
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { FinaleClient } from "../src/lib/finale/client";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const REFS = args.filter((a) => !a.startsWith("--"));

async function main() {
  if (!REFS.length) {
    console.error("usage: clear-sales-order-refs.ts <ref> [<ref>...] [--apply]");
    process.exit(1);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const f = new FinaleClient();

  const cleared: { ref: string; trackings: string[]; type: string }[] = [];

  for (const ref of REFS) {
    // Guard 1: a ref that IS a live purchase order must never be cleared. A closed,
    // vendor-less stub is not a PO - it is the phantom the ingest created from this very
    // reference, and Finale (guard 2) decides what the number really is.
    const po = await c.query(
      `select po_number, vendor_name, status, total_amount,
              jsonb_array_length(coalesce(line_items,'[]'::jsonb)) lines
         from purchase_orders where po_number = $1`,
      [ref],
    );
    const stub = po.rows[0];
    const looksReal = stub && (stub.status !== "closed" || stub.vendor_name || Number(stub.total_amount) > 0 || stub.lines > 0);
    if (looksReal) {
      console.error(`REFUSING ${ref}: live purchase_orders row -> ${JSON.stringify(stub)}`);
      await c.end();
      process.exit(2);
    }
    if (stub) console.log(`${ref}: closed phantom stub in purchase_orders (vendor=${stub.vendor_name}, lines=${stub.lines}, status=${stub.status}) - proceeding`);
    // Guard 2: prove from Finale what the number actually is.
    let details: any = null;
    try {
      details = await f.getOrderDetails(ref);
    } catch (e: any) {
      console.error(`ABORT ${ref}: Finale lookup failed (${e.message}) - cannot prove it is a sales order`);
      await c.end();
      process.exit(2);
    }
    const type = `${details?.orderTypeId}/${details?.statusId}`;
    if (details?.orderTypeId !== "SALES_ORDER") {
      console.error(`REFUSING ${ref}: Finale says ${type}, not SALES_ORDER`);
      await c.end();
      process.exit(2);
    }
    const rows = await c.query(
      `select tracking_number, active from shipments where po_numbers @> ARRAY[$1]::text[] order by tracking_number`,
      [ref],
    );
    console.log(`${ref} ${type} -> ${rows.rows.length} shipment row(s): ${rows.rows.map((r: any) => r.tracking_number).join(", ") || "(none)"}`);
    cleared.push({ ref, type, trackings: rows.rows.map((r: any) => r.tracking_number) });
  }

  if (!APPLY) {
    console.log("\ndry run - pass --apply");
    await c.end();
    return;
  }

  for (const { ref, type, trackings } of cleared) {
    if (!trackings.length) continue;
    const note = JSON.stringify([
      {
        source: "manual_repair",
        sourceRef: `finale:order/${ref}`,
        seenAt: new Date().toISOString(),
        note:
          `Finale resolves ${ref} as ${type} - a customer SALES ORDER, not a purchase order. ` +
          `Carrier paperwork printed it in its P.O.NUMBER/REF# box, so the ingest linked this shipment to a ` +
          `customer order with no PO row behind it. Ref moved to source_refs; shipment kept as freight evidence.`,
      },
    ]);
    const upd = await c.query(
      `update shipments
          set po_numbers = array_remove(po_numbers, $1::text),
              source_refs = coalesce(source_refs, '[]'::jsonb) || $2::jsonb,
              updated_at = now()
        where po_numbers @> ARRAY[$1]::text[]
        returning tracking_number`,
      [ref, note],
    );
    console.log(`[pg] cleared ${ref} from ${upd.rowCount} row(s)`);

    const db = new Database("aria-local.db", { timeout: 8000 });
    const all = db.prepare(`SELECT tracking_number, po_numbers FROM shipments_cache`).all() as any[];
    const st = db.prepare(`UPDATE shipments_cache SET po_numbers=?, updated_at=datetime('now') WHERE tracking_number = ?`);
    let hits = 0;
    for (const row of all) {
      let refs: string[] = [];
      try {
        refs = JSON.parse(row.po_numbers || "[]").map(String);
      } catch {
        continue;
      }
      if (!refs.includes(ref)) continue;
      st.run(JSON.stringify(refs.filter((x) => x !== ref)), row.tracking_number);
      hits++;
    }
    db.close();
    console.log(`[cache] cleared ${ref} from ${hits} row(s)`);
  }

  console.log("\n== read-back: any row still citing these refs ==");
  for (const { ref } of cleared) {
    const left = await c.query(`select count(*) n from shipments where po_numbers @> ARRAY[$1]::text[]`, [ref]);
    console.log(`${ref}: ${left.rows[0].n} row(s) remaining`);
  }
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
