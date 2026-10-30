import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const ids = ["125332", "125341"];
    for (const id of ids) {
        const po = await c.query(
            `select po_number, vendor_name, status, total_amount, created_at, tracking_numbers
               from purchase_orders where po_number in ($1, 'PO'||$1, 'PO-'||$1)`,
            [id],
        );
        console.log(`PO ${id}: ${po.rowCount} row(s)`);
        for (const r of po.rows) {
            console.log(`   vendor=${r.vendor_name} status=${r.status} total=${r.total_amount} created=${String(r.created_at).slice(0, 10)} n_tracking=${(r.tracking_numbers ?? []).length} ${JSON.stringify((r.tracking_numbers ?? []).slice(0, 4))}`);
        }
        const cite = await c.query(
            `select count(*)::int n from shipments where $1 = any(po_numbers)`,
            [id],
        );
        console.log(`   shipments citing it: ${cite.rows[0].n}`);
    }
    // Both POs, same vendor?
    const vend = await c.query(
        `select distinct vendor_name from purchase_orders where po_number in ('125332','125341')`,
    );
    console.log("vendors:", JSON.stringify(vend.rows));
    // Recent Grassroots POs — is 125341 a sibling in the same order window?
    const sib = await c.query(
        `select po_number, vendor_name, status, total_amount, created_at::date d
           from purchase_orders
          where vendor_name ilike '%grassroots%' and created_at >= '2026-09-15'
          order by created_at`,
    );
    console.log("Grassroots POs since 9/15:");
    for (const r of sib.rows) console.log(`   ${r.po_number} ${r.vendor_name} ${r.status} $${r.total_amount} ${r.d}`);
    await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
