// Three FedEx numbers, three dropship POs. Sequential numbers smell like one
// manifest batch — the class that attached every tracking to every PO. Prove each.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

const PAIRS = [
    ["520484910862", "23591917-DropshipPO"],
    ["520484910873", "23591647-S-DropshipPO"],
    ["520484910830", "23591137-DropshipPO"],
];

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    for (const [tn, po] of PAIRS) {
        console.log(`\n=== ${tn} -> ${po} ===`);
        const ship = await c.query(
            `select tracking_number, status_category, status_display, estimated_delivery_at, delivered_at,
                    last_checked_at, po_numbers, vendor_names, last_source, source_confidence, source_refs, created_at
               from shipments where normalized_tracking_number = $1 or tracking_key ilike '%'||$1||'%'`,
            [tn],
        );
        console.log(`shipments rows: ${ship.rowCount}`);
        for (const r of ship.rows) {
            console.log(`  po_numbers=${JSON.stringify(r.po_numbers)} status=${r.status_category} (${r.status_display})`);
            console.log(`  delivered=${r.delivered_at} eta=${r.estimated_delivery_at} last_checked=${r.last_checked_at}`);
            console.log(`  source=${r.last_source} conf=${r.source_confidence} created=${r.created_at}`);
            console.log(`  refs=${JSON.stringify((r.source_refs ?? []).map((x: any) => `${x.source}:${x.sourceRef ?? "-"}@${x.confidence}`))}`);
        }

        const p = await c.query(
            `select po_number, vendor_name, status, total_amount, created_at, tracking_numbers
               from purchase_orders where po_number = $1`,
            [po],
        );
        console.log(`PO rows: ${p.rowCount}`);
        for (const r of p.rows) {
            console.log(`  ${r.po_number} | ${r.vendor_name} | ${r.status} | $${r.total_amount} | created ${String(r.created_at).slice(0, 10)}`);
            console.log(`  tracking (${(r.tracking_numbers ?? []).length}): ${JSON.stringify(r.tracking_numbers ?? [])}`);
        }

        // Magnet check: how many POs claim this tracking number, and how many
        // shipments claim this PO?
        const claimPOs = await c.query(
            `select po_number from purchase_orders where $1 = any(tracking_numbers)`,
            ["FedEx:::" + tn],
        );
        const claimPOs2 = await c.query(
            `select po_number from purchase_orders where $1 = any(tracking_numbers)`,
            [tn],
        );
        console.log(`  POs claiming this tracking: ${claimPOs.rowCount} (FedEx::: prefixed) / ${claimPOs2.rowCount} (bare)`);
        if (claimPOs.rowCount > 1) console.log("    " + claimPOs.rows.map((r: any) => r.po_number).join(", "));
        const citers = await c.query(
            `select count(*)::int n from shipments where $1 = any(po_numbers)`,
            [po],
        );
        console.log(`  shipments citing this PO: ${citers.rows[0].n}`);
    }
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
