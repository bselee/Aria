/**
 * @file    backfill-ap-invoices.ts
 * @purpose Read-only backfill: scans ap@buildasoil.com for already-read emails
 *          with PDF attachments and archives invoice data to vendor_invoices.
 *          Safe to re-run — deduplicates on (vendor_name, invoice_number).
 *          No forwarding, no label changes, no Telegram, no Finale mutations.
 *
 * @usage
 *   node --import tsx src/cli/backfill-ap-invoices.ts [--dry-run] [--days=N]
 *
 *   --dry-run       Preview only, no Supabase writes
 *   --days=N        How many days back to scan (default: 90)
 *                   Examples: --days=180  --days=365  --days=730
 *   --chunk=N       Process in N-day chunks (e.g., --chunk=10)
 *
 * @prereq  token-ap.json must exist — run: node --import tsx src/cli/gmail-auth.ts ap
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { extractPDF } from "../lib/pdf/extractor";
import { classifyDocument } from "../lib/pdf/classifier";
import { parseInvoice } from "../lib/pdf/invoice-parser";
import { upsertVendorInvoice } from "../lib/storage/vendor-invoices";

const DRY_RUN = process.argv.includes("--dry-run");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS_BACK = daysArg ? Math.max(1, parseInt(daysArg.split("=")[1], 10)) : 90;
const chunkArg = process.argv.find((a) => a.startsWith("--chunk="));
const CHUNK_DAYS = chunkArg ? Math.max(1, parseInt(chunkArg.split("=")[1], 10)) : null;
const MAX_RESULTS_PER_PAGE = 50;
const CONCURRENCY = 3; // parallel attachment workers
const DELAY_MS = 150; // pause between messages to avoid quota hits

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fast-path extraction from email subject + from address when LLM parsing fails.
 * Subject lines are rich: "Invoice 145357 from Evergreen Growers Supply, LLC."
 *                         "New payment request from AutoPot USA - Invoice APUS-243722"
 *                         "Invoice 124424 due Mar 17, 2026 | Colorado Worm Company"
 */
