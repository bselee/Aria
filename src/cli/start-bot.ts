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
// DOCUMENT/FILE HANDLER — PDFs, images, Word docs
// ──────────────────────────────────────────────────

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name || 'unknown';
    const mimeType = doc.mime_type || '';
    const caption = ctx.message.caption || '';

    // Only process supported file types
    const SUPPORTED = ['application/pdf', 'application/x-pdf', 'image/png', 'image/jpeg',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

    if (!SUPPORTED.some(m => mimeType.includes(m.split('/')[1]))) {
        await ctx.reply(`📎 Got *${filename}* but I can't process \`${mimeType}\` files yet.\n_I handle: PDF, PNG, JPEG, DOC/DOCX_`, { parse_mode: 'Markdown' });
        return;
    }

    // Size check (Telegram max is 20MB for bots)
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
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Import PDF tools
        const { extractPDF } = await import('../lib/pdf/extractor');
        const { classifyDocument } = await import('../lib/pdf/classifier');

        // Extract text
        ctx.sendChatAction('typing');
        const extraction = await extractPDF(buffer);

        // Classify document type
        const classification = await classifyDocument(extraction);

        // Build response
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

        // Extract key info using LLM
        if (extraction.rawText.length > 50) {
            ctx.sendChatAction('typing');
            const summary = await unifiedTextGeneration({
                system: `You are Aria, summarizing a business document for Will at BuildASoil.
Be concise. Focus on: vendor name, amounts, dates, key items/SKUs, and any action needed.`,
                prompt: `Document type: ${typeLabel}
Caption from user: ${caption || '(none)'}

Document text (first 3000 chars):
${extraction.rawText.slice(0, 3000)}`
            });

            reply += `\n━━━━━━━━━━━━━━━━━━━━\n${summary}`;
        } else {
            reply += `\n⚠️ _Very little text extracted. This might be a scanned/image PDF._`;
        }

        await ctx.reply(reply, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error(`Document processing error (${filename}):`, err.message);
        await ctx.reply(`❌ Failed to process *${filename}*: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ──────────────────────────────────────────────────
// TEXT MESSAGE HANDLER
// ──────────────────────────────────────────────────

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    ctx.sendChatAction('typing');

    try {
        // We use unifiedTextGeneration for the initial reply,
        // BUT for tool use we currently rely on the OpenAI path in gpt-4o 
        // because Claude SDK tool usage is slightly different than OpenAI's.
        // For now, I will improve the OpenAI tool choice and add the weather tool.

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
                        description: "Look up a product in Finale Inventory by SKU. Returns stock status, lead time, supplier, cost, and reorder info. Use this when Will asks about a product, item, SKU, or inventory.",
                        parameters: {
                            type: "object",
                            properties: {
                                sku: { type: "string", description: "The product SKU/ID in Finale (e.g. S-12527, BC101, PU102)" }
                            },
                            required: ["sku"]
                        }
                    }
                }
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT + "\n\nYou have access to tools. Use 'get_weather' for weather requests. Use 'lookup_product' when Will asks about a product, inventory item, or SKU. The sku parameter should be the Finale product ID (e.g. S-12527, BC101)." },
                    { role: "user", content: userText }
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
                        const report = await finale.productReport(args.sku);
                        result = report.found
                            ? JSON.stringify(report.product)
                            : `Product ${args.sku} not found in Finale.`;
                    }

                    toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });
                }

                const finalRes = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: userText },
                        message,
                        ...toolResults
                    ]
                });
                reply = finalRes.choices[0].message.content || "";
            } else {
                reply = message.content || "";
            }
        } else {
            // No OpenAI, just use Unified (which will try Anthropic)
            reply = await unifiedTextGeneration({
                system: SYSTEM_PROMPT,
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

    bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log('✅ ARIA IS LIVE AND LISTENING');
        const ops = new OpsManager(bot);
        ops.start();
    });
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
