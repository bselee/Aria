/**
 * @file    reconcile-aaa.ts
 * @purpose AAA Cooper freight invoice extraction and forwarding.
 *          Scans ap@buildasoil.com for AAA Cooper "statement" PDFs (which are
 *          actually multi-page bundles of individual invoices + BOLs + notes).
 *          LLM-identifies invoice pages, splits them into named PDFs, emails
 *          each individually to Bill.com for payment processing.
 *
 * @usage   node --import tsx src/cli/reconcile-aaa.ts                # Full run
 *          node --import tsx src/cli/reconcile-aaa.ts --dry-run      # Parse only, don't send/queue
 *          node --import tsx src/cli/reconcile-aaa.ts --scrape-only   # Download + analyze, don't queue
 *          node --import tsx src/cli/reconcile-aaa.ts --limit 3      # Process up to N statements
 *
 * @env     TELEGRAM_CHAT_ID (for completion notification)
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getAuthenticatedClient } from '../lib/gmail/auth';
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { unifiedTextGeneration } from '../intelligence/llm';
import { filterStatementInvoicePages, type StatementInvoicePageCandidate } from '../intelligence/workers/ap-identifier-statement-filter';

const BILL_COM_EMAIL = 'buildasoilap@bill.com';
const AAA_SENDER_PATTERN = /aaa\s*cooper/i;
const STATEMENT_SUBJECT_PATTERN = /ACT_STMT/i;

interface StatementEmail {
    messageId: string;
    subject: string;
    from: string;
    date: string;
    pdfFilename: string;
    pdfBuffer: Buffer;
    pages: Array<{ pageNumber: number; text: string }>;
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
        dryRun: args.includes('--dry-run'),
        scrapeOnly: args.includes('--scrape-only'),
        limit: (() => {
            const idx = args.indexOf('--limit');
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 5;
        })(),
    };
}

async function fetchAAACooperStatements(): Promise<StatementEmail[]> {
    const auth = await getAuthenticatedClient('ap');
    const gmail = (await import('googleapis')).google.gmail({ version: 'v1', auth });

    console.log('🔍 Searching ap@buildasoil.com for AAA Cooper statements…');

    const res = await gmail.users.messages.list({
        userId: 'me',
        q: 'from:aaacooper.com subject:ACT_STMT after:2026/01/01',
        maxResults: 20,
    });

    const msgs = res.data.messages || [];
    if (msgs.length === 0) {
        console.log('   No AAA Cooper statements found.');
        return [];
    }

    console.log(`   Found ${msgs.length} statement(s) — fetching details…`);

    const statements: StatementEmail[] = [];

    for (const msgRef of msgs) {
        const msg = await gmail.users.messages.get({
            userId: 'me',
            id: msgRef.id!,
            format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';
        const from = headers.find((h: any) => h.name === 'From')?.value || '';
        const date = headers.find((h: any) => h.name === 'Date')?.value || '';

        if (!subject || !AAA_SENDER_PATTERN.test(from)) continue;

        const pdfParts: any[] = [];
        const walk = (parts: any[]) => {
            for (const part of parts || []) {
                if (part.filename?.toLowerCase().endsWith('.pdf')) {
                    pdfParts.push({ ...part, msgId: msgRef.id });
                }
                if (part.parts) walk(part.parts);
            }
        };
        walk(msg.data.payload?.parts || []);

        if (pdfParts.length === 0) continue;

        for (const pdfPart of pdfParts) {
            try {
                const attachRes = await gmail.users.messages.attachments.get({
                    userId: 'me',
                    messageId: msgRef.id!,
                    id: pdfPart.body.attachmentId,
                });
                const data = attachRes.data.data;
                if (!data) continue;

                const buffer = Buffer.from(data, 'base64url');
                const { extractPerPage } = await import('../pdf/extractor');
                const pages = await extractPerPage(buffer);

                statements.push({
                    messageId: msgRef.id!,
                    subject,
                    from,
                    date,
                    pdfFilename: pdfPart.filename || 'statement.pdf',
                    pdfBuffer: buffer,
                    pages,
                });
            } catch (err: any) {
                console.warn(`   ⚠️ Failed to download attachment from ${msgRef.id}: ${err.message}`);
            }
        }
    }

    return statements;
}

async function analyzePages(
    pages: Array<{ pageNumber: number; text: string }>,
): Promise<StatementInvoicePageCandidate[]> {
    const textBlocks = pages
        .map(p => `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 1200)}`)
        .join('\n\n');

    const analysis = await unifiedTextGeneration({
        system: `You analyze AAA Cooper freight "statement" documents page by page.
These bundled PDFs contain a mix of individual freight invoices, bills of lading (BOL),
delivery receipts, cover letters, and notes.

For each page determine the type:
- INVOICE: Has a PRO/Invoice number, shipper/consignee, and dollar total
- BOL: Bill of lading — has shipper address, consignee address, freight charges, PRO#
- RECEIPT: Delivery receipt or pickup confirmation
- COVER: Cover letter, remittance advice, or account summary
- OTHER: Anything else

Return ONLY a JSON array:
[{"page":1,"type":"COVER"},{"page":2,"type":"BOL"},{"page":3,"type":"INVOICE","invoiceNumber":"64471573","amount":470.51,"date":"01/15/2026"}]

For INVOICE pages you MUST extract:
- invoiceNumber: The PRO number (e.g. "64471573")
- amount: Total charge as a number (e.g. 470.51)
- date: Invoice date if visible (e.g. "01/15/2026")

If invoiceNumber is not on the page, return null for it — do not guess.`,
        prompt: `${pages.length} pages from an AAA Cooper freight statement:\n\n${textBlocks}`,
    });

    let results: StatementInvoicePageCandidate[] = [];
    try {
        const jsonMatch = analysis.match(/\[[\s\S]*?\]/);
        if (jsonMatch) results = JSON.parse(jsonMatch[0]);
    } catch {
        console.error('   ❌ Failed to parse LLM page analysis');
    }
    return results;
}

async function extractInvoicePages(
    pdfBuffer: Buffer,
    analysis: StatementInvoicePageCandidate[],
    pages: Array<{ pageNumber: number; text: string }>,
): Promise<ExtractedInvoice[]> {
    const { invoicePages } = filterStatementInvoicePages('AAA Cooper', analysis.map(a => ({
        ...a,
        text: pages.find(p => p.pageNumber === a.page)?.text || '',
    })));

    if (invoicePages.length === 0) {
        console.log('   ⚠️  No invoice pages identified — discarding statement');
        return [];
    }

    console.log(`   📋 ${invoicePages.length} invoice page(s) identified`);

    const sourcePdf = await PDFDocument.load(pdfBuffer);
    const invoices: ExtractedInvoice[] = [];

    for (const inv of invoicePages) {
        const pageIdx = inv.page - 1;
        if (pageIdx < 0 || pageIdx >= sourcePdf.getPageCount()) continue;

        const singlePdf = await PDFDocument.create();
        const [copiedPage] = await singlePdf.copyPages(sourcePdf, [pageIdx]);
        singlePdf.addPage(copiedPage);
        const pageBuffer = Buffer.from(await singlePdf.save());

        const invNum = inv.invoiceNumber || `unknown-${inv.page}`;
        const dateStr = inv.date ? `_${inv.date.replace(/\//g, '-')}` : '';
        const safeNum = invNum.replace(/[^a-zA-Z0-9-]/g, '_');
        const filename = `Triple A Cooper ${safeNum}${dateStr}.pdf`;

        invoices.push({
            pageNumber: inv.page,
            invoiceNumber: inv.invoiceNumber || null,
            date: inv.date || null,
            amount: inv.amount || null,
            pdfBuffer: pageBuffer,
            filename,
        });
    }

    return invoices;
}

async function sendToBillCom(
    gmail: any,
    invoice: ExtractedInvoice,
    sourceSubject: string,
): Promise<void> {
    const rawBase64 = invoice.pdfBuffer.toString('base64');
    const chunked = rawBase64.match(/.{1,76}/g)?.join('\r\n') || rawBase64;
    const boundary = `b_aaa_${Date.now()}_${Math.random().toString(36).substring(2)}`;

    const subject = invoice.invoiceNumber
        ? `Triple A Cooper ${invoice.invoiceNumber}${invoice.date ? ` ${invoice.date}` : ''}`
        : `Triple A Cooper Invoice ${invoice.pageNumber}`;

    const mime = [
        `To: ${BILL_COM_EMAIL}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        `AAA Cooper freight invoice forwarded for payment.`,
        ``,
        `--${boundary}`,
        `Content-Type: application/pdf; name="${invoice.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${invoice.filename}"`,
        ``,
        chunked,
        `--${boundary}--`,
    ].join('\r\n');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: Buffer.from(mime).toString('base64url') },
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
            vendor_name: 'AAA COOPER',
            invoice_number: invoice.invoiceNumber || `split-${sourceMessageId}-page-${invoice.pageNumber}`,
            invoice_date: invoice.date || new Date().toISOString().split('T')[0],
            total: invoice.amount || 0,
            source: 'email_attachment',
            source_ref: sourceMessageId,
            raw_data: {
                source_subject: sourceSubject,
                page_number: invoice.pageNumber,
                filename: invoice.filename,
            } as any,
        });
    } catch {}
}

async function main() {
    const { dryRun, scrapeOnly, limit } = parseArgs();

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   AAA Cooper Invoice Extraction & Forwarding   ║');
    console.log('╚══════════════════════════════════════════════════╝');
    if (dryRun) console.log('   🔍 DRY RUN — no emails will be sent\n');
    if (scrapeOnly) console.log('   📄 SCRAPE ONLY — analyzing pages, not queueing\n');

    const statements = await fetchAAACooperStatements();
    if (statements.length === 0) {
        console.log('\n✅ No AAA Cooper statements to process.');
        return;
    }

    console.log(`\n📦 Processing up to ${limit} statement(s)…\n`);

    const auth = await getAuthenticatedClient('ap');
    const gmail = (await import('googleapis')).google.gmail({ version: 'v1', auth });
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    let totalInvoices = 0;
    let totalPagesDiscarded = 0;

    for (const stmt of statements.slice(0, limit)) {
        console.log(`\n═══ Statement: "${stmt.subject}" ═══`);
        console.log(`    ${stmt.pages.length} page(s) | PDF: ${stmt.pdfFilename}`);

        if (dryRun || scrapeOnly) {
            console.log('   🔬 Analyzing pages (dry/scrape mode — LLM call)…');
        }

        const analysis = await analyzePages(stmt.pages);

        const { invoicePages, discardedCount } = filterStatementInvoicePages(
            'AAA Cooper',
            analysis.map(a => ({
                ...a,
                text: stmt.pages.find(p => p.pageNumber === a.page)?.text || '',
            })),
        );

        console.log(`    📋 ${invoicePages.length} invoice(s), ${discardedCount} discarded page(s)`);

        if (invoicePages.length === 0) {
            console.log('    ⏭️  Skipping — no invoices found');
            totalPagesDiscarded += discardedCount;
            continue;
        }

        const invoices = await extractInvoicePages(stmt.pdfBuffer, analysis, stmt.pages);

        for (const inv of invoices) {
            const amountStr = inv.amount ? ` $${inv.amount.toFixed(2)}` : '';
            console.log(`    📤 ${inv.filename}${amountStr}`);

            if (!dryRun && !scrapeOnly) {
                try {
                    await sendToBillCom(gmail, inv, stmt.subject);
                    await archiveInvoice(supabase, inv, stmt.messageId, stmt.subject);
                    console.log(`       ✅ Sent to Bill.com + archived`);
                } catch (err: any) {
                    console.error(`       ❌ Failed: ${err.message}`);
                }
            } else if (scrapeOnly) {
                console.log(`       🔍 Would queue (scrape-only mode)`);
            } else {
                console.log(`       🔍 Would send to Bill.com (dry-run mode)`);
            }
        }

        totalInvoices += invoices.length;
        totalPagesDiscarded += discardedCount;

        if (!dryRun && !scrapeOnly) {
            try {
                await gmail.users.messages.modify({
                    userId: 'me',
                    id: stmt.messageId,
                    requestBody: { removeLabelIds: ['UNREAD'], addLabelIds: [] },
                });
            } catch {}
        }
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║                  DONE                           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   Statements: ${String(statements.length).padEnd(38)}║`);
    console.log(`║   Invoices extracted: ${String(totalInvoices).padEnd(28)}║`);
    console.log(`║   Non-invoice pages: ${String(totalPagesDiscarded).padEnd(29)}║`);
    console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
