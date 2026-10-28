// Bridge-side corpus measure after the ORDER-drop + Number-connector pass:
// live extractPONumberFromText vs what AP stored, 200 recent forwards.
import Database from "better-sqlite3";
import { extractPONumberFromText } from "../src/lib/tracking/invoice-tracking-bridge";

const db = new Database("aria-local.db", { readonly: true });
const rows = db
    .prepare(
        `select gmail_message_id, email_subject, ocr_raw_text, matched_po_number
           from ap_local_forwards
          where ocr_raw_text is not null and length(ocr_raw_text) > 40
          order by coalesce(ocr_processed_at, forwarded_at) desc
          limit 200`,
    )
    .all() as Array<{ gmail_message_id: string; email_subject: string | null; ocr_raw_text: string; matched_po_number: string | null }>;
db.close();

const b: Record<string, Array<{ id: string; s: string; subject: string }>> = {
    NEW_LINK: [],
    AGREE: [],
    CONFLICT: [],
    DROPPED: [],
    NEITHER: [],
};
for (const r of rows) {
    const live = extractPONumberFromText(r.ocr_raw_text);
    const stored = (r.matched_po_number ?? "").trim();
    const item = { id: r.gmail_message_id, s: live ?? "null", subject: (r.email_subject ?? "").slice(0, 58) };
    if (!live && !stored) b.NEITHER.push(item);
    else if (!live) b.DROPPED.push(item);
    else if (!stored) b.NEW_LINK.push(item);
    else if (live.toLowerCase() === stored.toLowerCase()) b.AGREE.push(item);
    else b.CONFLICT.push(item);
}
for (const k of ["NEW_LINK", "CONFLICT", "DROPPED", "AGREE"]) {
    console.log(`\n${k} (${b[k].length})`);
    for (const i of b[k].slice(0, 8)) console.log(`  ${i.id} live=${i.s} | ${i.subject}`);
    if (b[k].length > 8) console.log(`  ... ${b[k].length - 8} more`);
}
console.log(
    `\nrows=${rows.length} newLink=${b.NEW_LINK.length} agree=${b.AGREE.length} conflict=${b.CONFLICT.length} ` +
        `dropped=${b.DROPPED.length} neither=${b.NEITHER.length}`,
);
