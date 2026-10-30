// Alert: UPS 1ZH4D1120321913678 -> PO 125332 (email tracking ingest).
// The words "email tracking ingest" cover both a confirmed link and a 0.6 vendor
// guess, so establish which one this is before trusting the PO.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const TN = "1ZH4D1120321913678";
const PO = "125332";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const ship = await c.query(
        `select tracking_number, carrier_name, status_category, status_display, estimated_delivery_at,
                delivered_at, last_checked_at, po_numbers, vendor_names, last_source, source_confidence,
                source_refs, created_at
           from shipments where normalized_tracking_number = $1 or tracking_key ilike '%'||$1||'%'`,
        [TN],
    );
    console.log("shipments:", ship.rowCount);
    for (const r of ship.rows) console.log(JSON.stringify(r, null, 1));

    const po = await c.query(
        `select po_number, vendor_name, status, total_amount, created_at, tracking_numbers
           from purchase_orders where po_number in ($1, 'PO'||$1, 'PO-'||$1)`,
        [PO],
    );
    console.log("\npurchase_orders:", po.rowCount);
    for (const r of po.rows) {
        console.log(JSON.stringify({
            po_number: r.po_number, vendor: r.vendor_name, status: r.status, total: r.total_amount,
            created: r.created_at, n_tracking: (r.tracking_numbers ?? []).length,
            tracking_sample: (r.tracking_numbers ?? []).slice(0, 6),
        }, null, 1));
    }

    const others = await c.query(
        `select tracking_number, carrier_name, status_category, delivered_at, last_source, source_confidence
           from shipments where $1 = any(po_numbers) order by created_at desc`,
        [PO],
    );
    console.log(`\nshipments citing PO ${PO}: ${others.rowCount}`);
    for (const r of others.rows.slice(0, 25)) console.log("  " + JSON.stringify(r));
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
