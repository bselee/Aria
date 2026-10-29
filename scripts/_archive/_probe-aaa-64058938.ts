import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const s = await c.query(
        "select tracking_number, source_refs, status_display, created_at::text from shipments where normalized_tracking_number = '64058938'",
    );
    console.log("shipment:", JSON.stringify(s.rows[0], null, 1));
    await c.end();

    const db = new Database("aria-local.db", { readonly: true });
    const f = db
        .prepare(
            `select gmail_message_id, email_from, email_subject, matched_po_number, ocr_vendor_name, ocr_invoice_number, ocr_total, forwarded_at
               from ap_local_forwards where ocr_raw_text like '%64058938%' order by forwarded_at desc limit 4`,
        )
        .all();
    console.log(`forwards naming 64058938: ${f.length}`);
    for (const r of f) console.log("  " + JSON.stringify(r));
    const near = db
        .prepare(
            `select gmail_message_id, email_subject, forwarded_at from ap_local_forwards
              where email_subject like '%Stmt%' or email_subject like '%Statement%' order by forwarded_at desc limit 4`,
        )
        .all();
    console.log("recent statement forwards:");
    for (const r of near) console.log("  " + JSON.stringify(r));
    db.close();
})().catch((e) => console.error("ERR", e?.message || e));