function extractFromSubject(subject: string, from: string, filename: string): {
    vendorName: string;
    invoiceNumber: string | null;
} {
    // --- Invoice number ---
    // Patterns: "Invoice 145357", "Invoice APUS-243722", "invoice 131401", "Inv 5543"
    const invMatch =
        subject.match(/\bInv(?:oice)?[.\s#:-]*(?:No\.?\s+)?([A-Z0-9][-A-Z0-9/]{2,})/i) ??
        filename.match(/(?:Inv[_\s]?)([0-9]{4,})/i);
    const invoiceNumber = invMatch?.[1]?.replace(/[_\s]+/g, "") ?? null;

    // --- Vendor name ---
    // "from Evergreen Growers Supply, LLC." / "| Colorado Worm Company" / "from AutoPot USA"
    let vendorName =
        subject.match(/(?:from|payment to)\s+(.+?)(?:\s*[-|]|\s+due|\s+is\s|$)/i)?.[1]?.trim() ??
        subject.match(/[|]\s*(.+?)\s*$/)?.[1]?.trim() ??
        from.replace(/<[^>]+>/, "").replace(/"/g, "").trim();

    // Strip trailing punctuation / "Inc." "LLC." artefacts left hanging
    vendorName = vendorName.replace(/[,.]$/, "").trim() || "Unknown Vendor";

    return { vendorName, invoiceNumber };
}

function decodeBase64(data: string): Buffer {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Walk a message payload and collect all PDF parts (inline + attachment). */
function collectPdfParts(payload: any): Array<{ filename: string; attachmentId?: string; data?: string }> {
    const parts: Array<{ filename: string; attachmentId?: string; data?: string }> = [];

    function walk(node: any) {
        if (!node) return;
        const isPdf =
            node.mimeType === "application/pdf" ||
            node.mimeType === "application/x-pdf" ||
            (node.filename && /\.pdf$/i.test(node.filename));

        if (isPdf && node.filename) {
            parts.push({
                filename: node.filename,
                attachmentId: node.body?.attachmentId,
                data: node.body?.data, // inline (small) pdfs
            });
        }
        if (node.parts?.length) {
            for (const p of node.parts) walk(p);
        }
    }

    walk(payload);
    return parts;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n📥 AP Invoice Backfill — ${DAYS_BACK} days, read emails only${DRY_RUN ? " [DRY-RUN]" : ""}\n`);

    // ── Auth ──
    let auth: any;
    try {
        auth = await getAuthenticatedClient("ap");
        console.log("✅ Authenticated as ap@buildasoil.com (token-ap.json)\n");
    } catch (err: any) {
        console.error(
            "❌ Missing ap token. Run first:\n\n" +
            "   node --import tsx src/cli/gmail-auth.ts ap\n\n" +
            "Then re-run this script."
        );
        process.exit(1);
    }

    const gmail = GmailApi({ version: "v1", auth });

    if (CHUNK_DAYS) {
        console.log(`\n⏳ Processing in ${CHUNK_DAYS}-day chunks...\n`);
        let currentNewer = DAYS_BACK;
        while (currentNewer > 0) {
            const currentOlder = Math.max(0, currentNewer - CHUNK_DAYS);
            // Example: query older_than: 80d, newer_than: 90d to get 80-90 days ago
            await processSearch(gmail, currentNewer, currentOlder);
            currentNewer -= CHUNK_DAYS;
        }
    } else {
        await processSearch(gmail, DAYS_BACK, null);
    }
}

async function processSearch(gmail: any, newerThanDays: number, olderThanDays: number | null) {
    let query = `is:read has:attachment filename:pdf`;
    if (newerThanDays > 0) query += ` newer_than:${newerThanDays}d`;
    if (olderThanDays !== null && olderThanDays > 0) query += ` older_than:${olderThanDays}d`;
    console.log(`\n🔍 Query: ${query}`);

    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
        const { data } = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: MAX_RESULTS_PER_PAGE,
            pageToken,
        });

        for (const m of data.messages ?? []) {
            if (m.id) messageIds.push(m.id);
        }
        pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    console.log(`📬 Found ${messageIds.length} candidate message(s)\n`);

    if (messageIds.length === 0) {
        console.log("Nothing to process in this chunk.");
        return;
    }

    // ── Stats ──
    let processed = 0;
    let invoicesFound = 0;
    let archived = 0;
    let skipped = 0;
    let errors = 0;

    // ── Process messages ──
    for (let i = 0; i < messageIds.length; i++) {
        const msgId = messageIds[i];
        await sleep(DELAY_MS);

        let msg: any;
        try {
            const resp = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
            msg = resp.data;
        } catch (err: any) {
            if (err.code === 429) {
                console.warn("⚠️  Rate limit — pausing 5s...");
                await sleep(5000);
            }
            console.error(`  ❌ Failed to fetch ${msgId}: ${err.message}`);
            errors++;
            continue;
        }

        const headers = msg.payload?.headers ?? [];
        const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "(no subject)";
        const from = headers.find((h: any) => h.name === "From")?.value ?? "unknown";
        const dateHeader = headers.find((h: any) => h.name === "Date")?.value ?? "";

        const pdfParts = collectPdfParts(msg.payload);
        if (pdfParts.length === 0) {
            skipped++;
            continue;
        }

        console.log(`[${i + 1}/${messageIds.length}] ${from.substring(0, 60)}`);
        console.log(`  Subject: ${subject.substring(0, 80)}`);
        console.log(`  PDFs: ${pdfParts.map((p) => p.filename).join(", ")}`);
        processed++;

        // ── Process each PDF part ──
        for (const part of pdfParts) {
            let pdfBuffer: Buffer;

            try {
                if (part.data) {
                    // Inline small attachment
                    pdfBuffer = decodeBase64(part.data);
                } else if (part.attachmentId) {
                    const { data: attachData } = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: msgId,
                        id: part.attachmentId,
                    });
                    pdfBuffer = decodeBase64(attachData.data!);
                } else {
                    console.warn(`  ⚠️  No data for ${part.filename}, skipping`);
                    skipped++;
                    continue;
                }
            } catch (err: any) {
                console.error(`  ❌ Download failed for ${part.filename}: ${err.message}`);
                errors++;
                continue;
            }

            // Skip suspiciously small files (likely blank pages / error PDFs)
            if (pdfBuffer.length < 1024) {
                console.log(`  ⏭  ${part.filename} too small (${pdfBuffer.length}b), skipping`);
                skipped++;
                continue;
            }

            // ── Extract + Classify ──
            let extraction: any;
            try {
                extraction = await extractPDF(pdfBuffer);
            } catch (err: any) {
                console.error(`  ❌ OCR failed for ${part.filename}: ${err.message}`);
                errors++;
                continue;
            }

            const classification = await classifyDocument(extraction).catch(() => null);
            const docType = classification?.type ?? "UNKNOWN";

            if (docType !== "INVOICE") {
                console.log(`  ⏭  ${part.filename} → ${docType} (not an invoice)`);
                skipped++;
                continue;
            }

            invoicesFound++;
            console.log(`  ✅ ${part.filename} → INVOICE`);

            // ── Parse ──
            // extraction.rawText (not .text) — PDFExtractionResult field name
            // extraction.tables is TableData[] — flatten to string[][] for parseInvoice
            const rawText: string = extraction.rawText ?? "";
            const tableRows: string[][] = (extraction.tables ?? []).flatMap(
                (t: any) => [t.headers ?? [], ...(t.rows ?? [])]
            );

            if (!rawText) {
                console.log(`  ⏭  ${part.filename} → no text extracted, skipping`);
                skipped++;
                continue;
            }

            let invoiceData: any;
            let usedFallback = false;
            try {
                invoiceData = await parseInvoice(rawText, tableRows.length ? tableRows : undefined);
            } catch (err: any) {
                console.warn(`  ⚠️  LLM parse failed (${err.message?.slice(0, 60)}...) — using subject fallback`);
                usedFallback = true;
            }

            // If LLM failed or returned "error" sentinel values, fall back to subject-line extraction
            if (usedFallback || !invoiceData || invoiceData.vendorName === "error") {
                const meta = extractFromSubject(subject, from, part.filename);
                invoiceData = {
                    vendorName: meta.vendorName,
                    invoiceNumber: meta.invoiceNumber,
                    invoiceDate: null,
                    dueDate: null,
                    poNumber: null,
                    subtotal: 0,
                    freight: 0,
                    tax: 0,
                    total: 0,
                    lineItems: [],
                    confidence: "low",
                };
                usedFallback = true;
            }

            const vendorName = (invoiceData.vendorName && invoiceData.vendorName !== "UNKNOWN" && invoiceData.vendorName !== "error")
                ? invoiceData.vendorName
                : (from.replace(/<.*>/, "").trim() || "Unknown Vendor");

            console.log(
                `     vendor=${vendorName} | inv#=${invoiceData.invoiceNumber ?? "?"} | ` +
                `date=${invoiceData.invoiceDate ?? "?"} | total=$${invoiceData.total}` +
                (usedFallback ? " [subject-fallback]" : "")
            );

            // ── Archive ──
            if (!DRY_RUN) {
                const id = await upsertVendorInvoice({
                    vendor_name: vendorName,
                    invoice_number: invoiceData.invoiceNumber !== "UNKNOWN" ? invoiceData.invoiceNumber : null,
                    invoice_date: invoiceData.invoiceDate || null,
                    due_date: invoiceData.dueDate || null,
                    po_number: invoiceData.poNumber || null,
                    subtotal: invoiceData.subtotal ?? 0,
                    freight: invoiceData.freight ?? 0,
                    tax: invoiceData.tax ?? 0,
                    total: invoiceData.total ?? 0,
                    status: "received",
                    source: "email_attachment",
                    source_ref: msgId,
                    line_items: (invoiceData.lineItems ?? []).map((li: any) => ({
                        sku: li.sku ?? "",
                        description: li.description ?? "",
                        qty: li.qty ?? 0,
                        unit_price: li.unitPrice ?? 0,
                        ext_price: li.total ?? 0,
                    })),
                    raw_data: {
                        gmail_message_id: msgId,
                        filename: part.filename,
                        from,
                        subject,
                        date_header: dateHeader,
                    },
                    notes: `Backfill from ap@buildasoil.com — ${part.filename}`,
                });
                if (id) {
                    console.log(`     → Archived (id=${id})`);
                    archived++;
                } else {
                    console.log(`     → Upsert returned null (likely duplicate)`);
                    archived++;
                }
            } else {
                console.log(`     → [DRY-RUN] Would archive`);
                archived++;
            }
        }
    }

    // ── Summary ──
    console.log("\n─────────────────────────────────────────");
    console.log(`📊 Backfill complete${DRY_RUN ? " [DRY-RUN]" : ""}`);
    console.log(`   Messages scanned : ${processed}`);
    console.log(`   Invoices found   : ${invoicesFound}`);
    console.log(`   Archived         : ${archived}`);
    console.log(`   Skipped          : ${skipped}`);
    console.log(`   Errors           : ${errors}`);
    console.log("─────────────────────────────────────────\n");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
