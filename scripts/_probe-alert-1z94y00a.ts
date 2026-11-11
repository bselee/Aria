// UPS 1Z94Y00A6718975526 arrived with no PO. Before guessing, find the source
// document: the shipment row names the email, and the email names the shipment.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const TN = "1Z94Y00A6718975526";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const s = await c.query(
        `select tracking_number, tracking_key, carrier_name, status_category, status_display,
                estimated_delivery_at, delivered_at, last_checked_at, po_numbers, vendor_names,
                last_source, source_confidence, source_refs, active, created_at
           from shipments where normalized_tracking_number = $1`,
        [TN],
    );
    console.log(`shipments rows: ${s.rowCount}`);
    for (const r of s.rows) {
        console.log(`  key=${r.tracking_key} carrier=${r.carrier_name} active=${r.active}`);
        console.log(`  po_numbers=${JSON.stringify(r.po_numbers)} vendor_names=${JSON.stringify(r.vendor_names)}`);
        console.log(`  status=${r.status_category} (${r.status_display}) eta=${r.estimated_delivery_at} delivered=${r.delivered_at}`);
        console.log(`  source=${r.last_source} conf=${r.source_confidence} created=${r.created_at}`);
        for (const ref of r.source_refs ?? []) {
            console.log(`  ref: source=${ref.source} ref=${ref.sourceRef} conf=${ref.confidence} at=${ref.observedAt ?? "-"}`);
        }
    }

    // Does any PO claim it already (either encoding)?
    const claimed = await c.query(
        `select po_number, vendor_name, status, total_amount
           from purchase_orders
          where tracking_numbers && array[$1,$2]::text[]`,
        [TN, "UPS:::" + TN],
    );
    console.log(`\nPOs claiming this tracking: ${claimed.rowCount}`);
    for (const r of claimed.rows) console.log(`  ${r.po_number} | ${r.vendor_name} | ${r.status} | $${r.total_amount}`);

    // Same-size neighbourhood: is this number part of a batch (other 1Z94Y00A... rows)?
    const kin = await c.query(
        `select tracking_number, po_numbers, created_at from shipments
          where tracking_number like '1Z94Y00A%' order by created_at desc limit 10`,
    );
    console.log(`\n1Z94Y00A* siblings in shipments: ${kin.rowCount}`);
    for (const r of kin.rows) console.log(`  ${r.tracking_number} -> ${JSON.stringify(r.po_numbers)} (${String(r.created_at).slice(0, 10)})`);

    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
