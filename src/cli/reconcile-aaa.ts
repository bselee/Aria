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

import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { splitAAACooperStatementAttachments } from "../lib/intelligence/aaa-cooper-splitter";
import { upsertVendorInvoice } from "../lib/storage/vendor-invoices";

const BILL_COM_EMAIL = "buildasoilap@bill.com";
const AAA_SENDER_PATTERN = /aaa\s*cooper/i;

interface StatementAttachment {
    attachmentId: string;
    filename: string;
    pdfBuffer: Buffer;
}

interface StatementEmail {
    messageId: string;
    subject: string;
    from: string;
    date: string;
    attachments: StatementAttachment[];
}

interface ExtractedInvoice {
    pageNumber: number;
    invoiceNumber: string | null;
    date: string | null;
    amount: number | null;
    pdfBuffer: Buffer;
    filename: string;
}

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        dryRun: args.includes("--dry-run"),
        scrapeOnly: args.includes("--scrape-only"),
        limit: (() => {
            const idx = args.indexOf("--limit");
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 5;
        })(),
    };
}

async function fetchAAACooperStatements(): Promise<StatementEmail[]> {
    const auth = await getAuthenticatedClient("ap");
    const gmail = (await import("googleapis")).google.gmail({ version: "v1", auth });

    console.log("Searching ap@buildasoil.com for AAA Cooper statements...");

    const res = await gmail.users.messages.list({
        userId: "me",
        q: "from:aaacooper.com after:2026/01/01",
        maxResults: 20,
    });

    const msgs = res.data.messages || [];
    if (msgs.length === 0) {
        console.log("   No AAA Cooper statements found.");
        return [];
    }

    console.log(`   Found ${msgs.length} AAA Cooper email(s); fetching attachments...`);

    const statements: StatementEmail[] = [];

    for (const msgRef of msgs) {
        const msg = await gmail.users.messages.get({
            userId: "me",
            id: msgRef.id!,
            format: "full",
        });

        const headers = msg.data.payload?.headers || [];
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
        const from = headers.find((h: any) => h.name === "From")?.value || "";
        const date = headers.find((h: any) => h.name === "Date")?.value || "";

        if (!subject || !AAA_SENDER_PATTERN.test(from)) continue;

        const attachments: StatementAttachment[] = [];
        const walk = (parts: any[]) => {
            for (const part of parts || []) {
                if (part.filename?.toLowerCase().endsWith(".pdf") && part.body?.attachmentId) {
                    attachments.push({
                        attachmentId: part.body.attachmentId,
                        filename: part.filename || "statement.pdf",
                        pdfBuffer: Buffer.alloc(0),
                    });
                }
                if (part.parts) walk(part.parts);
            }
        };
        walk(msg.data.payload?.parts || []);

        if (attachments.length === 0) continue;

        const hydratedAttachments: StatementAttachment[] = [];
        for (const attachment of attachments) {
            try {
                const attachRes = await gmail.users.messages.attachments.get({
                    userId: "me",
                    messageId: msgRef.id!,
                    id: attachment.attachmentId,
                });
                const data = attachRes.data.data;
                if (!data) continue;

                hydratedAttachments.push({
                    ...attachment,
                    pdfBuffer: Buffer.from(data, "base64url"),
                });
            } catch (err: any) {
                console.warn(`   Failed to download ${attachment.filename}: ${err.message}`);
            }
        }

        if (hydratedAttachments.length === 0) continue;

        statements.push({
            messageId: msgRef.id!,
            subject,
            from,
            date,
            attachments: hydratedAttachments,
        });
    }

    return statements;
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

        const pageIdx = invoice.page - 1;
        if (pageIdx < 0 || pageIdx >= sourcePdf.getPageCount()) continue;

        const singlePdf = await PDFDocument.create();
        const [copiedPage] = await singlePdf.copyPages(sourcePdf, [pageIdx]);
        singlePdf.addPage(copiedPage);
        const pageBuffer = Buffer.from(await singlePdf.save());

        const invoiceNumber = invoice.invoiceNumber || `unknown-${invoice.page}`;
        const safeNumber = invoiceNumber.replace(/[^a-zA-Z0-9-]/g, "_");
        const filename = `Triple A Cooper ${safeNumber}.pdf`;

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
    const { dryRun, scrapeOnly, limit } = parseArgs();

    console.log("\n=== AAA Cooper Invoice Extraction & Forwarding ===");
    if (dryRun) console.log("   DRY RUN — no emails will be sent\n");
    if (scrapeOnly) console.log("   SCRAPE ONLY — analyzing pages, not queueing\n");

    const statements = await fetchAAACooperStatements();
    if (statements.length === 0) {
        console.log("\nNo AAA Cooper statements to process.");
        return;
    }

    console.log(`\nProcessing up to ${limit} statement email(s)...\n`);

    const auth = await getAuthenticatedClient("ap");
    const gmail = (await import("googleapis")).google.gmail({ version: "v1", auth });
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    let totalInvoices = 0;
    let totalPagesDiscarded = 0;
    let heldForReview = 0;

    for (const stmt of statements.slice(0, limit)) {
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
                    requestBody: { removeLabelIds: ["UNREAD"], addLabelIds: [] },
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

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
