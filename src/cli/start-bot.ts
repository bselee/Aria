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
import { SlackWatchdog } from '../lib/slack/watchdog';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
} from '../lib/finale/reconciler';

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

// DECISION(2026-02-26): Run the Slack watchdog inside the bot process so
// /requests can read live pending requests. Eliminates need for IPC/shared DB.
let globalWatchdog: SlackWatchdog | null = null;

// ──────────────────────────────────────────────────
// COMMANDS
// ──────────────────────────────────────────────────

bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

const BOT_START_TIME = new Date();

bot.command('status', async (ctx) => {
    const chatId = ctx.from?.id || ctx.chat.id;
    const uptimeMs = Date.now() - BOT_START_TIME.getTime();
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const uptimeHrs = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeHrs > 0
        ? `${uptimeHrs}h ${uptimeMin % 60}m`
        : `${uptimeMin}m`;

    const historyLen = chatHistory[chatId]?.length || 0;

    // Check Supabase connectivity
    let dbStatus = '❓ Not checked';
    try {
        const { createClient } = await import('../lib/supabase');
        const db = createClient();
        if (!db) {
            dbStatus = '❌ Not configured';
        } else {
            const { error } = await db.from('vendors').select('id').limit(1);
            dbStatus = error ? `❌ ${error.message}` : '✅ Connected';
        }
    } catch (e: any) {
        dbStatus = `❌ ${e.message}`;
    }

    // Check memory/Pinecone
    let memStatus = '❓ Not checked';
    try {
        const { recall } = await import('../lib/intelligence/memory');
        const mems = await recall('vendor', { topK: 1 });
        memStatus = mems.length > 0 ? `✅ ${mems.length} result(s) (seeded)` : '⚠️ No memories (run /seed)';
    } catch (e: any) {
        memStatus = `❌ ${e.message}`;
    }

    const recentHistory = (chatHistory[chatId] || [])
        .slice(-4)
        .map((m: any) => `  ${m.role === 'user' ? '👤' : '🤖'} ${String(m.content).slice(0, 60).replace(/\n/g, ' ')}...`)
        .join('\n') || '  (empty)';

    ctx.reply(
        `🛰️ *Aria Runtime Status*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱️ Uptime: \`${uptimeStr}\`\n` +
        `🚀 Started: \`${BOT_START_TIME.toLocaleTimeString('en-US', { timeZone: 'America/Denver' })} MT\`\n\n` +
        `*Integrations:*\n` +
        `🤖 OpenAI: ${openai ? '✅ GPT-4o' : '❌ Not configured'}\n` +
        `🗄️ Supabase: ${dbStatus}\n` +
        `🧠 Memory (Pinecone): ${memStatus}\n` +
        `📦 Finale: ${process.env.FINALE_API_KEY ? '✅ Connected' : '❌ Not configured'}\n` +
        `🔍 Perplexity: ${perplexityKey ? '✅ Ready' : '❌ Not configured'}\n` +
        `🦊 Slack Watchdog: ${globalWatchdog ? '✅ Running' : '❌ Not started'}\n` +
        `🎙️ Voice: ${elevenLabsKey ? '✅ ElevenLabs' : '❌ Not configured'}\n\n` +
        `*Conversation:*\n` +
        `💬 History: \`${historyLen} messages\` in context\n` +
        `${recentHistory}\n\n` +
        `_/clear to reset conversation context_`,
        { parse_mode: 'Markdown' }
    );
});

