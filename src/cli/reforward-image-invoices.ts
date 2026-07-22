/**
 * @file    src/cli/reforward-image-invoices.ts
 * @purpose One-shot: pull Gmail messages that only had image invoices (e.g. Gary
 *          Ambriole / Down to Earth Worms), convert JPEG/PNG → PDF, forward once
 *          to Bill.com via single-forward gate, and enrich vendor_invoices for
 *          PO matching. Bypasses unread/inbox filters (messages were already
 *          marked read when the old PDF-only path skipped them).
 * @author  Hermia
 * @created 2026-07-17
 * @usage   node --import tsx --env-file=.env.local src/cli/reforward-image-invoices.ts
 *          node --import tsx --env-file=.env.local src/cli/reforward-image-invoices.ts --ids=19f47da4f04c8f9d,19f1f6443da7380e
 * @deps    gmail, ap-single-forward, image-to-pdf
 * @env     ap-token.json
 */
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { forwardInvoiceOnce } from "../lib/intelligence/ap-single-forward";
import {
    imageBufferToPdf,
    imageFilenameToPdf,
    isInvoiceImagePart,
} from "../lib/pdf/image-to-pdf";

/** Recent Gary / DTE Worms photo invoices on ap@ that never reached Bill.com. */
const DEFAULT_AP_IDS = [
    "19f47da4f04c8f9d", // 2026-07-09 IMG_1137.jpeg
    "19f1f6443da7380e", // 2026-07-01 IMG_1133.jpeg
    "19ef03e2a64a60a8", // 2026-06-22 IMG_1133.jpeg (dup content possible)
    "19e81083b23391e0", // 2026-05-31 IMG_0743 + image0
    "19df331149d76cc2", // 2026-05-04 IMG_1092.jpeg
    "19dac1259be75a79", // 2026-04-20 X2 images
    "19d4589655559795", // 2026-03-31 deeremother IMG_1079
];

function collectImageParts(payload: any): Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
}> {
    const out: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [];
    const walk = (part: any) => {
        if (!part) return;
        const filename = part.filename || "";
        const mimeType = part.mimeType || "";
        const size = part.body?.size || 0;
        if (isInvoiceImagePart(mimeType, filename, size) && part.body?.attachmentId) {
            out.push({ filename, mimeType, attachmentId: part.body.attachmentId, size });
        }
        if (part.parts) for (const c of part.parts) walk(c);
    };
    walk(payload);
    return out;
}

