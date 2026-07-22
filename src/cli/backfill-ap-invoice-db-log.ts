/**
 * @file    src/cli/backfill-ap-invoice-db-log.ts
 * @purpose Re-parse OCR already stored on ap_local_forwards and carefully log
 *          structured fields + vendor_invoices + invoice_cache. No re-forward.
 * @usage   node --import tsx --env-file=.env.local src/cli/backfill-ap-invoice-db-log.ts
 *          node --import tsx --env-file=.env.local src/cli/backfill-ap-invoice-db-log.ts --vendor=worm
 */
import { getLocalDb } from "../lib/storage/local-db";
import { normalizeInvoiceForDb } from "../lib/pdf/invoice-field-normalize";
import { parseInvoice } from "../lib/pdf/invoice-parser";
import { upsertVendorInvoice } from "../lib/storage/vendor-invoices";
import { upsertInvoiceCache } from "../lib/storage/purchasing-cache";

async function main() {
    const vendorFilter = (process.argv.find((a) => a.startsWith("--vendor=")) || "").slice("--vendor=".length).toLowerCase();
    const db = getLocalDb();

    let rows = db
        .prepare(
            `SELECT id, gmail_message_id, email_from, email_subject, pdf_filename,
                    ocr_raw_text, ocr_invoice_number, ocr_total, matched_po_number, status
             FROM ap_local_forwards
             WHERE status = 'FORWARDED'
               AND ocr_raw_text IS NOT NULL
               AND length(ocr_raw_text) > 40
             ORDER BY id DESC
             LIMIT 200`,
        )
        .all() as Array<{
        id: number;
        gmail_message_id: string;
        email_from: string;
        email_subject: string;
        pdf_filename: string;
        ocr_raw_text: string;
        ocr_invoice_number: string | null;
        ocr_total: string | null;
        matched_po_number: string | null;
        status: string;
    }>;

    if (vendorFilter) {
        rows = rows.filter(
            (r) =>
                (r.email_from || "").toLowerCase().includes(vendorFilter) ||
                (r.ocr_raw_text || "").toLowerCase().includes(vendorFilter) ||
                (r.pdf_filename || "").toLowerCase().includes(vendorFilter),
        );
    }

    console.log(`Backfill candidates: ${rows.length}`);
    let ok = 0;
    let fail = 0;

    for (const row of rows) {
        try {
            let parsed: any = null;
            try {
                parsed = await parseInvoice(row.ocr_raw_text);
            } catch {
                /* regex fallback still works */
            }
            const vendorHint = /ambriole|deeremother|earth\s*worms/i.test(row.email_from + row.ocr_raw_text)
                ? "Down to Earth Worms"
                : undefined;
            const norm = normalizeInvoiceForDb(parsed, row.ocr_raw_text, { vendorHint });
            if (!norm.poNumber) {
                const m = (row.email_subject || "").match(/(?:PO|P\.?O\.?)\s*#?\s*-?(\d{4,6})/i);
                if (m) norm.poNumber = m[1].padStart(5, "0");
            }

            db.prepare(
                `UPDATE ap_local_forwards
                 SET ocr_vendor_name = ?,
                     ocr_invoice_number = ?,
                     ocr_total = ?,
                     ocr_freight = ?,
                     ocr_tax = ?,
                     ocr_line_items = ?,
                     matched_po_number = COALESCE(?, matched_po_number),
                     ocr_processed_at = datetime('now'),
                     reconciliation_status = CASE
                       WHEN ? IS NOT NULL AND (reconciliation_status IS NULL OR reconciliation_status = '' OR reconciliation_status = 'PO_UNMATCHED')
                       THEN 'PO_CANDIDATE'
                       ELSE reconciliation_status
                     END,
                     reconciliation_notes = COALESCE(reconciliation_notes, ?)
                 WHERE id = ?`,
            ).run(
                norm.vendorName,
                norm.invoiceNumber,
                norm.total ? String(norm.total) : null,
                norm.freight ? String(norm.freight) : null,
                norm.tax ? String(norm.tax) : null,
                norm.lineItems.length ? JSON.stringify(norm.lineItems) : null,
                norm.poNumber,
                norm.poNumber,
                norm.poNumber
                    ? `Backfill OCR; PO candidate ${norm.poNumber}`
                    : "Backfill OCR; no PO# — needs match",
                row.id,
            );

            const localId = `apfwd:${row.gmail_message_id}:${row.pdf_filename}`.slice(0, 180);
            upsertInvoiceCache({
                vendor_invoice_id: localId,
                vendor_name: norm.vendorName,
                invoice_number: norm.invoiceNumber,
                invoice_date: norm.invoiceDate,
                due_date: null,
                po_number: norm.poNumber,
                total: norm.total,
                freight: norm.freight,
                tax: norm.tax,
                status: "received",
                line_items: JSON.stringify(norm.lineItems),
                source: "email_attachment",
                matched_po: norm.poNumber,
                match_confidence: norm.poNumber ? "ocr_po_field" : null,
            });
            db.prepare(
                `UPDATE invoice_cache SET expire_at = datetime('now', '+365 days') WHERE vendor_invoice_id = ?`,
            ).run(localId);

            const vid = await upsertVendorInvoice({
                vendor_name: norm.vendorName,
                invoice_number: norm.invoiceNumber,
                invoice_date: norm.invoiceDate,
                po_number: norm.poNumber,
                subtotal: norm.subtotal,
                freight: norm.freight,
                tax: norm.tax,
                total: norm.total,
                status: "received",
                source: "email_attachment",
                source_ref: row.gmail_message_id,
                line_items: norm.lineItems,
                raw_data: {
                    backfill: true,
                    pdf_filename: row.pdf_filename,
                    local_cache_id: localId,
                },
                notes: "Backfill from ap_local_forwards OCR 2026-07-17",
            });

            console.log(
                `✓ id=${row.id} ${row.pdf_filename} inv#=${norm.invoiceNumber || "—"} PO=${norm.poNumber || "—"} total=${norm.total || "—"} pgrst=${vid || "null"}`,
            );
            ok++;
        } catch (e: any) {
            console.error(`✗ id=${row.id}: ${e?.message || e}`);
            fail++;
        }
    }

    console.log(`\nDone: ok=${ok} fail=${fail}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