// /clear — reset conversation history for this chat
bot.command('clear', (ctx) => {
    const chatId = ctx.from?.id || ctx.chat.id;
    const count = chatHistory[chatId]?.length || 0;
    chatHistory[chatId] = [];
    ctx.reply(`🗑️ Cleared ${count} messages from context. Fresh start.`, { parse_mode: 'Markdown' });
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
        // Try to pull recent requests from the shared watchdog instance
        const pending = globalWatchdog?.getRecentRequests() || [];

        if (pending.length === 0) {
            await ctx.reply(
                `🦊 *Slack Request Tracker*\n\n` +
                `✅ No pending product requests right now.\n\n` +
                `Monitoring: *#purchasing*, *#purchase-orders*, DMs\n` +
                `Thread replies: ✅ Included\n` +
                `_New requests appear as 🦊 Aria Slack Digest messages._`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        let reply = `🦊 *Slack Request Tracker* — ${pending.length} pending\n\n`;
        for (const req of pending) {
            const urgencyEmoji = req.analysis.urgency === 'high' ? '🔴' :
                req.analysis.urgency === 'medium' ? '🟡' : '🟢';
            reply += `${urgencyEmoji} *${req.userName}* in #${req.channel}\n`;
            reply += `  📦 ${req.analysis.itemDescription}`;
            if (req.analysis.quantity) reply += ` (×${req.analysis.quantity})`;
            reply += `\n`;
            if (req.matchedProduct) {
                reply += `  ✅ SKU: \`${req.matchedProduct.sku}\`\n`;
            }
            if (req.activePO) {
                reply += `  📋 PO: #${req.activePO} — ${req.eta}\n`;
            }
            reply += `\n`;
        }
        reply += `_Channels: #purchasing, #purchase-orders, DMs + thread replies_`;
        await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
    }
});

// /correlate — Cross-inbox PO ↔ Invoice correlation and vendor intelligence
bot.command('correlate', async (ctx) => {
    ctx.sendChatAction('typing');
    await ctx.reply('🔗 Running cross-inbox PO correlation...\n_Scanning bill.selee label:PO → matching with AP invoices_', { parse_mode: 'Markdown' });

    try {
        const { runCorrelationPipeline } = await import('../lib/intelligence/po-correlator');
        const result = await runCorrelationPipeline();

        // Split long messages if needed (Telegram 4096 char limit)
        const report = result.formattedReport;
        if (report.length > 4000) {
            const lines = report.split('\n');
            let chunk = '';
            for (const line of lines) {
                if (chunk.length + line.length > 3900) {
                    await ctx.reply(chunk, { parse_mode: 'Markdown' });
                    chunk = '';
                }
                chunk += line + '\n';
            }
            if (chunk.trim()) await ctx.reply(chunk, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply(report, { parse_mode: 'Markdown' });
        }
    } catch (err: any) {
        console.error('Correlation error:', err.message);
        await ctx.reply(`❌ Correlation failed: ${err.message}`, { parse_mode: 'Markdown' });
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
// CONVERSATION HISTORY (shared across text + document handlers)
// ──────────────────────────────────────────────────

const chatHistory: Record<string, any[]> = {};

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

        // ── Excel (XLS/XLSX): convert to CSV text, then analyze with LLM ──
        const isExcelFile = mimeType.includes('spreadsheet') || mimeType.includes('ms-excel')
            || filename.endsWith('.xlsx') || filename.endsWith('.xls');

        if (isTextFile || isExcelFile) {
            let textContent: string;
            let fileLabel: string;

            if (isExcelFile) {
                // DECISION(2026-02-26): Use xlsx library to convert Excel → CSV text.
                // This avoids the PDF extraction pipeline which fails on non-PDF binaries.
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

            // DECISION(2026-02-26): Auto-enrich with Finale data when Excel contains SKUs.
            // Extract product IDs from the data, query Finale for consumption/demand/BOM data,
            // and append to the LLM prompt so Aria can give real answers instead of guessing.
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

                                    // DECISION(2026-02-26): Finale's demandQuantity and consumptionQuantity
                                    // are TOTALS over ~90 days, NOT daily rates. We must pre-calculate
                                    // daily rate here to prevent the LLM from misinterpreting them.
                                    const totalDemand = profile.demandQuantity ?? profile.consumptionQuantity ?? 0;
                                    if (totalDemand > 0) {
                                        const dailyRate = totalDemand / 90;
                                        entry += ` Consumption: ${totalDemand.toFixed(1)} units over 90 days (${dailyRate.toFixed(2)} units/day).`;
                                        if (profile.onHand !== null && dailyRate > 0) {
                                            const daysOfSupply = Math.round(profile.onHand / dailyRate);
                                            entry += ` Days of supply: ~${daysOfSupply} days.`;
                                            // Annualize for "last year" type questions
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
                                    // DECISION(2026-02-26): Also fetch actual purchase/receiving history
                                    // so the LLM can give exact "total purchased last year" answers
                                    // instead of extrapolating from consumption.
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
            reply += `📎 File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
            reply += `📝 Lines: ${lineCount}\n`;
            if (finaleContext) reply += `🔗 _Enriched with live Finale inventory data_\n`;
            reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;

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
                prompt: `User's request: ${caption || 'Analyze this file'}\n\nFile: ${filename}\nData (${textContent.length} chars total):\n${textContent.slice(0, 30000)}${finaleContext}`
            });

            reply += analysis;
            await ctx.reply(reply, { parse_mode: 'Markdown' });

            // Store in conversation history so follow-up questions have context
            const chatId = ctx.from?.id || ctx.chat.id;
            if (!chatHistory[chatId]) chatHistory[chatId] = [];
            chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' — ' + caption : ''}` });
            chatHistory[chatId].push({ role: "assistant", content: reply });
            if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

            // Auto-learn: store key conclusions from the file analysis
            setImmediate(async () => {
                try {
                    const { remember } = await import('../lib/intelligence/memory');
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

        // Store in conversation history so follow-up questions have context
        const chatId = ctx.from?.id || ctx.chat.id;
        if (!chatHistory[chatId]) chatHistory[chatId] = [];
        chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' — ' + caption : ''}` });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

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
    const chatId = ctx.from?.id || ctx.chat.id;

    // Initialize history for this chat if it doesn't exist
    if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
    }

    // Add user's message to history
    chatHistory[chatId].push({ role: "user", content: userText });

    // Keep last 20 messages (shared with document handler limit)
    if (chatHistory[chatId].length > 20) {
        chatHistory[chatId] = chatHistory[chatId].slice(-20);
    }

    ctx.sendChatAction('typing');

    try {
        // ── Retrieve relevant memories for context ──
        let memoryContext = '';
        try {
            const { getRelevantContext } = await import('../lib/intelligence/memory');
            memoryContext = await getRelevantContext(userText);
        } catch { /* memory unavailable, continue without */ }

        // Runtime rules shared across ALL LLM paths (GPT-4o, Claude, OpenAI fallback)
        const runtimeRules = `

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
- If in doubt, ATTEMPT the action. It's better to return wrong results than to ask a question.

### Follow-up conversation rules:
- When the previous message analyzed a file or returned data, ALL follow-up questions refer to THAT context.
- "product amount not money or cost" after a PO analysis = asking about unit quantities, not dollar amounts. Answer from the prior data.
- "this sku" / "this one" / "that product" = the SKU most recently discussed or visible in the prior message. Use it.
- "how many" / "what quantity" / "units" after a file analysis = re-interpret the prior analysis for quantity metrics.
- NEVER say "It sounds like you're looking for..." — just answer directly from context.
- NEVER say "Just provide the product name or SKU" if one was already discussed in this conversation.
- NEVER say "let me handle it" or "I'll dive right in" without actually doing something.
- If the user's message is short and ambiguous, look at the prior assistant message — it almost certainly provides the missing context.

### LIVE DATA RULE — always validate with tools:
Memory context (above) is BACKGROUND ONLY — it tells you patterns, processes, and history, NOT current values.
For ANYTHING that can change, you MUST call the appropriate tool to get live data. Do NOT answer from memory alone.
- Prices / costs / unit cost → call lookup_product or get_purchase_history
- Stock levels / on-hand / on-order → call lookup_product
- PO status / open POs / what's in transit → call query_purchase_orders
- Consumption rates / demand → call get_consumption
- Vendor payment terms / contacts → call query_vendors
- Invoice status → call query_invoices
Rule: if the answer could be stale (anything numeric, status-based, or date-based), CALL THE TOOL. Always.

### When a tool returns no result:
- If lookup_product returns nothing: say "Not found in Finale — tried SKU [X]." Stop there.
- If search returns no match: say "No match in Finale for [X]." Stop there.
- NEVER suggest Will go check something himself. You are the one who checks.

### HOLLOW FILLER — never use these (they add zero value):
- "What's next on the agenda?" / "What's our next task?" / "What's next?" — only reference next steps if you have a SPECIFIC, concrete one to name
- "Let me know if you need anything else" — empty, skip it
- "Hope that helps!" — never
- "It might be worth double-checking" — you checked. Report what you found, that's it.
- "If you need this converted... let me know" — CONVERT IT NOW. Don't offer, do.
- Any generic offer that could apply to ANY response (if it has no specifics, cut it)

### Persona — always ON:
- Aria is warm, sharp, and witty. Dry humor is welcome when it fits.
- End responses with genuine engagement when there's something real to engage with — a specific observation, a risk you noticed, a quick recommendation.
- If a tool result reveals something interesting or concerning, comment on it briefly. That's not filler, that's signal.
- Will likes directness. Get to the answer first, then add color.`;

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
                },
                {
                    type: "function",
                    function: {
                        name: "get_purchase_history",
                        description: "Get the total quantity purchased/received for a specific SKU over a time period. Use this when the user asks 'how much was purchased', 'total received', 'purchase history', or 'how much did we buy' for a product. Returns exact PO quantities from Finale.",
                        parameters: {
                            type: "object",
                            properties: {
                                sku: { type: "string", description: "The exact product SKU/ID (e.g. PLQ101, KM106)" },
                                days: { type: "number", description: "Number of days back to search (default 365)" }
                            },
                            required: ["sku"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "query_vendors",
                        description: "Look up vendor info from our database by name. Returns payment terms, contact, AR email, total spend, last order date. Use when Will asks about a specific vendor, payment terms, who to contact, or vendor history.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string", description: "Partial or full vendor name to search (e.g. 'AAA Cooper', 'Kashi', 'BioAg')" }
                            },
                            required: ["name"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "query_invoices",
                        description: "Query invoices from our database. Use when Will asks about invoice status, unmatched invoices, overdue invoices, or invoice amounts. Filter by status: 'pending', 'matched', 'unmatched', 'paid', 'overdue'.",
                        parameters: {
                            type: "object",
                            properties: {
                                vendor_name: { type: "string", description: "Filter by vendor name (partial match)" },
                                status: { type: "string", description: "Filter by status: pending, matched, unmatched, paid, overdue" },
                                limit: { type: "number", description: "Max results (default 10)" }
                            }
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "query_purchase_orders",
                        description: "Query purchase orders from our database. Use when Will asks about open POs, PO status, what's on order, or expected deliveries. Filter by status: 'open', 'received', 'closed', 'partial'.",
                        parameters: {
                            type: "object",
                            properties: {
                                vendor_name: { type: "string", description: "Filter by vendor name (partial match)" },
                                status: { type: "string", description: "Filter by status: open, received, closed, partial" },
                                limit: { type: "number", description: "Max results (default 10)" }
                            }
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "query_action_items",
                        description: "Get documents that require action — unprocessed uploads, pending approvals, documents flagged for follow-up. Use when Will asks 'what needs attention', 'pending items', 'action required', or 'what did you flag'.",
                        parameters: {
                            type: "object",
                            properties: {
                                limit: { type: "number", description: "Max results (default 10)" }
                            }
                        }
                    }
                }
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system", content: SYSTEM_PROMPT + memoryContext + runtimeRules
                    },
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
                        const report = await finale.productReport(args.sku);
                        result = report.telegramMessage;
                    } else if (toolCall.function.name === "get_purchase_history") {
                        const purchased = await finale.getPurchasedQty(args.sku, args.days || 365);
                        if (purchased.totalQty > 0) {
                            result = `${args.sku}: Purchased ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s) in the last ${args.days || 365} days.`;
                        } else {
                            result = `${args.sku}: No purchase/receiving records found in the last ${args.days || 365} days.`;
                        }
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
                    } else if (toolCall.function.name === "query_vendors") {
                        const { createClient } = await import('../lib/supabase');
                        const db = createClient();
                        if (!db) {
                            result = "Supabase not configured.";
                        } else {
                            const { data, error } = await db.from('vendors')
                                .select('name, aliases, payment_terms, contact_name, contact_email, ar_email, category, total_spend, last_order_date, average_payment_days')
                                .ilike('name', `%${args.name}%`)
                                .limit(5);
                            if (error) result = `DB error: ${error.message}`;
                            else if (!data?.length) result = `No vendors found matching "${args.name}".`;
                            else result = JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === "query_invoices") {
                        const { createClient } = await import('../lib/supabase');
                        const db = createClient();
                        if (!db) {
                            result = "Supabase not configured.";
                        } else {
                            let q = db.from('invoices')
                                .select('invoice_number, po_number, total_amount, due_date, status, discrepancies, created_at, vendors(name)')
                                .order('created_at', { ascending: false })
                                .limit(args.limit || 10);
                            if (args.status) q = q.eq('status', args.status);
                            if (args.vendor_name) {
                                // Join-filter via vendor name requires a subquery; approximate with vendor id lookup
                                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${args.vendor_name}%`).limit(1);
                                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                            }
                            const { data, error } = await q;
                            if (error) result = `DB error: ${error.message}`;
                            else if (!data?.length) result = `No invoices found${args.status ? ` with status "${args.status}"` : ''}.`;
                            else result = JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === "query_purchase_orders") {
                        const { createClient } = await import('../lib/supabase');
                        const db = createClient();
                        if (!db) {
                            result = "Supabase not configured.";
                        } else {
                            let q = db.from('purchase_orders')
                                .select('po_number, issue_date, required_date, status, total_amount, line_items, vendors(name)')
                                .order('issue_date', { ascending: false })
                                .limit(args.limit || 10);
                            if (args.status) q = q.eq('status', args.status);
                            if (args.vendor_name) {
                                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${args.vendor_name}%`).limit(1);
                                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                            }
                            const { data, error } = await q;
                            if (error) result = `DB error: ${error.message}`;
                            else if (!data?.length) result = `No purchase orders found${args.status ? ` with status "${args.status}"` : ''}.`;
                            else result = JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === "query_action_items") {
                        const { createClient } = await import('../lib/supabase');
                        const db = createClient();
                        if (!db) {
                            result = "Supabase not configured.";
                        } else {
                            const { data, error } = await db.from('documents')
                                .select('type, vendor_ref, action_summary, confidence, source, created_at')
                                .eq('action_required', true)
                                .order('created_at', { ascending: false })
                                .limit(args.limit || 10);
                            if (error) result = `DB error: ${error.message}`;
                            else if (!data?.length) result = "No pending action items found.";
                            else result = JSON.stringify(data, null, 2);
                        }
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

                // Auto-learn: store the Q→A pattern so future identical/similar questions
                // get instant answers from memory context instead of re-calling tools.
                setImmediate(async () => {
                    try {
                        const { remember } = await import('../lib/intelligence/memory');
                        const toolsUsed = message.tool_calls!.map(tc => tc.function.name).join(', ');
                        const resultSummary = toolResults
                            .map(tr => String(tr.content).slice(0, 300))
                            .join(' | ');
                        // Determine memory category from tool type
                        const firstTool = message.tool_calls![0].function.name;
                        const category =
                            firstTool.includes('vendor') ? 'vendor_pattern' :
                                firstTool.includes('product') || firstTool.includes('sku') || firstTool.includes('consumption') || firstTool.includes('purchase') ? 'product_note' :
                                    firstTool.includes('invoice') || firstTool.includes('purchase_order') ? 'process' :
                                        'conversation';
                        // Extract any SKU-like tags from the user message + results
                        const tagMatches = (userText + ' ' + resultSummary).match(/\b([A-Z][A-Z0-9-]{2,15})\b/g) || [];
                        const tags = [...new Set(tagMatches)].slice(0, 5);
                        await remember({
                            category,
                            content: `Q: "${userText.slice(0, 150)}" → Tool: ${toolsUsed} → A: "${reply.slice(0, 300)}"`,
                            tags,
                            source: 'telegram_auto',
                            priority: 'low',
                        });
                    } catch { /* non-critical, never block the response */ }
                });
            } else {
                reply = message.content || "";

                // Save AI reply to history
                chatHistory[chatId].push({ role: "assistant", content: reply });
            }
        } else {
            // No OpenAI — use Unified with full conversation history
            reply = await unifiedTextGeneration({
                system: SYSTEM_PROMPT + memoryContext + runtimeRules,
                messages: chatHistory[chatId]
                    .filter((m: any) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                    .map((m: any) => ({ role: m.role, content: m.content })) as any,
            });
            chatHistory[chatId].push({ role: 'assistant', content: reply });
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

    // ──────────────────────────────────────────────────
    // RECONCILIATION APPROVAL INLINE BUTTONS
    // ──────────────────────────────────────────────────
    // DECISION(2026-02-26): Using Telegram bot (not Slack) for approvals per Will.
    // When AP Agent detects a price change >3%, it sends inline keyboard buttons.
    // These handlers capture the button taps and apply/reject changes.

    bot.action(/^approve_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`🔑 Approval button tapped: ${approvalId}`);

        await ctx.answerCbQuery('Processing approval...');

        try {
            const result = await approvePendingReconciliation(approvalId);
            const responseMsg = result.success
                ? `${result.message}\n\nApplied:\n${result.applied.map(a => `  ✅ ${a}`).join('\n')}${result.errors.length > 0 ? `\n\nErrors:\n${result.errors.map(e => `  ❌ ${e}`).join('\n')}` : ''}`
                : `⚠️ ${result.message}`;

            await ctx.editMessageText(ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text + '\n\n' + responseMsg
                : responseMsg);
        } catch (err: any) {
            await ctx.reply(`❌ Approval failed: ${err.message}`);
        }
    });

    bot.action(/^reject_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`🔒 Rejection button tapped: ${approvalId}`);

        await ctx.answerCbQuery('Changes rejected');

        const message = await rejectPendingReconciliation(approvalId);

        await ctx.editMessageText(ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text + '\n\n' + message
            : message);
    });

    // Fire-and-forget the launch, then start OpsManager right away.
    bot.launch({ dropPendingUpdates: true })
        .catch((err: any) => console.error('❌ Bot launch error:', err.message));

    console.log('✅ ARIA IS LIVE AND LISTENING');

    // Seed memory with vendor patterns and known processes on every boot
    // (seedMemories uses upsert so this is idempotent)
    try {
        const { seedMemories } = await import('../lib/intelligence/memory');
        const { seedKnownVendorPatterns } = await import('../lib/intelligence/vendor-memory');
        await Promise.all([seedMemories(), seedKnownVendorPatterns()]);
        console.log('🧠 Memory: ✅ Vendor patterns seeded');
    } catch (err: any) {
        console.warn('⚠️ Memory seed failed (non-fatal):', err.message);
    }

    const ops = new OpsManager(bot);
    ops.start();

    // Start Slack Watchdog in-process (so /requests can access pending data)
    if (process.env.SLACK_ACCESS_TOKEN) {
        try {
            const pollInterval = parseInt(process.env.SLACK_POLL_INTERVAL || '60', 10);
            globalWatchdog = new SlackWatchdog(pollInterval);
            await globalWatchdog.start();
            console.log('🦊 Slack Watchdog: ✅ Running in-process');
        } catch (err: any) {
            console.warn('⚠️ Slack Watchdog failed to start:', err.message);
        }
    } else {
        console.log('🦊 Slack Watchdog: ❌ SLACK_ACCESS_TOKEN not set');
    }

    console.log('📅 Cron schedules registered:');
    console.log('   🏭 Build Risk Report: 7:30 AM MT (Mon-Fri)');
    console.log('   📊 Daily PO Summary:  8:00 AM MT (Daily)');
    console.log('   🗓️  Weekly Review:     8:01 AM MT (Fridays)');
    console.log('   📦 PO Sync:           Every 30 min');
    console.log('   🧹 Ad Cleanup:        Every hour');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
