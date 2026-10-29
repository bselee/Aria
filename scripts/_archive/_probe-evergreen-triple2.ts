// Where did these three rows come from? source_refs + timestamps, and the AP
// forward that matches the PO, so the pairing can be checked against a document.
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
    for (const t of ["520484904168", "520484904180", "520484902420"]) {
        const r = await c.query(
            `select tracking_number, created_at, last_checked_at, source_refs
               from shipments where normalized_tracking_number = $1`,
            [t],
        );
        console.log(`\n${t}`);
        for (const x of r.rows) console.log("  " + JSON.stringify(x));
    }
    const ap = await c.query(
        `select gmail_message_id, email_subject, matched_po_number, status, forwarded_at
           from ap_local_forwards
          where matched_po_number in ('23550677-DropshipPO','23554477-S-DropshipPO','23542337-S-DropshipPO')
          order by forwarded_at desc limit 10`,
    );
    console.log(`\n=== AP forwards matching those POs (${ap.rowCount}) ===`);
    for (const x of ap.rows) console.log("  " + JSON.stringify(x));
    await c.end();

    const db = new Database("aria-local.db", { readonly: true });
    const local = await Promise.all(
        ["23550677", "23554477", "23542337"].map(async (base) => {
            const rows = db
                .prepare(
                    `select gmail_message_id, email_subject, matched_po_number, ocr_invoice_number, ocr_total, ocr_processed_at
                       from ap_local_forwards where matched_po_number like ? or ocr_raw_text like ? limit 4`,
                )
                .all(`${base}%`, `%${base}%`);
            return { base, rows };
        }),
    );
    for (const l of local) {
        console.log(`\n=== local forwards ~${l.base} ===`);
        for (const r of l.rows) console.log("  " + JSON.stringify(r));
    }
    db.close();
})().catch((e) => console.error("ERR", e?.message || e));
