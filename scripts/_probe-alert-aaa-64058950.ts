// AAA Cooper PRO 64058950 with "no PO linked yet". The AAA family has two live
// traps: an outbound shipment of ours has no PO at all, and the carrier page
// throttles (silence is not a status). Start from the BOL document.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const PRO = "64058950";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const s = await c.query(
        `select tracking_number, tracking_key, carrier_name, tracking_kind, status_category,
                status_display, estimated_delivery_at, delivered_at, last_checked_at,
                po_numbers, vendor_names, last_source, source_confidence, source_refs, active, created_at
           from shipments where normalized_tracking_number = $1`,
        [PRO],
    );
    console.log(`shipments rows: ${s.rowCount}`);
    for (const r of s.rows) {
        console.log(`  key=${r.tracking_key} carrier=${r.carrier_name} kind=${r.tracking_kind} active=${r.active}`);
        console.log(`  po_numbers=${JSON.stringify(r.po_numbers)} vendor_names=${JSON.stringify(r.vendor_names)}`);
        console.log(`  status=${r.status_category} (${r.status_display}) eta=${r.estimated_delivery_at} delivered=${r.delivered_at}`);
        console.log(`  source=${r.last_source}@${r.source_confidence} created=${r.created_at} checked=${r.last_checked_at}`);
        for (const ref of r.source_refs ?? []) console.log(`     ref ${ref.source}@${ref.confidence}: ${ref.sourceRef}`);
    }

    // Neighbourhood: the AAA family we already adjudicated (outbound vs vendor).
    const kin = await c.query(
        `select tracking_number, po_numbers, vendor_names, status_category, created_at
           from shipments where tracking_number like 'AAA%' or normalized_tracking_number ~ '^640589[0-9]{2}$'
          order by created_at desc limit 12`,
    );
    console.log(`\nAAA neighbourhood (${kin.rowCount}):`);
    for (const r of kin.rows) {
        console.log(`  ${r.tracking_number} -> ${JSON.stringify(r.po_numbers)} vendor=${JSON.stringify(r.vendor_names)} ${r.status_category} ${String(r.created_at).slice(0, 10)}`);
    }
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