async function main() {
    const args = process.argv.slice(2);
    const idsArg = args.find((a) => a.startsWith("--ids="));
    const ids = idsArg
        ? idsArg.slice("--ids=".length).split(",").map((s) => s.trim()).filter(Boolean)
        : DEFAULT_AP_IDS;

    console.log(`=== Reforward image invoices (${ids.length} message ids) ===\n`);

    const auth = await getAuthenticatedClient("ap");
    const gmail = GmailApi({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    console.log(`Connected as ${profile.data.emailAddress}\n`);

    // Dynamic import of enrich path via local forwarder internals is awkward —
    // re-run OCR/DB via process after forward by importing extractor here.
    const { extractPDF } = await import("../lib/pdf/extractor");
    const { parseInvoice } = await import("../lib/pdf/invoice-parser");
    const { upsertVendorInvoice } = await import("../lib/storage/vendor-invoices");
    const { uploadPDF } = await import("../lib/storage/supabase-storage");
    const { getLocalDb } = await import("../lib/storage/local-db");

    let forwarded = 0;
    let skipped = 0;
    let errors = 0;

    for (const id of ids) {
        try {
            const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
            const headers = full.data.payload?.headers || [];
            const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || "";
            const from = get("From");
            const subject = get("Subject");
            const date = get("Date");
            const images = collectImageParts(full.data.payload);
            console.log(`\n--- ${id} | ${date} | ${from.slice(0, 40)} | ${subject} | images=${images.length}`);

            if (images.length === 0) {
                console.log("  no invoice images — skip");
                skipped++;
                continue;
            }

            // Dedupe identical dual-attaches (IMG_xxx + image0 same size)
            const seenSizes = new Set<number>();
            for (const img of images) {
                if (img.size > 0 && seenSizes.has(img.size)) {
                    console.log(`  skip duplicate size ${img.filename}`);
                    continue;
                }
                if (img.size > 0) seenSizes.add(img.size);

                const attRes = await gmail.users.messages.attachments.get({
                    userId: "me",
                    messageId: id,
                    id: img.attachmentId,
                });
                let buf = Buffer.from(attRes.data.data || "", "base64url");
                if (!buf.length) {
                    console.warn(`  empty attachment ${img.filename}`);
                    errors++;
                    continue;
                }

                console.log(`  convert ${img.filename} (${buf.length} bytes) → PDF`);
                const pdfBuffer = await imageBufferToPdf(buf, img.mimeType);
                const pdfFilename = imageFilenameToPdf(img.filename);

                const once = await forwardInvoiceOnce({
                    gmailMessageId: id,
                    emailFrom: from,
                    emailSubject: subject,
                    pdfFilename,
                    pdfBuffer,
                    source: "manual",
                    gmail,
                    vendorName: "Down to Earth Worms",
                });

                if (once.status === "already_forwarded") {
                    console.log(`  already_forwarded: ${once.reason}`);
                    skipped++;
                    continue;
                }
                if (once.status !== "forwarded") {
                    console.error(`  forward failed: ${once.status} ${(once as any).reason}`);
                    errors++;
                    continue;
                }
                console.log(`  ✅ forwarded ${pdfFilename} billcom=${once.billcomSentMessageId}`);
                forwarded++;

                // OCR + vendor_invoices for PO match
                try {
                    const extraction = await extractPDF(pdfBuffer);
                    const rawText = (extraction.rawText || "").trim();
                    console.log(`  OCR ${rawText.length} chars (${extraction.ocrStrategy || "?"})`);
                    try {
                        getLocalDb()
                            .prepare(
                                `UPDATE ap_local_forwards
                                 SET ocr_raw_text = COALESCE(?, ocr_raw_text),
                                     ocr_processed_at = datetime('now'),
                                     ocr_vendor_name = COALESCE('Down to Earth Worms', ocr_vendor_name)
                                 WHERE gmail_message_id = ?`,
                            )
                            .run(rawText || null, id);
                    } catch { /* non-fatal */ }

                    let invoiceNumber: string | null = null;
                    let invoiceDate: string | null = null;
                    let total = 0;
                    let poNumber: string | null = null;
                    let lineItems: any[] = [];
                    if (rawText.length >= 20) {
                        const parsed = await parseInvoice(rawText);
                        invoiceNumber = parsed.invoiceNumber || null;
                        invoiceDate = parsed.invoiceDate || null;
                        total = Number(parsed.total) || 0;
                        poNumber = parsed.poNumber || null;
                        lineItems = (parsed.lineItems || []).map((li: any) => ({
                            sku: String(li.sku || ""),
                            description: String(li.description || ""),
                            qty: Number(li.qty) || 0,
                            unit_price: Number(li.unitPrice ?? li.unit_price) || 0,
                            ext_price: Number(li.extPrice ?? li.ext_price ?? li.total) || 0,
                        }));
                    }
                    let storagePath: string | null = null;
                    try {
                        storagePath = await uploadPDF(pdfBuffer, {
                            type: "INVOICE",
                            vendor: "Down to Earth Worms",
                            date: (invoiceDate || new Date().toISOString()).slice(0, 10),
                            filename: pdfFilename,
                        });
                    } catch { /* non-fatal */ }

                    const vid = await upsertVendorInvoice({
                        vendor_name: "Down to Earth Worms",
                        invoice_number: invoiceNumber,
                        invoice_date: invoiceDate,
                        po_number: poNumber,
                        total,
                        status: "received",
                        source: "email_attachment",
                        source_ref: id,
                        pdf_storage_path: storagePath,
                        line_items: lineItems,
                        raw_data: {
                            email_from: from,
                            email_subject: subject,
                            pdf_filename: pdfFilename,
                            reforward: true,
                            ocr_chars: rawText.length,
                        },
                        notes: rawText.length < 40
                            ? "Photo invoice reforward — OCR thin; manual PO match may be needed"
                            : "Photo invoice reforward 2026-07-17",
                    });
                    console.log(`  vendor_invoices id=${vid} inv#=${invoiceNumber || "—"} total=${total || "—"}`);
                } catch (e: any) {
                    console.warn(`  enrich failed: ${e?.message || e}`);
                }
            }
        } catch (e: any) {
            console.error(`ERR ${id}: ${e?.message || e}`);
            errors++;
        }
    }

    console.log(`\n=== Done: forwarded=${forwarded} skipped=${skipped} errors=${errors} ===`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
