import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { describeImageArtifact, saveArtifact } from '@/lib/copilot/artifacts';

const SUPPORTED_MIME = new Set([
    'application/pdf',
    'application/x-pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel',
    'text/csv',
]);

export async function POST(req: Request) {
    try {
        const { filename, mimeType, base64 } = await req.json();

        if (!filename || !mimeType || !base64) {
            return NextResponse.json({ error: 'filename, mimeType, and base64 required' }, { status: 400 });
        }

        if (!SUPPORTED_MIME.has(mimeType)) {
            return NextResponse.json({ error: `Unsupported file type: ${mimeType}` }, { status: 400 });
        }

        const buffer = Buffer.from(base64, 'base64');
        let reply = '';

        // ── Image files → GPT-4o Vision ──────────────────────────────
        if (mimeType.startsWith('image/')) {
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: 'OpenAI not configured' }, { status: 500 });

            const res = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: `data:${mimeType};base64,${base64}` }
                        },
                        {
                            type: 'text',
                            text: `You are Aria, an operations assistant for BuildASoil. Analyze this image and describe what you see in the context of business operations — invoices, purchase orders, products, labels, etc. Be concise and direct.`
                        }
                    ]
                }],
                max_tokens: 500
            });
            reply = res.choices[0].message.content || 'Could not analyze image.';

            await saveArtifact({
                threadId: 'dashboard',
                channel: 'dashboard',
                sourceType: 'dashboard_upload',
                filename,
                mimeType,
                rawText: base64,
                summary: reply,
                tags: ['dashboard', 'upload'],
            });

            // Log both sides to sys_chat_logs so they appear in the chat feed
            try {
                const { createClient } = await import('@/lib/supabase');
                const db = createClient();
                if (db) {
                    await db.from('sys_chat_logs').insert([
                        {
                            source: 'telegram',
                            role: 'user',
                            content: `[Uploaded file: ${filename}]`,
                            metadata: { from: 'dashboard', fileType: mimeType }
                        },
                        {
                            source: 'telegram',
                            role: 'assistant',
                            content: reply,
                            metadata: { from: 'dashboard' }
                        }
                    ]);
                }
            } catch { /* non-blocking */ }
        }

        // ── PDF files → extract + classify + parse ─────────────────────
        else if (mimeType === 'application/pdf' || mimeType === 'application/x-pdf') {
            const { extractPDF } = await import('@/lib/pdf/extractor');
            const extracted = await extractPDF(buffer);

            let actionMetadata: any = null;
            let classification: { type: string; confidence: string; reasoning?: string } | null = null;

            if (!extracted?.rawText?.trim()) {
                reply = `Uploaded ${filename} — but couldn't extract text. The PDF may be scanned or protected.`;
            } else {
                const { classifyDocument } = await import('@/lib/pdf/classifier');
                classification = await classifyDocument(extracted);

                if (classification.type === 'INVOICE') {
                    const { parseInvoice } = await import('@/lib/pdf/invoice-parser');
                    const invoice = await parseInvoice(
                        extracted.rawText,
                        extracted.tables?.map(t => [t.headers.join(" | "), ...t.rows.map(r => r.join(" | "))])
                    );
                    const lines = invoice.lineItems?.length
                        ? invoice.lineItems.slice(0, 8).map(li =>
                            `  • ${li.sku || li.description} — qty ${li.qty} @ $${li.unitPrice} = $${li.total}`
                        ).join('\n')
                        : '  (no line items parsed)';
                    reply = [
                        `📄 **Invoice detected** — ${filename}`,
                        `Vendor: ${invoice.vendorName || 'unknown'}`,
                        `Invoice #: ${invoice.invoiceNumber || 'unknown'}`,
                        `PO #: ${invoice.poNumber || 'none'}`,
                        `Total: $${invoice.total?.toLocaleString() || 'unknown'}`,
                        `Due: ${invoice.dueDate || 'unknown'}`,
                        invoice.lineItems?.length ? `\nLine items (${invoice.lineItems.length}):\n${lines}` : '',
                    ].filter(Boolean).join('\n');

                    actionMetadata = {
                        action_type: 'invoice_ready',
                        filename,
                        bufferBase64: buffer.toString('base64'),
                        vendorName: invoice.vendorName,
                        total: invoice.total
                    };

                } else if (classification.type === 'PURCHASE_ORDER') {
                    const { parsePurchaseOrder } = await import('@/lib/pdf/po-parser');
                    const po = await parsePurchaseOrder(extracted.rawText);
                    const lines = po.lineItems?.slice(0, 8).map((li: any) =>
                        `  • ${li.sku || li.description} — qty ${li.qtyOrdered} @ $${li.unitPrice}`
                    ).join('\n') || '  (no line items)';
                    reply = [
                        `📋 **Purchase Order detected** — ${filename}`,
                        `Vendor: ${(po as any).vendorName || 'unknown'}`,
                        `PO #: ${(po as any).poNumber || 'unknown'}`,
                        `Total: $${(po as any).total?.toLocaleString() || 'unknown'}`,
                        po.lineItems?.length ? `\nLine items (${po.lineItems.length}):\n${lines}` : '',
                    ].filter(Boolean).join('\n');

                } else if (classification.type === 'BILL_OF_LADING') {
                    const { parseBOL } = await import('@/lib/pdf/bol-parser');
                    const bol = await parseBOL(extracted.rawText);
                    reply = [
                        `🚚 **Bill of Lading detected** — ${filename}`,
                        `Carrier: ${bol.carrierName || 'unknown'}`,
                        `PRO #: ${bol.proNumber || 'unknown'}`,
                        `Shipper: ${bol.shipperName || 'unknown'}`,
                        `Consignee: ${bol.consigneeName || 'unknown'}`,
                        bol.poNumbers?.length ? `PO #s: ${bol.poNumbers.join(', ')}` : '',
                    ].filter(Boolean).join('\n');

                } else {
                    // Generic: use GPT-4o on extracted text
                    const openai = process.env.OPENAI_API_KEY
                        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
                        : null;
                    if (openai) {
                        const res = await openai.chat.completions.create({
                            model: 'gpt-4o',
                            messages: [
                                {
                                    role: 'system',
                                    content: 'You are Aria, an operations assistant for BuildASoil. Summarize this document concisely in the context of business operations. Be direct and highlight anything actionable.'
                                },
                                {
                                    role: 'user',
                                    content: `Document: ${filename}\nType detected: ${classification.type}\n\n${extracted.rawText.slice(0, 3000)}`
                                }
                            ],
                            max_tokens: 500
                        });
                        reply = `📎 **${classification.type} detected** — ${filename}\n\n${res.choices[0].message.content || ''}`;
                    } else {
                        reply = `📎 ${filename} — detected as ${classification.type} (${classification.confidence} confidence)\n\nText preview:\n${extracted.rawText.slice(0, 400)}`;
                    }
                }
            }

            await saveArtifact({
                threadId: 'dashboard',
                channel: 'dashboard',
                sourceType: 'dashboard_upload',
                filename,
                mimeType,
                rawText: extracted.rawText,
                summary: reply,
                structuredData: classification ?? undefined,
                tags: classification
                    ? ['dashboard', 'upload', classification.type.toLowerCase()]
                    : ['dashboard', 'upload', 'pdf'],
            });

            // Log both sides to sys_chat_logs so they appear in the chat feed
            try {
                const { createClient } = await import('@/lib/supabase');
                const db = createClient();
                if (db) {
                    await db.from('sys_chat_logs').insert([
                        {
                            source: 'telegram',
                            role: 'user',
                            content: `[Uploaded file: ${filename}]`,
                            metadata: { from: 'dashboard', fileType: mimeType }
                        },
                        {
                            source: 'telegram',
                            role: 'assistant',
                            content: reply,
                            metadata: { from: 'dashboard', ...actionMetadata }
                        }
                    ]);
                }
            } catch { /* non-blocking */ }

            return NextResponse.json({ reply, actionMetadata });
        }

        // ── Spreadsheets ─────────────────────────────────────────────
        else {
            const openai = process.env.OPENAI_API_KEY
                ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
                : null;
            if (!openai) return NextResponse.json({ error: 'OpenAI not configured' }, { status: 500 });

            // For xlsx/csv, try to decode as text and send to GPT
            let textContent = '';
            try {
                textContent = buffer.toString('utf-8').slice(0, 4000);
            } catch {
                textContent = '[binary file — could not decode as text]';
            }

            const res = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: 'You are Aria, operations assistant for BuildASoil. Analyze this spreadsheet/CSV data and summarize key findings relevant to purchasing, inventory, or operations.'
                    },
                    {
                        role: 'user',
                        content: `File: ${filename}\n\n${textContent}`
                    }
                ],
                max_tokens: 600
            });
            reply = `📊 **${filename}**\n\n${res.choices[0].message.content || ''}`;

            await saveArtifact({
                threadId: 'dashboard',
                channel: 'dashboard',
                sourceType: 'dashboard_upload',
                filename,
                mimeType,
                rawText: textContent,
                summary: reply,
                tags: ['dashboard', 'upload', 'spreadsheet'],
            });

            // Log both sides to sys_chat_logs so they appear in the chat feed
            try {
                const { createClient } = await import('@/lib/supabase');
                const db = createClient();
                if (db) {
                    await db.from('sys_chat_logs').insert([
                        {
                            source: 'telegram',
                            role: 'user',
                            content: `[Uploaded file: ${filename}]`,
                            metadata: { from: 'dashboard', fileType: mimeType }
                        },
                        {
                            source: 'telegram',
                            role: 'assistant',
                            content: reply,
                            metadata: { from: 'dashboard' }
                        }
                    ]);
                }
            } catch { /* non-blocking */ }
        }

        return NextResponse.json({ reply });
    } catch (err: any) {
        console.error('Dashboard upload error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
