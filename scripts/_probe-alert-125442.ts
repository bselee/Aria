// Alert: PO 125442 / UPS 1Z79E8500353064989 — is the attribution real?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const TN = "1Z79E8500353064989";
const PO = "125442";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const ship = await c.query(
        `select id, tracking_key, tracking_number, carrier_name, status_category, status_display,
                po_numbers, vendor_names, estimated_delivery_at, delivered_at, last_checked_at,
                active, last_source, source_confidence, source_refs, created_at
           from shipments
          where tracking_number = $1 or normalized_tracking_number = $1 or tracking_key ilike '%'||$1||'%'`,
        [TN],
    );
    console.log("shipments rows:", ship.rowCount);
    for (const r of ship.rows) console.log(JSON.stringify(r, null, 1));

    // Who else claims this PO?
    const po = await c.query(
        `select po_number, vendor_name, status, total_amount, created_at, tracking_numbers
           from purchase_orders where po_number in ($1, 'PO'||$1, 'PO-'||$1)`,
        [PO],
    );
    console.log("\npurchase_orders rows:", po.rowCount);
    for (const r of po.rows) console.log(JSON.stringify({ ...r, tracking_numbers: `[${(r.tracking_numbers ?? []).length}] ${(r.tracking_numbers ?? []).slice(0, 5).join(", ")}` }, null, 1));

    // Other shipments claiming this PO — magnet check.
    const others = await c.query(
        `select tracking_number, carrier_name, status_category, delivered_at, last_source, source_confidence
           from shipments where $1 = any(po_numbers) order by created_at desc limit 20`,
        [PO],
    );
    console.log(`\nshipments citing PO ${PO}: ${others.rowCount}`);
    for (const r of others.rows) console.log("  " + JSON.stringify(r));

    // AP forwards naming it.
    const ap = await c.query(
        `select gmail_message_id, vendor_name, invoice_number, matched_po_number, created_at
           from ap_local_forwards
          where matched_po_number like '%'||$1||'%' order by created_at desc limit 10`,
        [PO],
    );
    console.log(`\nap forwards naming ${PO}: ${ap.rowCount}`);
    for (const r of ap.rows) console.log("  " + JSON.stringify(r));

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
