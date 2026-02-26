/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Anthropic (Claude), and OpenAI (Fallback) with tool access.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-20
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import axios from 'axios';
import OpenAI from 'openai';
import {
    SYSTEM_PROMPT,
    VOICE_CONFIG,
    TELEGRAM_CONFIG
} from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { google } from 'googleapis';
import { unifiedTextGeneration } from '../lib/intelligence/llm';
import { FinaleClient } from '../lib/finale/client';

// ──────────────────────────────────────────────────
// CLIENT INITIALIZATION
// ──────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const perplexityKey = process.env.PERPLEXITY_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
const perplexity = perplexityKey ? new OpenAI({
    apiKey: perplexityKey,
    baseURL: 'https://api.perplexity.ai'
}) : null;

// Finale Inventory client
const finale = new FinaleClient();

console.log('🚀 ARIA BOT BOOTING...');
console.log(`🤖 Telegram: ✅ Connected`);
console.log(`🧠 Unified LLM: ✅ Ready (Anthropic + OpenAI Fallback)`);
console.log(`🔍 Perplexity: ${perplexityKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`🎙️ ElevenLabs: ${elevenLabsKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`📦 Finale: ${process.env.FINALE_API_KEY ? '✅ Connected' : '❌ Not Configured'}`);

// ──────────────────────────────────────────────────
// COMMANDS
// ──────────────────────────────────────────────────

bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

bot.command('status', (ctx) => {
    ctx.reply(
        `🛰️ **Aria Internal Diagnostics**\n\n` +
        `Status: Operational\n` +
        `Telegram: ✅ Online\n` +
        `Intelligence: ✅ Unified (Sonnet 3.5 + GPT-4o)\n` +
        `Voice: ${elevenLabsKey ? '✅ Loaded' : '❌ Missing'}\n\n` +
        `_"Efficiency is doing things right; effectiveness is doing the right things."_`,
        { parse_mode: 'Markdown' }
    );
});

// /product <SKU> — Look up a product in Finale Inventory
bot.command('product', async (ctx) => {
    const sku = ctx.message.text.replace('/product', '').trim();

    if (!sku) {
        return ctx.reply(
            `📦 *Finale Product Lookup*\n\n` +
            `Usage: \`/product <SKU>\`\n\n` +
            `Examples:\n` +
            `  \`/product S-12527\`\n` +
            `  \`/product BC101\`\n` +
            `  \`/product PU102\`\n\n` +
            `_Use the exact SKU from Finale._`,
            { parse_mode: 'Markdown' }
        );
    }

    ctx.sendChatAction('typing');

    try {
        const report = await finale.productReport(sku);
        await ctx.reply(report.telegramMessage, {
            parse_mode: 'Markdown',
            // @ts-ignore — Telegraf types don't include disable_web_page_preview
            disable_web_page_preview: true,
        });
    } catch (err: any) {
        console.error(`Product lookup error for ${sku}:`, err.message);
        ctx.reply(`❌ Error looking up \`${sku}\`: ${err.message}`);
    }
});

// /receivings — post today's received POs to Telegram + Slack #purchasing
bot.command('receivings', async (ctx) => {
    ctx.sendChatAction('typing');

    try {
        const received = await finale.getTodaysReceivedPOs();
        const digest = finale.formatReceivingsDigest(received);

        // Send to Telegram (convert Slack mrkdwn to Telegram Markdown)
        const telegramMsg = digest
            .replace(/:package:/g, '📦')
            .replace(/:white_check_mark:/g, '✅')
            .replace(/<([^|]+)\|([^>]+)>/g, '[$2]($1)');  // Slack links → Markdown

        await ctx.reply(telegramMsg, {
            parse_mode: 'Markdown',
            // @ts-ignore
            disable_web_page_preview: true,
        });

        // Post to Slack #purchasing if token available
        if (process.env.SLACK_BOT_TOKEN) {
            try {
                const { WebClient } = await import('@slack/web-api');
                const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
                await slack.chat.postMessage({
                    channel: '#purchasing',
                    text: digest,
                    mrkdwn: true,
                });
                await ctx.reply('✅ _Also posted to Slack #purchasing_', { parse_mode: 'Markdown' });
            } catch (slackErr: any) {
                console.error('Slack post error:', slackErr.message);
                await ctx.reply('⚠️ _Telegram only — Slack post failed_', { parse_mode: 'Markdown' });
            }
        }
    } catch (err: any) {
        console.error('Receivings error:', err.message);
        ctx.reply(`❌ Error fetching receivings: ${err.message}`);
    }
});

// /remember — store something in Aria's memory
bot.command('remember', async (ctx) => {
    const text = ctx.message.text.replace(/^\/remember\s*/, '').trim();
    if (!text) {
        return ctx.reply('Usage: `/remember AAACooper sends multi-page invoices as statements`', { parse_mode: 'Markdown' });
    }

    try {
        const { remember } = await import('../lib/intelligence/memory');
        await remember({
            category: 'general',
            content: text,
            source: 'telegram',
            priority: 'normal',
        });
        await ctx.reply(`🧠 Got it. I'll remember that.`, { parse_mode: 'Markdown' });
    } catch (err: any) {
        ctx.reply(`❌ Memory error: ${err.message}`);
    }
});

// /recall — search Aria's memory
bot.command('recall', async (ctx) => {
    const query = ctx.message.text.replace(/^\/recall\s*/, '').trim();
    if (!query) {
        return ctx.reply('Usage: `/recall AAACooper invoices`', { parse_mode: 'Markdown' });
    }

    ctx.sendChatAction('typing');
    try {
        const { recall } = await import('../lib/intelligence/memory');
        const memories = await recall(query, { topK: 5 });

        if (memories.length === 0) {
            return ctx.reply('🧠 No relevant memories found.');
        }

        let reply = `🧠 *${memories.length} memories found:*\n\n`;
        for (const mem of memories) {
            const score = (mem.score * 100).toFixed(0);
            reply += `• \\[${mem.category}\\] ${mem.content.slice(0, 150)}\n  _${score}% match · ${mem.storedAt?.slice(0, 10) || 'unknown'}_\n\n`;
        }
        await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err: any) {
        ctx.reply(`❌ Recall error: ${err.message}`);
    }
});

// /seed — initialize Aria's memory with known vendor patterns
bot.command('seed', async (ctx) => {
    ctx.sendChatAction('typing');
    try {
        const { seedMemories } = await import('../lib/intelligence/memory');
        await seedMemories();
        await ctx.reply('🌱 ✅ Memory seeded with known vendor patterns and processes.');
    } catch (err: any) {
        ctx.reply(`❌ Seed error: ${err.message}`);
    }
});

// /consumption — BOM consumption report for raw material SKUs
bot.command('consumption', async (ctx) => {
    const args = ctx.message.text.replace(/^\/consumption\s*/, '').trim().split(/\s+/);
    const sku = args[0];
    const days = parseInt(args[1]) || 90;

    if (!sku) {
        return ctx.reply('Usage: `/consumption 3.0BAGCF` or `/consumption 3.0BAGCF 60`\n_Default: last 90 days_', { parse_mode: 'Markdown' });
    }

    ctx.sendChatAction('typing');
    await ctx.reply(`👀📊 Pulling consumption data for \`${sku}\` (last ${days} days)...`, { parse_mode: 'Markdown' });

    try {
        const { FinaleClient } = await import('../lib/finale/client');
        const finale = new FinaleClient();
        const report = await finale.getBOMConsumption(sku, days);
        await ctx.reply(report.telegramMessage, { parse_mode: 'Markdown' });
    } catch (err: any) {
        console.error('Consumption error:', err.message);
        await ctx.reply(`❌ Failed to get consumption for \`${sku}\`: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// /simulate (or /build) — simulate a production build explosion
bot.command(['simulate', 'build'], async (ctx) => {
    const rawArgs = ctx.message.text.split(' ');
    // Remove the command part (first element)
    rawArgs.shift();

    // We want to handle strings like `CRAFT8 15`, `CRAFT8 = 15`, `CRAFT8 x 15`
    const argsStr = rawArgs.join(' ').replace(/=|x|X/g, ' ').trim();
    const cleanArgs = argsStr.split(/\s+/).filter(Boolean);

    const sku = cleanArgs[0];
    const qty = parseInt(cleanArgs[1]) || 1;

    if (!sku || isNaN(qty)) {
        return ctx.reply('Usage: `/simulate CRAFT8 15` or `/build CRAFT8 = 15`', { parse_mode: 'Markdown' });
    }

    ctx.sendChatAction('typing');
    try {
        const { simulateBuild } = await import('../lib/builds/build-risk');
        const report = await simulateBuild(sku, qty, (msg) => {
            console.log(`[simulate] ${msg}`);
        });
        await ctx.reply(report, { parse_mode: 'Markdown' });
    } catch (err: any) {
        console.error('Simulation error:', err.message);
        await ctx.reply(`❌ Simulation failed for \`${sku}\`: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// /buildrisk — 30-day build risk analysis (Calendar → BOM → Stock + POs)
bot.command('buildrisk', async (ctx) => {
    ctx.sendChatAction('typing');
    await ctx.reply('🏭 Running 30-Day Build Risk Analysis...\n_Fetching calendars, parsing builds, exploding BOMs, checking stock + POs (now 5x parallel)..._', { parse_mode: 'Markdown' });

    try {
        const { runBuildRiskAnalysis } = await import('../lib/builds/build-risk');
        const report = await runBuildRiskAnalysis(30, (msg) => {
            console.log(`[buildrisk] ${msg}`);
        });

        await ctx.reply(report.telegramMessage, { parse_mode: 'Markdown' });

        // Follow-up: Ask about unrecognized SKUs
        if (report.unrecognizedSkus.length > 0) {
            let askMsg = `❓ *I couldn't find these SKUs in Finale:*\n\n`;
            for (const u of report.unrecognizedSkus) {
                askMsg += `• \`${u.sku}\` (${u.totalQty} units, needed ${u.earliestDate})\n`;
                if (u.suggestions.length > 0) {
                    askMsg += `  → Similar items found: ${u.suggestions.slice(0, 3).map(s => `\`${s}\``).join(', ')}\n`;
                    askMsg += `  _Is one of these what you meant?_\n`;
                } else {
                    askMsg += `  _No similar SKUs found. What's the correct product name?_\n`;
                }
                askMsg += `\n`;
            }
            askMsg += `_Reply with the correct SKU mappings and I'll update the analysis._`;
            await ctx.reply(askMsg, { parse_mode: 'Markdown' });
        }

        // Also post to Slack if configured
        if (process.env.SLACK_BOT_TOKEN) {
            try {
                const { WebClient } = await import('@slack/web-api');
                const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
                await slack.chat.postMessage({
                    channel: '#purchasing',
                    text: report.slackMessage,
                    mrkdwn: true,
                });
                await ctx.reply('📤 _Also posted to Slack #purchasing_', { parse_mode: 'Markdown' });
            } catch (slackErr: any) {
                console.error('Slack post error:', slackErr.message);
            }
        }
    } catch (err: any) {
        console.error('Build risk error:', err.message);
        await ctx.reply(`❌ Build risk analysis failed: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// /requests — Show recent Slack product requests detected by the watchdog
bot.command('requests', async (ctx) => {
    ctx.sendChatAction('typing');

    try {
        // The OpsManager doesn't expose the watchdog directly to the bot,
        // so we import and format the data ourselves from the Slack module
        const { createClient } = await import('../lib/supabase');
        const supabase = createClient();

        // No formal command yet — just tell Will what we know
        // For now, this is a placeholder until Slack watchdog state is shared
        await ctx.reply(
            `🦊 *Slack Request Tracker*\n\n` +
            `The watchdog monitors *#purchase* and *#purchase-orders* for product requests.\n\n` +
            `Recent requests are sent as digests directly to this chat.\n` +
            `Look for 🦊 *Aria Slack Digest* messages above.\n\n` +
            `_Channels monitored: DMs, #purchase, #purchase-orders_\n` +
            `_Your own messages are now filtered out._`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
    }
});

