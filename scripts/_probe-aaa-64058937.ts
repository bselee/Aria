// Triage AAA Cooper PRO 64058937 (scanned BOL, no PO link).
// Decide: inbound dropship/vendor freight that needs a PO, or our own outbound
// freight that must stay unlinked.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PRO = "64058937";

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const s = await pg.query(
        `select tracking_number, carrier_name, tracking_kind, po_numbers, vendor_names,
                status_category, status_display, delivered_at::text delivered, active,
                last_source, source_confidence, created_at::text created
           from shipments
          where normalized_tracking_number = $1 or tracking_number like '%' || $1
          order by created_at desc`,
        [PRO],
    );
    console.log(`shipment rows for PRO ${PRO}: ${s.rowCount}`);
    for (const r of s.rows) console.log("  " + JSON.stringify(r));

    // any other AAA PRO nearby, to see the family and whether they carry POs
    const fam = await pg.query(
        `select tracking_number, po_numbers, vendor_names, status_category, created_at::date::text d
           from shipments
          where tracking_number like 'Generic:::640589%' or tracking_number like 'AAA%640589%'
          order by tracking_number`,
    );
    console.log(`\n640589xx family: ${fam.rowCount}`);
    for (const r of fam.rows) console.log("  " + JSON.stringify(r));

    // does any PO cite it, in either column?
    const poc = await pg.query(
        `select po_number, vendor_name, status, total_amount
           from purchase_orders where $1 = any(coalesce(tracking_numbers,'{}'::text[]))`,
        [`Generic:::${PRO}`],
    );
    console.log(`\nPOs citing Generic:::${PRO}: ${poc.rowCount}`);
    for (const r of poc.rows) console.log("  " + JSON.stringify(r));

    await pg.end();

    const db = new Database("aria-local.db", { readonly: true });
    const f = db.prepare(
        `select gmail_message_id, email_from, email_subject, matched_po_number, ocr_vendor_name,
                ocr_invoice_number, ocr_total, ocr_processed_at, forwarded_at
           from ap_local_forwards where ocr_raw_text like ? order by forwarded_at desc limit 6`,
    ).all(`%${PRO}%`);
    console.log(`\nap_local_forwards naming ${PRO}: ${f.length}`);
    for (const r of f) console.log("  " + JSON.stringify(r));

    const subj = db.prepare(
        `select gmail_message_id, email_from, email_subject, forwarded_at
           from ap_local_forwards where email_from like '%aaacooper%' or email_subject like '%AAA Cooper%'
          order by forwarded_at desc limit 8`,
    ).all();
    console.log(`\nAAA Cooper forwards (newest 8): ${subj.length}`);
    for (const r of subj) console.log("  " + JSON.stringify(r));

    const c = db.prepare("select tracking_number, po_numbers, status_category from shipments_cache where tracking_number like ?").all(`%${PRO}%`);
    console.log(`\nshipments_cache: ${JSON.stringify(c)}`);
    db.close();
})().catch((e) => console.error("ERR", e?.message || e));
