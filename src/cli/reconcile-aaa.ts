/**
 * @file    reconcile-aaa.ts
 * @purpose AAA Cooper freight invoice extraction and forwarding.
 *          Scans ap@buildasoil.com for AAA Cooper statement PDFs, runs them
 *          through the shared OCR-first splitter, and forwards only confidently
 *          identified invoice pages to Bill.com.
 *
 * @usage   node --import tsx src/cli/reconcile-aaa.ts
 *          node --import tsx src/cli/reconcile-aaa.ts --dry-run
 *          node --import tsx src/cli/reconcile-aaa.ts --scrape-only
 *          node --import tsx src/cli/reconcile-aaa.ts --limit 3
 *
 * @env     TELEGRAM_CHAT_ID (for completion notification)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { gmail as GmailApi } from "@googleapis/gmail";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { splitAAACooperStatementAttachments } from "../lib/intelligence/aaa-cooper-splitter";
import { upsertVendorInvoice } from "../lib/storage/vendor-invoices";
import {
    fetchAAACooperStatements,
    parseReconcileAAAArgs,
    type StatementAttachment,
    type StatementEmail,
} from "./reconcile-aaa-targeting";

const BILL_COM_EMAIL = "buildasoilap@bill.com";

interface ExtractedInvoice {
    pageNumber: number;
    invoiceNumber: string | null;
    date: string | null;
    amount: number | null;
    pdfBuffer: Buffer;
    filename: string;
}

async function buildInvoicesFromSplitResult(
    attachments: StatementAttachment[],
    splitResult: Awaited<ReturnType<typeof splitAAACooperStatementAttachments>>,
): Promise<ExtractedInvoice[]> {
    const attachmentLookup = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment]));
    const sourcePdfs = new Map<string, PDFDocument>();
    const invoices: ExtractedInvoice[] = [];

    for (const invoice of splitResult.invoices) {
        const attachment = invoice.attachmentId ? attachmentLookup.get(invoice.attachmentId) : undefined;
        if (!attachment) continue;

        let sourcePdf = sourcePdfs.get(attachment.attachmentId);
        if (!sourcePdf) {
            sourcePdf = await PDFDocument.load(attachment.pdfBuffer);
            sourcePdfs.set(attachment.attachmentId, sourcePdf);
        }

        const pageIndexes = (invoice.bundlePages?.length ? invoice.bundlePages : [invoice.page])
            .map((pageNumber) => pageNumber - 1)
            .filter((pageIdx) => pageIdx >= 0 && pageIdx < sourcePdf.getPageCount());
        if (pageIndexes.length === 0) continue;

        const bundlePdf = await PDFDocument.create();
        const copiedPages = await bundlePdf.copyPages(sourcePdf, pageIndexes);
        for (const copiedPage of copiedPages) bundlePdf.addPage(copiedPage);
        const pageBuffer = Buffer.from(await bundlePdf.save());

        const invoiceNumber = invoice.invoiceNumber || `unknown-${invoice.page}`;
        const safeNumber = invoiceNumber.replace(/[^a-zA-Z0-9-]/g, "_");
        const safeDate = (invoice.date || "unknown-date").replace(/[^0-9-]/g, "_");
        const filename = `Invoice_${safeNumber}_${safeDate}.pdf`;

        invoices.push({
            pageNumber: invoice.page,
            invoiceNumber: invoice.invoiceNumber || null,
            date: invoice.date || null,
            amount: invoice.amount || null,
            pdfBuffer: pageBuffer,
            filename,
        });
    }

    return invoices;
}

async function sendToBillCom(
    gmail: any,
    invoice: ExtractedInvoice,
): Promise<void> {
    const rawBase64 = invoice.pdfBuffer.toString("base64");
    const chunked = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;
    const boundary = `b_aaa_${Date.now()}_${Math.random().toString(36).substring(2)}`;

    const subject = invoice.invoiceNumber
        ? `Triple A Cooper ${invoice.invoiceNumber}${invoice.date ? ` ${invoice.date}` : ""}`
        : `Triple A Cooper Invoice ${invoice.pageNumber}`;

    const mime = [
        `To: ${BILL_COM_EMAIL}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=\"UTF-8\"",
        "",
        "AAA Cooper freight invoice forwarded for payment.",
        "",
        `--${boundary}`,
        `Content-Type: application/pdf; name="${invoice.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${invoice.filename}"`,
        "",
        chunked,
        `--${boundary}--`,
    ].join("\r\n");

    await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(mime).toString("base64url") },
    });
}

async function archiveInvoice(
    supabase: any,
    invoice: ExtractedInvoice,
    sourceMessageId: string,
    sourceSubject: string,
): Promise<void> {
    try {
        await upsertVendorInvoice({
            vendor_name: "AAA COOPER",
            invoice_number: invoice.invoiceNumber || `split-${sourceMessageId}-page-${invoice.pageNumber}`,
            invoice_date: invoice.date || new Date().toISOString().split("T")[0],
            total: invoice.amount || 0,
            source: "email_attachment",
            source_ref: sourceMessageId,
            raw_data: {
                source_subject: sourceSubject,
                page_number: invoice.pageNumber,
                filename: invoice.filename,
            } as any,
        });
    } catch {
        // Best-effort archive only.
    }
}

async function main() {
    const { dryRun, scrapeOnly, limit, messageId, inboxOnly } = parseReconcileAAAArgs(process.argv.slice(2));

    console.log("\n=== AAA Cooper Invoice Extraction & Forwarding ===");
    if (dryRun) console.log("   DRY RUN — no emails will be sent\n");
    if (scrapeOnly) console.log("   SCRAPE ONLY — analyzing pages, not queueing\n");
    if (messageId) console.log(`   EXACT MESSAGE — targeting Gmail id ${messageId}\n`);
    if (inboxOnly) console.log("   INBOX ONLY — non-inbox AAA Cooper mail will be ignored\n");

    const auth = await getAuthenticatedClient("ap");
    const gmail = GmailApi({ version: "v1", auth });

    console.log(messageId
        ? `Fetching exact AAA Cooper statement ${messageId} from ap@buildasoil.com...`
        : "Searching ap@buildasoil.com for AAA Cooper statements...");

    const statements = await fetchAAACooperStatements(gmail as any, { messageId, inboxOnly });
    if (statements.length === 0) {
        console.log("\nNo AAA Cooper statements to process.");
        return;
    }

    console.log(messageId
        ? `   Found exact target; fetching attachments complete.`
        : `   Found ${statements.length} AAA Cooper email(s); fetching attachments...`);
    console.log(`\nProcessing up to ${messageId ? 1 : limit} statement email(s)...\n`);

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    let totalInvoices = 0;
    let totalPagesDiscarded = 0;
    let heldForReview = 0;

    for (const stmt of statements.slice(0, messageId ? 1 : limit)) {
        console.log(`\n=== Statement: "${stmt.subject}" ===`);
        console.log(`    Attachments: ${stmt.attachments.map((attachment) => attachment.filename).join(", ")}`);

        const splitResult = await splitAAACooperStatementAttachments({
            attachments: stmt.attachments,
        });

        if (splitResult.status === "needs_review") {
            heldForReview++;
            console.log(`    Held for review: ${splitResult.diagnostics.weakReason || "OCR confidence too weak"}`);
            continue;
        }

        if (splitResult.status !== "split_ready" || splitResult.invoices.length === 0) {
            console.log("    Skipping — no invoices found");
            totalPagesDiscarded += splitResult.discardedCount;
            continue;
        }

        console.log(`    ${splitResult.invoices.length} invoice(s), ${splitResult.discardedCount} discarded page(s)`);

        const invoices = await buildInvoicesFromSplitResult(stmt.attachments, splitResult);
        for (const invoice of invoices) {
            const amountStr = invoice.amount ? ` $${invoice.amount.toFixed(2)}` : "";
            console.log(`    ${invoice.filename}${amountStr}`);

            if (!dryRun && !scrapeOnly) {
                try {
                    await sendToBillCom(gmail, invoice);
                    await archiveInvoice(supabase, invoice, stmt.messageId, stmt.subject);
                    console.log("       Sent to Bill.com + archived");
                } catch (err: any) {
                    console.error(`       Failed: ${err.message}`);
                }
            } else if (scrapeOnly) {
                console.log("       Would queue (scrape-only mode)");
            } else {
                console.log("       Would send to Bill.com (dry-run mode)");
            }
        }

        totalInvoices += invoices.length;
        totalPagesDiscarded += splitResult.discardedCount;

        if (!dryRun && !scrapeOnly) {
            try {
                await gmail.users.messages.modify({
                    userId: "me",
                    id: stmt.messageId,
                    requestBody: { removeLabelIds: ["INBOX", "UNREAD"], addLabelIds: [] },
                });
            } catch {
                // Best-effort Gmail cleanup.
            }
        }
    }

    console.log("\n=== DONE ===");
    console.log(`Statements: ${statements.length}`);
    console.log(`Invoices extracted: ${totalInvoices}`);
    console.log(`Non-invoice pages: ${totalPagesDiscarded}`);
    console.log(`Held for review: ${heldForReview}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