// /voice
bot.command('voice', async (ctx) => {
    if (!elevenLabsKey) return ctx.reply('❌ ElevenLabs API key not configured.');

    ctx.reply('🎙️ Aria is thinking... (Voice generation in progress)');

    try {
        let textToSpeak = await unifiedTextGeneration({
            system: SYSTEM_PROMPT + "\n\nLimit your response to a single, clever sentence under 25 words for a voice greeting.",
            prompt: "Say something witty and operational to Will to start the day."
        });

        // Pass to ElevenLabs
        const voiceResponse = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_CONFIG.voiceId}`,
            {
                text: textToSpeak,
                model_id: VOICE_CONFIG.modelId,
                voice_settings: {
                    stability: VOICE_CONFIG.stability,
                    similarity_boost: VOICE_CONFIG.similarityBoost,
                    style: VOICE_CONFIG.style,
                },
            },
            {
                headers: {
                    'xi-api-key': elevenLabsKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                responseType: 'arraybuffer',
            }
        );

        await ctx.replyWithVoice({
            source: Buffer.from(voiceResponse.data),
            filename: 'aria-reply.ogg',
        });

        ctx.reply(`💬 _Text version: "${textToSpeak}"_`, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error('Voice generation error:', err.message);
        ctx.reply(`❌ Failed to find my voice: ${err.message}`);
    }
});

// /populate
bot.command('populate', async (ctx) => {
    ctx.reply("🧠 Starting PO Memory Backfill (Last 2 Weeks)... This will take a moment.");
    try {
        const { processEmailAttachments } = require('../lib/gmail/attachment-handler');
        const auth = await getAuthenticatedClient("default");
        const gmail = google.gmail({ version: "v1", auth });

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const dateQuery = twoWeeksAgo.toISOString().split('T')[0].replace(/-/g, '/');

        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: `label:PO after:${dateQuery}`,
            maxResults: 15
        });

        if (!search.messages?.length) return ctx.reply("📭 No recent POs found.");

        let count = 0;
        for (const m of search.messages) {
            const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata" });
            const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
            const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "Unknown";
            const date = msg.payload?.headers?.find(h => h.name === 'Date')?.value || "";

            const { indexOperationalContext } = require('../lib/intelligence/pinecone');
            await indexOperationalContext(
                `po-thread-${m.id}`,
                `PO Thread: ${subject} from ${from}. Date: ${date}`,
                { source: "telegram_backfill", subject, from, date }
            );

            await processEmailAttachments("default", m.id!, { from, subject, date });
            count++;
        }
        ctx.reply(`✨ Backfill complete! Processed ${count} PO threads.`);
    } catch (err: any) {
        ctx.reply(`❌ Backfill failed: ${err.message}`);
    }
});

// ──────────────────────────────────────────────────
// REUSABLE: Send email with PDF attachment via Gmail API
// ──────────────────────────────────────────────────

async function sendPdfEmail(to: string, subject: string, body: string, pdfBuffer: Buffer, pdfFilename: string): Promise<void> {
    const { getAuthenticatedClient: getGmailAuth } = await import('../lib/gmail/auth');
    const { google } = await import('googleapis');
    const auth = await getGmailAuth('default');
    const gmail = google.gmail({ version: 'v1', auth });

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

// ──────────────────────────────────────────────────
// DOCUMENT/FILE HANDLER — PDFs, images, Word docs
// Memory-aware: checks Pinecone for vendor patterns
// ──────────────────────────────────────────────────

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name || 'unknown';
    const mimeType = doc.mime_type || '';
    const caption = ctx.message.caption || '';

    // Only process supported file types
    const SUPPORTED = ['application/pdf', 'application/x-pdf', 'image/png', 'image/jpeg',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/csv', 'text/plain', 'application/csv',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

    if (!SUPPORTED.some(m => mimeType.includes(m.split('/')[1]))) {
        await ctx.reply(`📎 Got *${filename}* but I can't process \`${mimeType}\` files yet.\n_I handle: PDF, PNG, JPEG, DOC/DOCX, CSV, TXT, XLS/XLSX_`, { parse_mode: 'Markdown' });
        return;
    }

    if (doc.file_size && doc.file_size > 20_000_000) {
        await ctx.reply('⚠️ File too large (>20MB). Try emailing it to me instead.');
        return;
    }

    ctx.sendChatAction('typing');
    await ctx.reply(`📎 Processing *${filename}*... one moment.`, { parse_mode: 'Markdown' });

    try {
        // Download file from Telegram
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        // ── CSV / TEXT files: skip PDF pipeline, go straight to LLM ──
        const isTextFile = mimeType.includes('csv') || mimeType.includes('text/plain')
            || filename.endsWith('.csv') || filename.endsWith('.txt');

        if (isTextFile) {
            const textContent = buffer.toString('utf-8');
            const lineCount = textContent.split('\n').length;
            const preview = textContent.slice(0, 500);

            let reply = `📊 *CSV/Text File*\n`;
            reply += `📎 File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
            reply += `📝 Lines: ${lineCount}\n`;
            reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;

            ctx.sendChatAction('typing');
            const analysis = await unifiedTextGeneration({
                system: `You are Aria, an operations assistant for BuildASoil. The user has uploaded a CSV/text file. Analyze the data and answer their question directly. Be specific with numbers and SKUs. Format your response for Telegram (use markdown).

IMPORTANT CONTEXT about BuildASoil's inventory:
- Some items are RAW MATERIALS consumed through BOM (Bill of Materials) production builds, NOT through direct sales.
- If an item shows 0 "Sales Velocity" or 0 consumption, it may be a BOM component (bags, labels, inputs, soil amendments).
- True consumption for BOM components comes from build orders, not sales data.
- If you see 0 velocity for items that clearly are consumables (bags, packaging, raw ingredients), flag this and explain that consumption comes from production builds, not sales.
- Look for columns like "Build Usage", "BOM Consumption", "Production Usage" if available.
- Stock levels are still accurate — they reflect current on-hand after all builds and receipts.`,
                prompt: `User's request: ${caption || 'Analyze this file'}\n\nFile: ${filename}\nData (${textContent.length} chars total):\n${textContent.slice(0, 30000)}`
            });

            reply += analysis;
            await ctx.reply(reply, { parse_mode: 'Markdown' });
            return;
        }

        // ── PDF / Image / Word pipeline ──
        const { extractPDF } = await import('../lib/pdf/extractor');
        const { classifyDocument } = await import('../lib/pdf/classifier');
        const { pdfEditor } = await import('../lib/pdf/editor');
        const { recall, remember } = await import('../lib/intelligence/memory');

        // Extract text & classify
        ctx.sendChatAction('typing');
        const extraction = await extractPDF(buffer);
        const classification = await classifyDocument(extraction);

        const typeEmoji: Record<string, string> = {
            INVOICE: '🧾', PURCHASE_ORDER: '📋', VENDOR_STATEMENT: '📊',
            BILL_OF_LADING: '🚚', PACKING_SLIP: '📦', FREIGHT_QUOTE: '🏷️',
            CREDIT_MEMO: '💳', COA: '🔬', SDS: '⚠️', CONTRACT: '📜',
            PRODUCT_SPEC: '📐', TRACKING_NOTIFICATION: '📍', UNKNOWN: '📄',
        };
        const emoji = typeEmoji[classification.type] || '📄';
        const typeLabel = classification.type.replace(/_/g, ' ');

        let reply = `${emoji} *${typeLabel}* — _${classification.confidence} confidence_\n`;
        reply += `📎 File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
        reply += `📄 Pages: ${extraction.metadata.pageCount}\n`;
        if (extraction.tables.length > 0) {
            reply += `📊 Tables detected: ${extraction.tables.length}\n`;
        }

        // ── CHECK MEMORY: Do we know this vendor's pattern? ──
        const docPreview = extraction.rawText.slice(0, 500);
        let vendorMemories: Awaited<ReturnType<typeof recall>> = [];
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

        // ── Analyze pages with LLM ──
        const isInvoiceWorkflow = classification.type === 'VENDOR_STATEMENT'
            || classification.type === 'INVOICE'
            || caption.toLowerCase().includes('invoice')
            || caption.toLowerCase().includes('bill.com')
            || caption.toLowerCase().includes('remove')
            || isSplitPattern;

        if (isInvoiceWorkflow && extraction.pages.length >= 1) {
            ctx.sendChatAction('typing');

            // Use physical per-page extraction for accurate page text
            // (form-feed splitting often fails — this splits via pdf-lib)
            let analysisPages = extraction.pages;
            if (extraction.metadata.pageCount > 1 && extraction.pages.length < extraction.metadata.pageCount * 0.8) {
                const { extractPerPage } = await import('../lib/pdf/extractor');
                analysisPages = await extractPerPage(buffer);
                reply += `🔬 Using per-page extraction (${analysisPages.length} pages)...\n`;
            }

            // Per-page analysis
            const pageAnalysis = await unifiedTextGeneration({
                system: `You analyze business documents page by page. For each page, determine:
