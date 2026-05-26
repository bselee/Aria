/**
 * @file    media-handler.ts
 * @purpose Handles Telegram photo and document uploads, Excel/CSV parsers,
 *          fuzzy SKU extraction, real-time Finale data decorators, and statement splitting.
 * @author  Will / Antigravity
 * @created 2026-05-26
 * @updated 2026-05-26
 * @deps    telegraf, xlsx, pdf-lib, @googleapis/gmail, supabase
 */

import type { Context } from 'telegraf';
import type { FinaleClient } from '../../lib/finale/client';
import { unifiedTextGeneration } from '../../lib/intelligence/llm';

/**
 * Reusable helper to send emails with PDF attachment via Gmail API.
 */
export async function sendPdfEmail(
    to: string,
    subject: string,
    body: string,
    pdfBuffer: Buffer,
    pdfFilename: string
): Promise<void> {
    const { getAuthenticatedClient: getGmailAuth } = await import('../../lib/gmail/auth');
    const { gmail: GmailApiDyn } = await import('@googleapis/gmail');
    const auth = await getGmailAuth('default');
    const gmail = GmailApiDyn({ version: 'v1', auth });

    const boundary = '----=_Part_' + Date.now();
    const mimeMessage = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        body,
        ``,
        `--${boundary}`,
        `Content-Type: application/pdf; name="${pdfFilename}"`,
        `Content-Disposition: attachment; filename="${pdfFilename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        pdfBuffer.toString('base64'),
        `--${boundary}--`,
    ].join('\r\n');

    const encodedMessage = Buffer.from(mimeMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
    });
}

/**
 * Handles incoming photo messages.
 */
export async function handlePhotoUpload(ctx: Context): Promise<void> {
    const chatId = ctx.from?.id || ctx.chat?.id;
    if (!chatId) return;

    const photos = (ctx.message as any).photo || [];
    const photo = photos[photos.length - 1];

    if (!photo) return;

    try {
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const base64 = Buffer.from(await response.arrayBuffer()).toString('base64');

        const { handleTelegramPhoto } = await import('../../lib/copilot/channels/telegram');
        await handleTelegramPhoto({
            chatId,
            fileId: photo.file_id,
            url: fileLink.href,
            base64,
        });
    } catch (err: any) {
        console.error('Telegram photo artifact error:', err.message);
    }
}

/**
 * Handles incoming document/file uploads.
 */
export async function handleDocumentUpload(
    ctx: Context,
    finale: FinaleClient,
    chatHistory: Record<string, any[]>,
    chatLastActive: Record<string, number>
): Promise<void> {
    const doc = (ctx.message as any).document;
    if (!doc) return;

    const filename = doc.file_name || 'unknown';
    const mimeType = doc.mime_type || '';
    const caption = (ctx.message as any).caption || '';

    // Only process supported file types
    const SUPPORTED = [
        'application/pdf', 'application/x-pdf', 'image/png', 'image/jpeg',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/csv', 'text/plain', 'application/csv',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];

    if (!SUPPORTED.some(m => mimeType.includes(m.split('/')[1]))) {
        await ctx.reply(
            `📌 Got *${filename}* but I can't process \`${mimeType}\` files yet.\n_I handle: PDF, PNG, JPEG, DOC/DOCX, CSV, TXT, XLS/XLSX_`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (doc.file_size && doc.file_size > 20_000_000) {
        await ctx.reply('⚠️ File too large (>20MB). Try emailing it to me instead.');
        return;
    }

    ctx.sendChatAction('typing');
    await ctx.reply(`📌 Processing *${filename}*... one moment.`, { parse_mode: 'Markdown' });

    try {
        // Download file from Telegram
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        const { handleTelegramDocument } = await import('../../lib/copilot/channels/telegram');
        await handleTelegramDocument({
            chatId: ctx.from?.id || ctx.chat!.id,
            fileId: doc.file_id,
            filename,
            mimeType,
            rawText: caption || undefined,
            summary: `Telegram document uploaded: ${filename}`,
        });

        // ── CSV / TEXT files: skip PDF pipeline, go straight to LLM ──
        const isTextFile = mimeType.includes('csv') || mimeType.includes('text/plain')
            || filename.endsWith('.csv') || filename.endsWith('.txt');

        // ── Excel (XLS/XLSX): convert to CSV text, then analyze with LLM ──
        const isExcelFile = mimeType.includes('spreadsheet') || mimeType.includes('ms-excel')
            || filename.endsWith('.xlsx') || filename.endsWith('.xls');

        if (isTextFile || isExcelFile) {
            let textContent: string;
            let fileLabel: string;

            if (isExcelFile) {
                const XLSX = await import('xlsx');
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheetNames = workbook.SheetNames;
                const parts: string[] = [];

                for (const name of sheetNames) {
                    const sheet = workbook.Sheets[name];
                    const csv = XLSX.utils.sheet_to_csv(sheet);
                    if (sheetNames.length > 1) {
                        parts.push(`\n=== Sheet: ${name} ===\n${csv}`);
                    } else {
                        parts.push(csv);
                    }
                }
                textContent = parts.join('\n');
                fileLabel = `📊 *Excel File* (${sheetNames.length} sheet${sheetNames.length > 1 ? 's' : ''}: ${sheetNames.join(', ')})`;
            } else {
                textContent = buffer.toString('utf-8');
                fileLabel = `📊 *CSV/Text File*`;
            }

            const lineCount = textContent.split('\n').length;

            let finaleContext = '';
            try {
                // Look for product IDs/SKUs in the CSV data (column headers like "Product ID", "SKU", "ProductId")
                const lines = textContent.split('\n');
                const header = lines[0]?.toLowerCase() || '';
                const skuColIndex = header.split(',').findIndex(col =>
                    col.includes('product id') || col.includes('productid') ||
                    col.includes('sku') || col.includes('item id') || col.includes('itemid')
                );

                if (skuColIndex >= 0) {
                    const skus = lines.slice(1)
                        .map(line => line.split(',')[skuColIndex]?.trim().replace(/"/g, ''))
                        .filter(sku => sku && sku.length > 1 && sku.length < 30);

                    // Limit to 10 SKUs to avoid overwhelming the API
                    const uniqueSkus = [...new Set(skus)].slice(0, 10);

                    if (uniqueSkus.length > 0) {
                        ctx.sendChatAction('typing');
                        const enrichments: string[] = [];

                        for (const sku of uniqueSkus) {
                            try {
                                const profile = await finale.getComponentStockProfile(sku);
                                if (profile.hasFinaleData) {
                                    let entry = `  ${sku}:`;
                                    if (profile.onHand !== null) entry += ` QoH=${profile.onHand} units.`;

                                    const totalDemand = profile.demandQuantity ?? profile.consumptionQuantity ?? 0;
                                    if (totalDemand > 0) {
                                        const dailyRate = totalDemand / 90;
                                        entry += ` Consumption: ${totalDemand.toFixed(1)} units over 90 days (${dailyRate.toFixed(2)} units/day).`;
                                        if (profile.onHand !== null && dailyRate > 0) {
                                            const daysOfSupply = Math.round(profile.onHand / dailyRate);
                                            entry += ` Days of supply: ~${daysOfSupply} days.`;
                                            const annualUsage = Math.round(dailyRate * 365);
                                            entry += ` Estimated annual usage: ~${annualUsage} units/year.`;
                                        }
                                    } else {
                                        entry += ` No consumption/demand data in Finale — may need to check BOM explosion or build calendar.`;
                                    }

                                    if (profile.stockoutDays !== null) entry += ` Finale stockout estimate: ${profile.stockoutDays} days.`;
                                    if (profile.onOrder !== null && profile.onOrder > 0) entry += ` On order: ${profile.onOrder} units.`;
                                    if (profile.incomingPOs.length > 0) {
                                        entry += ` Open POs: ${profile.incomingPOs.map(po => `PO#${po.orderId} (${po.quantity} units from ${po.supplier})`).join(', ')}.`;
                                    }
                                    try {
                                        const purchased = await finale.getPurchasedQty(sku, 365);
                                        if (purchased.totalQty > 0) {
                                            entry += ` PURCHASED last 365 days: ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s).`;
                                        }
                                    } catch { /* non-critical */ }

                                    enrichments.push(entry);
                                }
                            } catch { /* skip individual failures */ }
                        }

                        if (enrichments.length > 0) {
                            finaleContext = `\n\n--- FINALE INVENTORY DATA (LIVE) ---\nReal-time data from Finale Inventory. "PURCHASED last 365 days" is the EXACT received quantity from Finale POs — use this to answer purchase questions directly. "Consumption" figures are TOTALS over 90 days, daily rates are pre-calculated.\n${enrichments.join('\n')}\n--- END FINALE DATA ---`;
                        }
                    }
                }
            } catch (err: any) {
                console.warn('Excel Finale enrichment failed:', err.message);
            }

            let reply = `${fileLabel}\n`;
            reply += `🔗 File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
            reply += `📄 Lines: ${lineCount}\n`;
            if (finaleContext) reply += `🔭 _Enriched with live Finale inventory data_\n`;
            reply += `\n————————————————————\n`;

            ctx.sendChatAction('typing');
            const analysis = await unifiedTextGeneration({
                system: `You are Aria, an operations assistant for BuildASoil — a soil and growing supply manufacturer. You know this business deeply. Analyze uploaded data files and give DECISIVE, ACTIONABLE answers. Be specific with numbers, SKUs, and recommendations. Format for Telegram (markdown).

CRITICAL RULES:
1. **ANSWER THE QUESTION DIRECTLY.** Never say "you would need to check records" or "refer to purchase orders." YOU are the one who checks. If you have data, CALCULATE and ANSWER. If the data supports an estimate, give it clearly labeled as an estimate.

2. **ALWAYS DO THE MATH.** When consumption data is available:
   - If you have 90-day consumption, extrapolate: annual = (90-day value / 90) × 365
   - If asked about "last year" purchases, estimate from consumption rate: items consumed ≈ items purchased for BOM components
   - Show your calculation so Will can verify

3. **BOM Components**: If a product shows 0 sales velocity but has stock, it IS a BOM input consumed through production builds. State this as fact.
   - For BOM items, purchasing ≈ consumption over time (what goes in must be bought)
   - Use the FINALE INVENTORY DATA section (if present) for real consumption rates

4. **Be specific, not generic**: Use actual SKUs, quantities, and product names. Never give vague summaries when you have real numbers.

5. **Format answers as direct responses.** Example of GOOD response:
   "PLQ101 - Quillaja Extract Powder 20: Purchased ~223 kg last year (based on 55 kg consumed over 90 days → 0.61 kg/day × 365 days)"
   
   Example of BAD response:
   "To determine purchases, you would need to check purchase records."`,
                prompt: `User's request: ${caption || 'Analyze this file'}\n\nFile: ${filename}\nData (${textContent.length} chars total, showing up to 60,000 chars):\n${textContent.slice(0, 60000)}${finaleContext}\n\nNOTE: If data appears truncated, work with what's available above — do NOT ask for the complete data. Give the best answer possible from what you have.`,
                cacheControl: "ephemeral",
            });

            reply += analysis;
            await ctx.reply(reply, { parse_mode: 'Markdown' });

            const chatId = ctx.from?.id || ctx.chat!.id;
            if (!chatHistory[chatId]) chatHistory[chatId] = [];
            chatLastActive[chatId] = Date.now();
            chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' — ' + caption : ''}` });
            chatHistory[chatId].push({ role: "assistant", content: reply });
            if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

            setImmediate(async () => {
                try {
                    const { remember } = await import('../../lib/intelligence/memory');
                    const tagMatches = (caption + ' ' + analysis).match(/\b([A-Z][A-Z0-9-]{2,15})\b/g) || [];
                    const tags = [...new Set(tagMatches)].slice(0, 6);
                    await remember({
                        category: 'conversation',
                        content: `File analysis: "${filename}"${caption ? ' (' + caption + ')' : ''}. Key findings: "${analysis.slice(0, 400)}"`,
                        tags: [filename, ...tags],
                        source: 'telegram_auto',
                        priority: 'low',
                    });
                } catch { /* non-critical */ }
            });
            return;
        }

        // ——— PDF / Image / Word pipeline ———
        const { extractPDF } = await import('../../lib/pdf/extractor');
        const { classifyDocument } = await import('../../lib/pdf/classifier');
        const { pdfEditor } = await import('../../lib/pdf/editor');
        const { recall, remember } = await import('../../lib/intelligence/memory');

        ctx.sendChatAction('typing');
        const extraction = await extractPDF(buffer);
        const classification = await classifyDocument(extraction);

        const typeEmoji: Record<string, string> = {
            INVOICE: '💳', PURCHASE_ORDER: '📋', VENDOR_STATEMENT: '📊',
            BILL_OF_LADING: '🚚', PACKING_SLIP: '📦', FREIGHT_QUOTE: '🦦',
            CREDIT_MEMO: '💴', COA: '🧪', SDS: '⚠️', CONTRACT: '📜',
            PRODUCT_SPEC: '📄', TRACKING_NOTIFICATION: '📄', UNKNOWN: '📄',
        };
        const emoji = typeEmoji[classification.type] || '📄';
        const typeLabel = classification.type.replace(/_/g, ' ');

        let reply = `${emoji} *${typeLabel}* — _${classification.confidence} confidence_\n`;
        reply += `🔗 File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
        reply += `📄 Pages: ${extraction.metadata.pageCount}\n`;
        if (extraction.tables.length > 0) {
            reply += `📊 Tables detected: ${extraction.tables.length}\n`;
        }

        const docPreview = extraction.rawText.slice(0, 500);
        let vendorMemories: any[] = [];
        try {
            vendorMemories = await recall(`vendor document pattern ${docPreview}`, {
                category: 'vendor_pattern',
                topK: 2,
                minScore: 0.5,
            });
        } catch (err: any) {
            console.warn('Memory lookup skipped:', err.message);
        }

        const hasVendorPattern = vendorMemories.length > 0;
        const isSplitPattern = hasVendorPattern &&
            vendorMemories[0].content.toLowerCase().includes('split');

        if (hasVendorPattern) {
            reply += `\n🧠 _Memory: ${vendorMemories[0].content.slice(0, 100)}..._\n`;
        }

        const isInvoiceWorkflow = classification.type === 'VENDOR_STATEMENT'
            || classification.type === 'INVOICE'
            || caption.toLowerCase().includes('invoice')
            || caption.toLowerCase().includes('bill.com')
            || caption.toLowerCase().includes('remove')
            || isSplitPattern;

        if (isInvoiceWorkflow && extraction.pages.length >= 1) {
            ctx.sendChatAction('typing');

            let analysisPages = extraction.pages;
            if (extraction.metadata.pageCount > 1 && extraction.pages.length < extraction.metadata.pageCount * 0.8) {
                const { extractPerPage } = await import('../../lib/pdf/extractor');
                analysisPages = await extractPerPage(buffer);
                reply += `🔍 Using per-page extraction (${analysisPages.length} pages)...\n`;
            }

            const pageAnalysis = await unifiedTextGeneration({
                system: `You analyze business documents page by page. For each page, determine:
- INVOICE: An individual invoice with line items, quantities, amounts, invoice number, and invoice date
- STATEMENT: An account statement summary showing list of invoices, aging, balances
- OTHER: Cover page, terms, remittance slip, etc.

Return ONLY a JSON array: [{"page":1,"type":"INVOICE","invoiceNumber":"INV-123","date":"2026-05-13"}]
If no invoice number found, use null for invoiceNumber. If no date found, use null for date.`,
                prompt: `${analysisPages.length} pages:\n\n${analysisPages.map(p =>
                    `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 800)}\n`
                ).join('\n')}`
            });

            let pages: Array<{ page: number; type: string; invoiceNumber?: string | null; date?: string | null }> = [];
            try {
                const jsonMatch = pageAnalysis.match(/\[[\s\S]*?\]/);
                if (jsonMatch) pages = JSON.parse(jsonMatch[0]);
            } catch { /* fall through to default */ }

            if (pages.length > 0) {
                const invoicePages = pages.filter(p => p.type === 'INVOICE');
                const statementPages = pages.filter(p => p.type === 'STATEMENT');
                const otherPages = pages.filter(p => p.type === 'OTHER');
                const invoiceNums = invoicePages.map(p => p.invoiceNumber).filter(Boolean) as string[];

                reply += `\n⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭\n`;
                if (statementPages.length > 0) reply += `📊 Statement pages: ${statementPages.map(p => p.page).join(', ')}\n`;
                if (invoicePages.length > 0) reply += `💳 Invoice pages: ${invoicePages.map(p => p.page).join(', ')}\n`;
                if (invoiceNums.length > 0) reply += `📌 Invoice #: ${invoiceNums.join(', ')}\n`;

                // ── SPLIT WORKFLOW (AAACooper-style): each page → separate PDF → email ──
                if (isSplitPattern || (invoicePages.length > 1 && statementPages.length === 0)) {
                    reply += `\n✂️ Splitting ${invoicePages.length} invoices into individual PDFs...`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    const splitBuffers = await pdfEditor.splitPdf(buffer);
                    let emailsSent = 0;

                    for (const invPage of invoicePages) {
                        const pageIdx = invPage.page - 1;
                        if (pageIdx >= splitBuffers.length) continue;

                        const pageBuffer = splitBuffers[pageIdx];
                        const invNum = invPage.invoiceNumber || `page${invPage.page}`;
                        const safeInvoiceNumber = invNum.replace(/[^a-zA-Z0-9-]/g, "_");
                        const safeDate = (invPage.date || "unknown-date").replace(/[^0-9-]/g, "_");
                        const invFilename = `Invoice_${safeInvoiceNumber}_${safeDate}.pdf`;

                        await ctx.replyWithDocument({
                            source: pageBuffer,
                            filename: invFilename,
                        }, { caption: `📄 Invoice ${invNum}` });

                        try {
                            await sendPdfEmail(
                                'buildasoilap@bill.com',
                                `Invoice ${invNum}`,
                                `Invoice ${invNum} attached.\nExtracted from: ${filename}`,
                                pageBuffer,
                                invFilename,
                            );
                            emailsSent++;
                        } catch (emailErr: any) {
                            console.error(`Email failed for ${invNum}:`, emailErr.message);
                            await ctx.reply(`⚠️ Email failed for ${invNum}: ${emailErr.message}`, { parse_mode: 'Markdown' });
                        }
                    }

                    if (emailsSent > 0) {
                        await ctx.reply(`✉️ ✅ Sent ${emailsSent} invoice(s) to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    }
                    return;
                }

                // ── REMOVE workflow: strip invoice pages, keep statement ──
                if (invoicePages.length > 0 && statementPages.length > 0) {
                    const pagesToRemove = invoicePages.map(p => p.page - 1);
                    const cleanedBuffer = await pdfEditor.removePages(buffer, pagesToRemove);

                    reply += `\n✂️ Removed ${invoicePages.length} invoice page(s) — ${statementPages.length} statement page(s) remain`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    const cleanFilename = filename.replace(/\.(pdf|PDF)$/, '_STATEMENT_ONLY.$1');
                    await ctx.replyWithDocument({
                        source: cleanedBuffer,
                        filename: cleanFilename,
                    }, { caption: `📊 Statement only (invoices removed)` });

                    try {
                        await sendPdfEmail(
                            'buildasoilap@bill.com',
                            `Vendor Statement - ${invoiceNums.join(', ') || filename}`,
                            `Vendor statement attached. Invoice pages removed.\nOriginal: ${filename}\nInvoices: ${invoiceNums.join(', ') || 'N/A'}`,
                            cleanedBuffer,
                            cleanFilename,
                        );
                        await ctx.reply(`✉️ ✅ Sent statement to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    } catch (emailErr: any) {
                        console.error('Bill.com email error:', emailErr.message);
                        await ctx.reply(`⚠️ PDF cleaned but email failed: ${emailErr.message}`, { parse_mode: 'Markdown' });
                    }
                    return;
                }

                // Single invoice — forward as-is
                if (invoicePages.length === 1 && statementPages.length === 0) {
                    const invPage = invoicePages[0];
                    const invNum = invPage.invoiceNumber || 'unknown';
                    const safeInvoiceNumber = invNum.replace(/[^a-zA-Z0-9-]/g, "_");
                    const safeDate = (invPage.date || "unknown-date").replace(/[^0-9-]/g, "_");
                    const invFilename = `Invoice_${safeInvoiceNumber}_${safeDate}.pdf`;

                    reply += `\n✉️ Forwarding to bill.com...`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    try {
                        await sendPdfEmail(
                            'buildasoilap@bill.com',
                            `Invoice ${invNum}`,
                            `Invoice ${invNum} attached.\nFile: ${filename}`,
                            buffer,
                            invFilename,
                        );
                        await ctx.reply(`✉️ ✅ Sent to \`buildasoilap@bill.com\` — Invoice ${invNum}`, { parse_mode: 'Markdown' });
                    } catch (emailErr: any) {
                        await ctx.reply(`⚠️ Email failed: ${emailErr.message}`, { parse_mode: 'Markdown' });
                    }
                    return;
                }
            }
        }

        // ── DEFAULT: General document summary ──
        if (extraction.rawText.length > 50) {
            ctx.sendChatAction('typing');
            const summary = await unifiedTextGeneration({
                system: `You are Aria, summarizing a business document for Will at BuildASoil.
Be concise. Focus on: vendor name, amounts, dates, key items/SKUs, and any action needed.`,
                prompt: `Document type: ${typeLabel}\nCaption: ${caption || '(none)'}\n\n${extraction.rawText.slice(0, 3000)}`
            });
            reply += `\n⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭ ⏭\n${summary}`;
        } else {
            reply += `\n⚠️ _Very little text extracted. This might be a scanned/image PDF._`;
        }

        try {
            await remember({
                category: 'general',
                content: `Processed document: ${filename} (${typeLabel}). ${extraction.metadata.pageCount} pages.`,
                tags: [typeLabel.toLowerCase(), filename],
                source: 'telegram',
            });
        } catch { /* non-critical */ }

        await ctx.reply(reply, { parse_mode: 'Markdown' });

        const chatId = ctx.from?.id || ctx.chat!.id;
        if (!chatHistory[chatId]) chatHistory[chatId] = [];
        chatLastActive[chatId] = Date.now();
        chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' — ' + caption : ''}` });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

    } catch (err: any) {
        console.error(`Document processing error (${filename}):`, err.message);
        await ctx.reply(`❌ Failed to process *${filename}*: ${err.message}`, { parse_mode: 'Markdown' });
    }
}
