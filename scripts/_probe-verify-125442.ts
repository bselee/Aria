// Post-poll verification: did PG and BOTH caches land, and is the vendor known?
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { Client } from "pg";
import Database from "better-sqlite3";

const TN = "1Z79E8500353064989";
const PO = "125442";

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const s = await c.query(
        `select tracking_number, status_category, status_display, estimated_delivery_at, delivered_at,
                last_checked_at, last_source, source_confidence, vendor_names, po_numbers
           from shipments where tracking_number = $1`,
        ["UPS:::" + TN],
    );
    console.log("PG shipment:", JSON.stringify(s.rows[0] ?? null));
    const p = await c.query(`select po_number, vendor_name, status, total_amount, tracking_numbers from purchase_orders where po_number = $1`, [PO]);
    console.log("PG po:", JSON.stringify(p.rows[0] ?? null));

    // Vendor knowledge for the sender domain.
    const vd = await c.query(`select domain, vendor_name from vendor_domains where domain ilike '%centec%'`);
    console.log("vendor_domains:", JSON.stringify(vd.rows));
    const vp = await c.query(`select vendor_name, orders_email from vendor_profiles where vendor_name ilike '%cen-tec%' or vendor_name ilike '%centec%'`);
    console.log("vendor_profiles:", JSON.stringify(vp.rows));

    await c.end();

    const db = new Database("aria-local.db", { readonly: true });
    const sc = db.prepare("select tracking_number, po_numbers, status_category, status_display, estimated_delivery_at, last_checked_at from shipments_cache where lower(tracking_number) = lower(?)").all("ups:::" + TN);
    console.log("shipments_cache:", JSON.stringify(sc));
    const pc = db.prepare("select * from po_cache where po_number = ?").all(PO);
    console.log("po_cache row present:", pc.length > 0);
    if (pc.length) {
        const r: any = pc[0];
        console.log("  po_cache:", JSON.stringify({ po_number: r.po_number, status: r.status, vendor_name: r.vendor_name, tracking_count: (() => { try { return JSON.parse(r.tracking_numbers || "[]").length; } catch { return "n/a"; } })() }));
    }
    db.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
