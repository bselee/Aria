// Verify a genuinely new tracking-autopilot claim: FedEx 520484909104 -> PO 23580437-DropshipPO.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const TN = "520484909104";
const PO = "23580437-DropshipPO";

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const s = await pg.query(
        `select tracking_number, carrier_name, tracking_kind, po_numbers, vendor_names,
                status_category, status_display, estimated_delivery_at::text eta,
                delivered_at::text delivered, active, last_source, source_confidence,
                created_at::text created
           from shipments where normalized_tracking_number = $1 or tracking_number like '%' || $1`,
        [TN],
    );
    console.log(`shipment rows for ${TN}: ${s.rowCount}`);
    for (const r of s.rows) console.log("  " + JSON.stringify(r));

    const po = await pg.query(
        `select po_number, vendor_name, status, total_amount, created_at::date::text created,
                tracking_numbers, coalesce(array_length(tracking_numbers,1),0) n_track
           from purchase_orders where po_number = $1 or po_number ilike $2`,
        [PO, PO.replace(/-DropshipPO$/, "") + "%"],
    );
    console.log(`\nPO family for ${PO}:`);
    for (const r of po.rows) console.log("  " + JSON.stringify(r));

    const others = await pg.query(
        `select tracking_number, status_category, active from shipments where $1 = any(po_numbers)`,
        [PO],
    );
    console.log(`\nother shipments citing ${PO}: ${others.rowCount}`);
    for (const r of others.rows) console.log("  " + JSON.stringify(r));

    // neighbouring Evergreen-style numbers already in the ledger, for family context
    const fam = await pg.query(
        `select tracking_number, po_numbers, status_category, created_at::date::text d
           from shipments where normalized_tracking_number like '52048490%' order by tracking_number`,
    );
    console.log(`\n52048490xxxx family in ledger: ${fam.rowCount}`);
    for (const r of fam.rows) console.log("  " + JSON.stringify(r));

    await pg.end();

    const db = new Database("aria-local.db", { readonly: true });
    const c = db.prepare("select tracking_number, po_numbers, status_display, estimated_delivery_at from shipments_cache where tracking_number like ?").all(`%${TN}%`);
    console.log(`\nshipments_cache: ${c.length} row(s) ${JSON.stringify(c)}`);
    const f = db.prepare("select gmail_message_id, email_from, email_subject, matched_po_number, ocr_vendor_name, ocr_invoice_number, ocr_total, ocr_processed_at, forwarded_at from ap_local_forwards where ocr_raw_text like ? order by forwarded_at desc limit 5").all(`%${TN}%`);
    console.log(`ap_local_forwards naming ${TN}: ${f.length}`);
    for (const r of f) console.log("  " + JSON.stringify(r));
    const g = db.prepare("select gmail_message_id, email_subject, matched_po_number, ocr_vendor_name, ocr_total from ap_local_forwards where matched_po_number = ? limit 5").all(PO);
    console.log(`forwards matched to ${PO}: ${g.length}`);
    for (const r of g) console.log("  " + JSON.stringify(r));
    db.close();
})().catch((e) => console.error("ERR", e?.message || e));