- INVOICE: An individual invoice with line items, quantities, amounts, invoice number
- STATEMENT: An account statement summary showing list of invoices, aging, balances
- OTHER: Cover page, terms, remittance slip, etc.

Return ONLY a JSON array: [{"page":1,"type":"INVOICE","invoiceNumber":"INV-123"}]
If no invoice number found, use null for invoiceNumber.`,
                prompt: `${analysisPages.length} pages:\n\n${analysisPages.map(p =>
                    `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 800)}\n`
                ).join('\n')}`
            });

            let pages: Array<{ page: number; type: string; invoiceNumber?: string | null }> = [];
            try {
                const jsonMatch = pageAnalysis.match(/\[[\s\S]*?\]/);
                if (jsonMatch) pages = JSON.parse(jsonMatch[0]);
            } catch { /* fall through to default */ }

            if (pages.length > 0) {
                const invoicePages = pages.filter(p => p.type === 'INVOICE');
                const statementPages = pages.filter(p => p.type === 'STATEMENT');
                const otherPages = pages.filter(p => p.type === 'OTHER');
                const invoiceNums = invoicePages.map(p => p.invoiceNumber).filter(Boolean) as string[];

                reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;
                if (statementPages.length > 0) reply += `📊 Statement pages: ${statementPages.map(p => p.page).join(', ')}\n`;
                if (invoicePages.length > 0) reply += `🧾 Invoice pages: ${invoicePages.map(p => p.page).join(', ')}\n`;
                if (invoiceNums.length > 0) reply += `📝 Invoice #: ${invoiceNums.join(', ')}\n`;

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
                        const invFilename = `${invNum.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;

                        // Send each invoice PDF back to chat
                        await ctx.replyWithDocument({
                            source: pageBuffer,
                            filename: invFilename,
                        }, { caption: `🧾 Invoice ${invNum}` });

                        // Email each to bill.com
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
                        await ctx.reply(`📧 ✅ Sent ${emailsSent} invoice(s) to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    }

                    return; // Done
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
                        await ctx.reply(`📧 ✅ Sent statement to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    } catch (emailErr: any) {
                        console.error('Bill.com email error:', emailErr.message);
                        await ctx.reply(`⚠️ PDF cleaned but email failed: ${emailErr.message}`, { parse_mode: 'Markdown' });
                    }

                    return;
                }

                // Single invoice — forward as-is
                if (invoicePages.length === 1 && statementPages.length === 0) {
                    const invNum = invoiceNums[0] || 'unknown';
                    reply += `\n📧 Forwarding to bill.com...`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    try {
                        await sendPdfEmail(
                            'buildasoilap@bill.com',
                            `Invoice ${invNum}`,
                            `Invoice ${invNum} attached.\nFile: ${filename}`,
                            buffer,
                            filename,
                        );
                        await ctx.reply(`📧 ✅ Sent to \`buildasoilap@bill.com\` — Invoice ${invNum}`, { parse_mode: 'Markdown' });
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
            reply += `\n━━━━━━━━━━━━━━━━━━━━\n${summary}`;
        } else {
            reply += `\n⚠️ _Very little text extracted. This might be a scanned/image PDF._`;
        }

        // Store this interaction as a memory
        try {
            await remember({
                category: 'general',
                content: `Processed document: ${filename} (${typeLabel}). ${extraction.metadata.pageCount} pages.`,
                tags: [typeLabel.toLowerCase(), filename],
                source: 'telegram',
            });
        } catch { /* non-critical */ }

        await ctx.reply(reply, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error(`Document processing error (${filename}):`, err.message);
        await ctx.reply(`❌ Failed to process *${filename}*: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ──────────────────────────────────────────────────
// TEXT MESSAGE HANDLER
// ──────────────────────────────────────────────────

const chatHistory: Record<string, any[]> = {};

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.from?.id || ctx.chat.id;

    // Initialize history for this chat if it doesn't exist
    if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
    }

    // Add user's message to history
    chatHistory[chatId].push({ role: "user", content: userText });

    // Keep history reasonably sized (last 10 messages)
    if (chatHistory[chatId].length > 10) {
        chatHistory[chatId] = chatHistory[chatId].slice(-10);
    }

    ctx.sendChatAction('typing');

    try {
        // ── Retrieve relevant memories for context ──
        let memoryContext = '';
        try {
            const { getRelevantContext } = await import('../lib/intelligence/memory');
            memoryContext = await getRelevantContext(userText);
        } catch { /* memory unavailable, continue without */ }

        let reply = "";

        if (openai) {
            const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get real-time weather information for a specific location.",
                        parameters: {
                            type: "object",
                            properties: {
                                location: { type: "string", description: "City and State, e.g. Montrose, CO" }
                            },
                            required: ["location"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "list_recent_emails",
                        description: "List the 5 most recent emails from the inbox.",
                        parameters: { type: "object", properties: {} }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "perplexity_search",
                        description: "Search the internet for real-time information.",
                        parameters: {
                            type: "object",
                            properties: { query: { type: "string" } },
                            required: ["query"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "lookup_product",
                        description: "Look up a SPECIFIC product in Finale Inventory by EXACT SKU. Returns stock, lead time, supplier, cost, and reorder info. Only use this when you know the exact SKU.",
                        parameters: {
                            type: "object",
                            properties: {
                                sku: { type: "string", description: "The exact product SKU/ID in Finale (e.g. S-12527, BC101, PU102)" }
                            },
                            required: ["sku"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "search_products",
                        description: "Search Finale Inventory for products by keyword in name or description. Use this when Will asks to find, list, or search for products by name, ingredient, vendor, or description — e.g. 'kashi skus', 'kelp products', 'find castings items'. Returns matching SKUs with stock levels.",
                        parameters: {
                            type: "object",
                            properties: {
                                keyword: { type: "string", description: "Search keyword to match against product names and SKUs (e.g. 'kashi', 'kelp', 'castings', 'bag')" },
                                limit: { type: "number", description: "Max results to return (default 20)" }
                            },
                            required: ["keyword"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "get_consumption",
                        description: "Get BOM consumption and stock info for a specific SKU over a number of days. Use this when the user asks for consumption of a SKU, e.g., 'consumption for KM106' or '/consumption KM106'.",
                        parameters: {
                            type: "object",
                            properties: {
                                sku: { type: "string", description: "The exact product SKU/ID (e.g. KM106, S-12527)" },
                                days: { type: "number", description: "Number of days to analyze (default 90)" }
                            },
                            required: ["sku"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "build_risk_analysis",
                        description: "Run advanced 30-day build risk analysis to predict stockouts for upcoming production. Explodes BOMs against the manufacturing calendar and current stock. Use when the user asks for 'build risk', 'what are we short on', 'stockouts', or '/buildrisk'.",
                        parameters: { type: "object", properties: {} }
                    }
                }
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system", content: SYSTEM_PROMPT + memoryContext + `

## CRITICAL: BIAS TO ACTION
You MUST use your tools to answer questions. NEVER ask clarifying questions when a tool can attempt the task.

### Tool selection rules:
- "search the web" / "find" / "look up online" → use perplexity_search immediately with your best interpretation of what they want
- "give me X skus" / "list X products" / "find items with X" / "search for X" → use search_products with the keyword
- Product lookup by exact SKU (e.g. "S-12527") → use lookup_product
- Weather → use get_weather
- Emails → use list_recent_emails

### Anti-clarification rules:
- If Will's request contains a keyword and mentions products/skus/items/inventory → call search_products with that keyword. Do NOT ask "which products?" or "could you clarify?"
- If Will's request mentions searching the web → call perplexity_search with your best guess query. Do NOT ask "what are you looking for?"
- If there are typos, interpret the intent and proceed. "lisst skus" = "list skus". "kashi" is a keyword to search.
- If in doubt, ATTEMPT the action. It's better to return wrong results than to ask a question.` },
                    ...chatHistory[chatId]
                ],
                tools,
                tool_choice: "auto",
            });

            const message = response.choices[0].message;

            if (message.tool_calls) {
                const toolResults: any[] = [];
                for (const toolCall of message.tool_calls) {
                    const args = JSON.parse(toolCall.function.arguments);
                    let result = "";

                    if (toolCall.function.name === "get_weather") {
                        const Firecrawl = require('@mendable/firecrawl-js').default;
                        const app = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
                        const scrape = await app.scrapeUrl(`https://duckduckgo.com/?q=weather+in+${encodeURIComponent(args.location)}`, { formats: ['markdown'] });
                        result = scrape.success ? scrape.markdown : "Could not retrieve weather.";
                    } else if (toolCall.function.name === "perplexity_search" && perplexity) {
                        const res = await perplexity.chat.completions.create({
                            model: "sonar-reasoning",
                            messages: [{ role: "user", content: args.query }]
                        });
                        result = res.choices[0].message.content || "";
                    } else if (toolCall.function.name === "list_recent_emails") {
                        const auth = await getAuthenticatedClient("default");
                        const gmail = google.gmail({ version: "v1", auth });
                        const { data } = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
                        result = JSON.stringify(data.messages);
                    } else if (toolCall.function.name === "lookup_product") {
                        const report = await finale.getBOMConsumption(args.sku);
                        result = report.productId
                            ? report.telegramMessage
                            : `Product ${args.sku} not found in Finale.`;
                    } else if (toolCall.function.name === "search_products") {
                        const searchResult = await finale.searchProducts(args.keyword, args.limit || 20);
                        result = searchResult.telegramMessage;
                    } else if (toolCall.function.name === "get_consumption") {
                        const report = await finale.getBOMConsumption(args.sku, args.days || 90);
                        result = report.telegramMessage;
                    } else if (toolCall.function.name === "build_risk_analysis") {
                        const { runBuildRiskAnalysis } = await import('../lib/builds/build-risk');
                        const report = await runBuildRiskAnalysis(30, () => { });
                        result = report.slackMessage;
                    }

                    toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });
                }

                const finalRes = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        ...chatHistory[chatId],
                        message,
                        ...toolResults
                    ]
                });
                reply = finalRes.choices[0].message.content || "";

                // Save AI reply to history
                chatHistory[chatId].push(message);
                chatHistory[chatId].push(...toolResults);
                chatHistory[chatId].push({ role: "assistant", content: reply });
            } else {
                reply = message.content || "";

                // Save AI reply to history
                chatHistory[chatId].push({ role: "assistant", content: reply });
            }
        } else {
            // No OpenAI, just use Unified (which will try Anthropic)
            reply = await unifiedTextGeneration({
                system: SYSTEM_PROMPT + memoryContext,
                prompt: userText
            });
        }

        ctx.reply(reply, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error('Chat Error:', err.message);
        ctx.reply(`⚠️ Ops: ${err.message}`);
    }
});

// Boot — clear any competing session first, then start long-polling
(async () => {
    try {
        // Force-clear any existing long-poll session
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🔄 Cleared previous Telegram session');
    } catch (err: any) {
        console.log('⚠️ Webhook clear failed (non-fatal):', err.message);
    }

    // DECISION(2026-02-25): bot.launch() returns a promise that resolves on
    // SHUTDOWN, not on boot. OpsManager must start immediately — not in .then().
    // Fire-and-forget the launch, then start OpsManager right away.
    bot.launch({ dropPendingUpdates: true })
        .catch((err: any) => console.error('❌ Bot launch error:', err.message));

    console.log('✅ ARIA IS LIVE AND LISTENING');

    const ops = new OpsManager(bot);
    ops.start();

    console.log('📅 Cron schedules registered:');
    console.log('   🏭 Build Risk Report: 7:30 AM MT (Mon-Fri)');
    console.log('   📊 Daily PO Summary:  8:00 AM MT (Daily)');
    console.log('   🗓️  Weekly Review:     8:01 AM MT (Fridays)');
    console.log('   📦 PO Sync:           Every 30 min');
    console.log('   🧹 Ad Cleanup:        Every hour');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
