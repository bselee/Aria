// FedEx 466970002259 with no PO match. Find what document produced it, then
// decide: attributable-but-unlinked, or genuinely no PO (vendor direct order).
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const TN = "466970002259";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    const s = await c.query(
        `select tracking_number, tracking_key, carrier_name, tracking_kind, status_category,
                status_display, estimated_delivery_at, delivered_at, last_checked_at,
                po_numbers, vendor_names, last_source, source_confidence, source_refs, active, created_at
           from shipments where normalized_tracking_number = $1`,
        [TN],
    );
    console.log(`shipments rows: ${s.rowCount}`);
    for (const r of s.rows) {
        console.log(`  key=${r.tracking_key} carrier=${r.carrier_name} kind=${r.tracking_kind} active=${r.active}`);
        console.log(`  po_numbers=${JSON.stringify(r.po_numbers)} vendor_names=${JSON.stringify(r.vendor_names)}`);
        console.log(`  status=${r.status_category} (${r.status_display}) eta=${r.estimated_delivery_at} delivered=${r.delivered_at}`);
        console.log(`  source=${r.last_source}@${r.source_confidence} created=${r.created_at} checked=${r.last_checked_at}`);
        for (const ref of r.source_refs ?? []) console.log(`     ref ${ref.source}:${ref.sourceRef}@${ref.confidence}`);
    }

    const claimed = await c.query(
        `select po_number, vendor_name, status, total_amount from purchase_orders
          where tracking_numbers && array[$1,$2,$3]::text[]`,
        [TN, "FedEx:::" + TN, "FedEx:::466970002259"],
    );
    console.log(`\nPOs claiming it: ${claimed.rowCount}`);
    for (const r of claimed.rows) console.log(`  ${r.po_number} | ${r.vendor_name} | ${r.status} | $${r.total_amount}`);

    // Same 466970* prefix: is it a known vendor's batch?
    const kin = await c.query(
        `select tracking_number, po_numbers, vendor_names, created_at from shipments
          where tracking_number like '466970%' order by created_at desc limit 8`,
    );
    console.log(`\n466970* siblings: ${kin.rowCount}`);
    for (const r of kin.rows) console.log(`  ${r.tracking_number} -> ${JSON.stringify(r.po_numbers)} ${JSON.stringify(r.vendor_names)}`);
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
