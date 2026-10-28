// Verify tracking-autopilot's three FedEx claims against the live ledger.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const trackings = ["520484904168", "520484904180", "520484902420"];
const claimed: Record<string, string> = {
    "520484904168": "23550677-DropshipPO",
    "520484904180": "23554477-S-DropshipPO",
    "520484902420": "23542337-S-Dropship",
};

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    console.log("=== shipment rows (PG) ===");
    for (const t of trackings) {
        const r = await c.query(
            `select tracking_number, carrier_name, tracking_kind, po_numbers, vendor_names,
                    status_category, status_display, estimated_delivery_at::date::text eta,
                    active, last_source, source_confidence
               from shipments where normalized_tracking_number = $1 or tracking_number = $1`,
            [t],
        );
        console.log(`\n${t}  claimed=${claimed[t]}`);
        if (!r.rowCount) console.log("  NO ROW in PG");
        for (const x of r.rows) console.log("  " + JSON.stringify(x));
    }

    console.log("\n=== claimed POs ===");
    for (const po of new Set(Object.values(claimed))) {
        const r = await c.query(
            `select po_number, vendor_name, status, total_amount, created_at::date::text created,
                    array_length(tracking_numbers,1) n_tracking
               from purchase_orders where po_number = $1 or po_number ilike $1 || '%'`,
            [po],
        );
        console.log(`\n${po}`);
        if (!r.rowCount) console.log("  NO PO ROW");
        for (const x of r.rows) console.log("  " + JSON.stringify(x));
    }

    console.log("\n=== other shipments already citing those POs ===");
    for (const po of new Set(Object.values(claimed))) {
        const r = await c.query(
            `select tracking_number, carrier_name, status_category, active, source_confidence
               from shipments where $1 = any(po_numbers) order by created_at desc limit 5`,
            [po],
        );
        console.log(`\n${po} — ${r.rowCount} row(s)`);
        for (const x of r.rows) console.log("  " + JSON.stringify(x));
    }
    await c.end();

    const db = new Database("aria-local.db", { readonly: true });
    console.log("\n=== cache ===");
    for (const t of trackings) {
        const r = db
            .prepare("select tracking_number, po_numbers, status_display, estimated_delivery_at from shipments_cache where tracking_number like ?")
            .all(`%${t}%`);
        console.log(`${t} -> ${JSON.stringify(r)}`);
    }
    db.close();
})().catch((e) => console.error("ERR", e?.message || e));
