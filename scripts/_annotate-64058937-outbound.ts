// Annotate 64058937 as outbound freight. It has no PO by design, and the row
// must say why — "Tracking from scanned BOL (vision OCR)" is not an explanation.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const DISPLAY =
    "Delivered 10/26 — outbound BUILDASOIL Montrose to New Earth Louisville KY (customer freight, no purchase order), statement 3036";

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const b = await pg.query(
        "select tracking_number, status_category, status_display, delivered_at::text d, po_numbers, vendor_names from shipments where normalized_tracking_number = '64058937'",
    );
    console.log("before:", JSON.stringify(b.rows[0]));
    if (APPLY) {
        const r = await pg.query(
            "update shipments set status_display = $1 where normalized_tracking_number = '64058937'",
            [DISPLAY],
        );
        console.log("pg rows:", r.rowCount);
        const db = new Database("aria-local.db");
        const c = db
            .prepare("update shipments_cache set status_display = ?, updated_at = ? where tracking_number = ?")
            .run(DISPLAY, new Date().toISOString(), "AAA Cooper:::64058937");
        console.log("cache rows:", c.changes);
        db.close();
    }
    const a = await pg.query(
        "select tracking_number, status_category, status_display, delivered_at::text d, po_numbers from shipments where normalized_tracking_number = '64058937'",
    );
    console.log("after:", JSON.stringify(a.rows[0]));
    await pg.end();
    if (!APPLY) console.log("dry run");
})().catch((e) => console.error("ERR", e?.message || e));
