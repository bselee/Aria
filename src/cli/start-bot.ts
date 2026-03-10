/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Gemini (primary chat), and Vercel AI SDK tool calling.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-06
 *
 * DECISION(2026-03-06): Replaced OpenRouter (paid) with Gemini (free) for chat.
 * Tools now use Vercel AI SDK tool() format with co-located execute() functions.
 * OpenRouter can be re-enabled by setting OPENROUTER_API_KEY in llm.ts chain.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as http from 'http';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import OpenAI from 'openai';
import { google as googleAI } from '@ai-sdk/google';
import { generateText, stepCountIs } from 'ai';
import { getAriaTools } from './aria-tools';
import {
    SYSTEM_PROMPT,
    VOICE_CONFIG,
    TELEGRAM_CONFIG
} from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import { getProviderStatus } from '../lib/intelligence/llm';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import { unifiedTextGeneration } from '../lib/intelligence/llm';
// DECISION(2026-03-06): unifiedTextGeneration kept as fallback if Gemini fails on chat.
// Primary chat now uses generateText with google('gemini-2.0-flash') directly.
import { FinaleClient } from '../lib/finale/client';
import { SlackWatchdog } from '../lib/slack/watchdog';
import { APAgent } from '../lib/intelligence/ap-agent';
import { initAriaReviewWatcher } from '../lib/intelligence/aria-review-watcher';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
    reconcileInvoiceToPO,
    applyReconciliation,
    storePendingApproval,
    loadPendingApprovalsFromSupabase,
    type ReconciliationResult,
} from '../lib/finale/reconciler';

// Tracks chats where we're waiting for Will to type a Finale PO# for a manual match.
// chatId → dropship store ID. Cleared after use (or on next text message).
const pendingPoEntry = new Map<number, string>();
import {
    getPendingDropship,
    removePendingDropship,
    getAllPendingDropships,
} from '../lib/intelligence/dropship-store';
import {
    storePendingPOSend,
    getPendingPOSend,
    expirePendingPOSend,
    lookupVendorOrderEmail,
    commitAndSendPO,
} from '../lib/purchasing/po-sender';

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────

/**
 * Build the Telegram message text for a restored (post-restart) approval prompt.
 * Mirrors the structure of the original approval message sent by ap-agent.ts, with
 * an added banner noting the bot restarted and how many minutes remain on the 24h window.
 */
function buildRestoredApprovalMessage(result: ReconciliationResult, approvalId: string, minutesLeft: number): string {
    const vendor = result.vendorName || 'Unknown vendor';
    const invNum = result.invoiceNumber || '?';
    const poNum = result.orderId || '?';

    const changes: string[] = [];
    for (const pc of result.priceChanges ?? []) {
        if (pc.verdict === 'needs_approval') {
            const delta = (pc.poPrice != null && pc.invoicePrice != null)
                ? ` ($${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)})`
                : '';
            changes.push(`• ${pc.description || pc.productId || '?'}${delta}`);
        }
    }
    for (const fc of result.feeChanges ?? []) {
        if (fc.verdict === 'needs_approval') {
            changes.push(`• ${fc.feeType}: $${(fc.amount ?? 0).toFixed(2)}`);
        }
    }

    const changeList = changes.length > 0
        ? changes.slice(0, 5).join('\n') + (changes.length > 5 ? `\n…+${changes.length - 5} more` : '')
        : '(no itemized changes)';

    const impact = result.totalDollarImpact != null ? `$${result.totalDollarImpact.toFixed(2)}` : '?';

    return (
        `🔄 *RESTORED APPROVAL* _(bot restarted — ${minutesLeft}m remaining)_\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Vendor:* ${vendor}\n` +
        `*Invoice:* ${invNum}  →  *PO:* ${poNum}\n` +
        `*Impact:* ${impact}\n\n` +
        `*Changes pending approval:*\n${changeList}\n\n` +
        `_Tap Approve or Reject below_`
    );
}

// ──────────────────────────────────────────────────
// CLIENT INITIALIZATION
// ──────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const perplexityKey = process.env.PERPLEXITY_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);

// Perplexity for web search tool (uses OpenAI-compatible API)
const perplexity = perplexityKey ? new OpenAI({
    apiKey: perplexityKey,
    baseURL: 'https://api.perplexity.ai'
}) : null;

// Finale Inventory client
const finale = new FinaleClient();

// DECISION(2026-03-06): Chat uses Gemini 2.0 Flash (free) via Vercel AI SDK.
// Previously used OpenRouter → Claude 3.5 Haiku (paid).
// Rollback: set OPENROUTER_API_KEY in .env.local to re-enable in llm.ts chain.
console.log('🚀 ARIA BOT BOOTING...');
console.log(`🤖 Telegram: ✅ Connected`);
console.log(`🧠 Chat LLM: ✅ Gemini 2.0 Flash (free)`);
console.log(`🧠 Background LLM: ✅ Unified chain (Gemini → OpenRouter → OpenAI → Anthropic)`);
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

    // Build LLM provider health report
    const providerStatuses = getProviderStatus();
    const llmHealthLines = providerStatuses.map(p => {
        const icon = p.status === 'healthy' ? '✅' : '⚠️';
        return `  ${icon} ${p.name} — ${p.detail}`;
    }).join('\n');

    ctx.reply(
        `🛰️ *Aria Runtime Status*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱️ Uptime: \`${uptimeStr}\`\n` +
        `🚀 Started: \`${BOT_START_TIME.toLocaleTimeString('en-US', { timeZone: 'America/Denver' })} MT\`\n\n` +
        `*Integrations:*\n` +
        `🤖 Chat LLM: ✅ Gemini 2.0 Flash (free)\n` +
        `🗄️ Supabase: ${dbStatus}\n` +
        `🧠 Memory (Pinecone): ${memStatus}\n` +
        `📦 Finale: ${process.env.FINALE_API_KEY ? '✅ Connected' : '❌ Not configured'}\n` +
        `🔍 Perplexity: ${perplexityKey ? '✅ Ready' : '❌ Not configured'}\n` +
        `🦊 Slack Watchdog: ${globalWatchdog ? '✅ Running' : '❌ Not started'}\n` +
        `🎙️ Voice: ${elevenLabsKey ? '✅ ElevenLabs' : '❌ Not configured'}\n\n` +
        `*🧠 Background LLM Chain:*\n` +
        `${llmHealthLines}\n\n` +
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
    delete chatLastActive[chatId];
    ctx.reply(`🗑️ Cleared ${count} messages from context. Fresh start.`, { parse_mode: 'Markdown' });
});

// /memory — on-demand memory diagnostics for OOM debugging
// DECISION(2026-03-09): Surfaces RSS, heap, and cache sizes so Will can
// spot memory trends without SSH-ing into the server.
bot.command('memory', async (ctx) => {
    const mem = process.memoryUsage();
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    const chatKeys = Object.keys(chatHistory).length;
    const totalMsgs = Object.values(chatHistory).reduce((s, arr) => s + arr.length, 0);

    const lines = [
        `🧠 *Memory Diagnostics*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📊 *Process Memory:*`,
        `  RSS: \`${mb(mem.rss)} MB\``,
        `  Heap Used: \`${mb(mem.heapUsed)} MB\``,
        `  Heap Total: \`${mb(mem.heapTotal)} MB\``,
        `  External: \`${mb(mem.external)} MB\``,
        `  ArrayBuffers: \`${mb(mem.arrayBuffers)} MB\``,
        ``,
        `💬 *Chat History:*`,
        `  Active chats: \`${chatKeys}\``,
        `  Total messages: \`${totalMsgs}\``,
        ``,
        `⌛ *Uptime:* \`${((Date.now() - BOT_START_TIME.getTime()) / 3_600_000).toFixed(1)}h\``,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
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
        // Reuse module-level finale singleton instead of creating a new instance
        const consumptionClient = finale;
        const report = await consumptionClient.getBOMConsumption(sku, days);
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

        // Persist snapshot + generate smart reorder prescriptions (fire-and-forget)
        setImmediate(async () => {
            const { saveBuildRiskSnapshot } = await import('../lib/builds/build-risk-logger');
            await saveBuildRiskSnapshot(report);

            // Smart prescriptions: only send if not alerted in last 20h
            try {
                const { generateReorderPrescriptions, formatPrescriptionsTelegram } = await import('../lib/builds/reorder-engine');
                const { createClient } = await import('../lib/supabase');
                const prescriptions = await generateReorderPrescriptions(report.components, report.fgVelocity);
                if (prescriptions.length > 0) {
                    const db = createClient();
                    const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                    const { data: recent } = db
                        ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff)
                        : { data: [] };
                    const recentSet = new Set((recent ?? []).map((r: any) => `${r.sku}:${r.risk_level}`));
                    const fresh = prescriptions.filter(p => !recentSet.has(`${p.componentSku}:${p.riskLevel}`));
                    if (fresh.length > 0) {
                        await ctx.reply(formatPrescriptionsTelegram(fresh), { parse_mode: 'Markdown' });
                        if (db) {
                            await db.from('proactive_alerts').upsert(
                                fresh.map(p => ({
                                    sku: p.componentSku, alert_type: 'reorder', risk_level: p.riskLevel,
                                    stockout_days: p.stockoutDays, suggested_order_qty: p.suggestedOrderQty,
                                    days_after_order: p.daysAfterOrder, alerted_at: new Date().toISOString(),
                                })),
                                { onConflict: 'sku,alert_type' }
                            );
                        }
                    } else {
                        await ctx.reply('🧠 _Smart reorder alerts already sent recently — no duplicates._', { parse_mode: 'Markdown' });
                    }
                }
            } catch (err: any) {
                console.warn('[buildrisk/prescriptions] non-fatal:', err.message);
            }
        });

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

// /builds — Show completed builds from the last 24 hours (or N days with /builds 7)
bot.command('builds', async (ctx) => {
    ctx.sendChatAction('typing');

    const args = ctx.message.text.replace(/^\/builds\s*/, '').trim();
    const days = Math.min(Math.max(parseInt(args) || 1, 1), 30);

    try {
        const { createClient } = await import('../lib/supabase');
        const db = createClient();
        if (!db) {
            return ctx.reply('❌ Supabase not configured.', { parse_mode: 'Markdown' });
        }

        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data, error } = await db
            .from('build_completions')
            .select('build_id,sku,quantity,completed_at,created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw new Error(error.message);

        if (!data || data.length === 0) {
            const label = days === 1 ? 'today' : `the last ${days} days`;
            return ctx.reply(`🏭 *Build Completions*\n\nNo completed builds recorded for ${label}.\n_The watcher checks every 30 min._`, { parse_mode: 'Markdown' });
        }

        // Group by date
        const byDate = new Map<string, typeof data>();
        for (const row of data) {
            const dateKey = new Date(row.completed_at).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Denver',
            });
            if (!byDate.has(dateKey)) byDate.set(dateKey, []);
            byDate.get(dateKey)!.push(row);
        }

        const totalUnits = data.reduce((s: number, r: any) => s + (r.quantity || 0), 0);
        const label = days === 1 ? 'Today' : `Last ${days} Days`;
        let reply = `🏭 *Build Completions — ${label}*\n`;
        reply += `${data.length} build${data.length > 1 ? 's' : ''}  |  ${totalUnits.toLocaleString()} total units\n`;
        reply += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        for (const [dateStr, rows] of byDate) {
            reply += `\n📅 *${dateStr}*\n`;
            for (const row of rows) {
                const time = new Date(row.completed_at).toLocaleTimeString('en-US', {
                    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
                });
                reply += `✅ \`${row.sku}\` × ${row.quantity.toLocaleString()} — ${time}\n`;
            }
        }

        reply += `\n_Use /builds 7 for last 7 days_`;
        await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err: any) {
        console.error('Builds command error:', err.message);
        await ctx.reply(`❌ Error fetching builds: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// /alerts — Show recent smart reorder/build prescriptions from the last 24 hours
bot.command('alerts', async (ctx) => {
    ctx.sendChatAction('typing');
    try {
        const { createClient } = await import('../lib/supabase');
        const db = createClient();
        if (!db) return ctx.reply('❌ Supabase not configured.');

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await db
            .from('proactive_alerts')
            .select('sku,risk_level,stockout_days,suggested_order_qty,days_after_order,alerted_at')
            .gte('alerted_at', since)
            .order('alerted_at', { ascending: false });

        if (error) throw new Error(error.message);

        const { formatAlertsDigest } = await import('../lib/builds/reorder-engine');
        await ctx.reply(formatAlertsDigest(data ?? []), { parse_mode: 'Markdown' });
    } catch (err: any) {
        await ctx.reply(`❌ Error fetching alerts: ${err.message}`, { parse_mode: 'Markdown' });
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
        const gmail = GmailApi({ version: "v1", auth });

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
// KAIZEN FEEDBACK LOOP COMMANDS
// ──────────────────────────────────────────────────

// /kaizen — Generate a self-review report of Aria's accuracy and performance
bot.command('kaizen', async (ctx) => {
    ctx.sendChatAction('typing');
    await ctx.reply('🧘 Running Kaizen Self-Review... analyzing recent performance.', { parse_mode: 'Markdown' });

    try {
        const { generateSelfReview } = await import('../lib/intelligence/feedback-loop');
        const args = ctx.message.text.replace(/^\/kaizen\s*/, '').trim();
        const days = Math.min(Math.max(parseInt(args) || 7, 1), 90);
        const report = await generateSelfReview(days);
        await ctx.reply(report, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.error('Kaizen report error:', err.message);
        await ctx.reply(`❌ Kaizen report failed: ${err.message}`);
    }
});

// /vendor <name> — Show vendor reliability scorecard
bot.command('vendor', async (ctx) => {
    const vendorName = ctx.message.text.replace(/^\/vendor\s*/, '').trim();
    if (!vendorName) {
        return ctx.reply(
            '📊 *Vendor Reliability Scorecard*\n\n' +
            'Usage: `/vendor Mountain Rose Herbs`\n\n' +
            '_Analyzes correction rates, reconciliation outcomes, and response patterns for a specific vendor._',
            { parse_mode: 'Markdown' }
        );
    }

    ctx.sendChatAction('typing');
    try {
        const { getVendorReliability } = await import('../lib/intelligence/feedback-loop');
        const score = await getVendorReliability(vendorName);

        if (!score) {
            return ctx.reply(`❌ Could not retrieve vendor data — Supabase unavailable.`);
        }

        if (score.eventCount === 0) {
            return ctx.reply(
                `📊 *Vendor: ${vendorName}*\n\n` +
                `No feedback data collected yet for this vendor.\n` +
                `_Data accumulates as invoices are processed and reconciled._`,
                { parse_mode: 'Markdown' }
            );
        }

        const pct = score.overallScore >= 0 ? score.overallScore : 0;
        const emoji = pct >= 85 ? '🟢' : pct >= 60 ? '🟡' : '🔴';
        let msg = `📊 *Vendor: ${vendorName}*\n`;
        msg += `${emoji} Overall Score: *${pct}%*\n`;
        msg += `Based on ${score.eventCount} events (last 90 days)\n`;
        msg += `Trend: ${score.trend === 'improving' ? '⬆️ Improving' : score.trend === 'declining' ? '⬇️ Declining' : '➡️ Stable'}\n\n`;
        if (score.onTimePercent >= 0) msg += `• On-Time Delivery: ${score.onTimePercent}%\n`;
        if (score.invoiceAccuracy >= 0) msg += `• Invoice Accuracy: ${score.invoiceAccuracy}%\n`;
        if (score.documentQuality >= 0) msg += `• Document Quality: ${score.documentQuality}%\n`;
        if (score.avgResponseDays >= 0) msg += `• Avg Response: ${score.avgResponseDays} days\n`;
        if (score.recentIssues.length > 0) {
            msg += `\n⚠️ Recent Issues:\n`;
            for (const issue of score.recentIssues) {
                msg += `  • ${issue}\n`;
            }
        }
        msg += `\n_Scores update as reconciliations and corrections accumulate._`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
        await ctx.reply(`❌ Vendor lookup failed: ${err.message}`);
    }
});

// /housekeeping — Manually trigger data cleanup
bot.command('housekeeping', async (ctx) => {
    ctx.sendChatAction('typing');
    await ctx.reply('🧹 Running manual housekeeping...', { parse_mode: 'Markdown' });

    try {
        const { runHousekeeping } = await import('../lib/intelligence/feedback-loop');
        const report = await runHousekeeping();
        let msg = `🧹 *Housekeeping Complete*\n\n`;
        msg += `Total reclaimed: *${report.totalReclaimed}* rows/vectors\n\n`;
        if (report.feedbackEventsPruned > 0) msg += `• Feedback events: ${report.feedbackEventsPruned} pruned\n`;
        if (report.chatLogsPruned > 0) msg += `• Chat logs: ${report.chatLogsPruned} pruned\n`;
        if (report.exceptionsPruned > 0) msg += `• Exceptions: ${report.exceptionsPruned} pruned\n`;
        if (report.alertsPruned > 0) msg += `• Alerts: ${report.alertsPruned} pruned\n`;
        if (report.pineconeMemoriesPruned > 0) msg += `• Pinecone memories: ${report.pineconeMemoriesPruned} pruned\n`;
        if (report.totalReclaimed === 0) msg += `_Nothing to clean — database is tidy._ ✨\n`;
        msg += `\n_Runs automatically every night at 11 PM MT._`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
        await ctx.reply(`❌ Housekeeping failed: ${err.message}`);
    }
});

// ──────────────────────────────────────────────────
// REUSABLE: Send email with PDF attachment via Gmail API
// ──────────────────────────────────────────────────

async function sendPdfEmail(to: string, subject: string, body: string, pdfBuffer: Buffer, pdfFilename: string): Promise<void> {
    const { getAuthenticatedClient: getGmailAuth } = await import('../lib/gmail/auth');
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

// ──────────────────────────────────────────────────
// CONVERSATION HISTORY (shared across text + document handlers)
// ──────────────────────────────────────────────────

const chatHistory: Record<string, any[]> = {};
const chatLastActive: Record<string, number> = {};

// DECISION(2026-03-09): Periodic GC for stale chat history entries.
// Without this, every unique Telegram chatId creates an entry that lives forever.
// Sweep every 30 minutes — evict chats inactive for 4+ hours.
const CHAT_GC_INTERVAL = 30 * 60 * 1000;
const CHAT_GC_TTL = 4 * 60 * 60 * 1000; // 4 hours
const CHAT_MAX_KEYS = 100;
setInterval(() => {
    const now = Date.now();
    const keys = Object.keys(chatHistory);
    let evicted = 0;

    for (const key of keys) {
        const lastActive = chatLastActive[key] || 0;
        if (now - lastActive > CHAT_GC_TTL) {
            delete chatHistory[key];
            delete chatLastActive[key];
            evicted++;
        }
    }

    // If still over cap, evict oldest
    const remaining = Object.keys(chatHistory);
    if (remaining.length > CHAT_MAX_KEYS) {
        const sorted = remaining.sort((a, b) => (chatLastActive[a] || 0) - (chatLastActive[b] || 0));
        const toEvict = sorted.slice(0, remaining.length - CHAT_MAX_KEYS);
        for (const key of toEvict) {
            delete chatHistory[key];
            delete chatLastActive[key];
            evicted++;
        }
    }

    if (evicted > 0) {
        console.log(`[chat-gc] Evicted ${evicted} stale chat(s) — ${Object.keys(chatHistory).length} remaining`);
    }
}, CHAT_GC_INTERVAL);

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
                prompt: `User's request: ${caption || 'Analyze this file'}\n\nFile: ${filename}\nData (${textContent.length} chars total, showing up to 60,000 chars):\n${textContent.slice(0, 60000)}${finaleContext}\n\nNOTE: If data appears truncated, work with what's available above — do NOT ask for the complete data. Give the best answer possible from what you have.`
            });

            reply += analysis;
            await ctx.reply(reply, { parse_mode: 'Markdown' });

            // Store in conversation history so follow-up questions have context
            const chatId = ctx.from?.id || ctx.chat.id;
            if (!chatHistory[chatId]) chatHistory[chatId] = [];
            chatLastActive[chatId] = Date.now();
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
        chatLastActive[chatId] = Date.now();
        chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' — ' + caption : ''}` });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

    } catch (err: any) {
        console.error(`Document processing error (${filename}):`, err.message);
        await ctx.reply(`❌ Failed to process *${filename}*: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ──────────────────────────────────────────────────
// SHARED LLM PROCESSING — Telegram handler + Dashboard HTTP bridge
// ──────────────────────────────────────────────────

async function processTextMessage(text: string, chatId: number): Promise<string> {
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatLastActive[chatId] = Date.now();
    chatHistory[chatId].push({ role: "user", content: text });
    if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

    let memoryContext = '';
    try {
        const { getRelevantContext } = await import('../lib/intelligence/memory');
        memoryContext = await getRelevantContext(text);
    } catch { /* memory unavailable, continue without */ }

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

    try {
        // DECISION(2026-03-06): Use Gemini via Vercel AI SDK with shared Aria tools.
        // generateText handles the full tool call loop automatically via stopWhen.
        // Previously used OpenRouter → openai.chat.completions.create with manual tool loop.
        const tools = getAriaTools({ finale, perplexity, bot, chatId });
        const conversationMessages = chatHistory[chatId]
            .filter((m: any) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
            .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const { text: geminiReply, steps } = await generateText({
            model: googleAI('gemini-2.0-flash'),
            system: SYSTEM_PROMPT + memoryContext + runtimeRules,
            messages: conversationMessages,
            tools,
            stopWhen: stepCountIs(5),
        });
        reply = geminiReply;
        chatHistory[chatId].push({ role: 'assistant', content: reply });

        // Auto-learn: store tool usage patterns in memory (fire-and-forget)
        const toolsUsed = steps
            .flatMap(s => s.toolCalls || [])
            .map((tc: any) => tc.toolName);
        if (toolsUsed.length > 0) {
            setImmediate(async () => {
                try {
                    const { remember } = await import('../lib/intelligence/memory');
                    const firstTool = toolsUsed[0];
                    const category =
                        firstTool.includes('vendor') ? 'vendor_pattern' :
                            firstTool.includes('product') || firstTool.includes('sku') || firstTool.includes('consumption') || firstTool.includes('purchase') ? 'product_note' :
                                firstTool.includes('invoice') || firstTool.includes('purchase_order') ? 'process' :
                                    'conversation';
                    const tagMatches = (text + ' ' + reply).match(/\b([A-Z][A-Z0-9-]{2,15})\b/g) || [];
                    const tags = [...new Set(tagMatches)].slice(0, 5);
                    await remember({
                        category,
                        content: `Q: "${text.slice(0, 150)}" → Tools: ${toolsUsed.join(', ')} → A: "${reply.slice(0, 300)}"`,
                        tags,
                        source: 'telegram_auto',
                        priority: 'low',
                    });
                } catch { /* non-critical, never block the response */ }
            });
        }
    } catch (geminiErr: any) {
        // Fallback: if Gemini fails, use the unified chain (which includes Ollama)
        console.warn(`⚠️ Gemini chat failed: ${geminiErr.message}. Falling back to unified chain.`);
        reply = await unifiedTextGeneration({
            system: SYSTEM_PROMPT + memoryContext + runtimeRules,
            messages: chatHistory[chatId]
                .filter((m: any) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                .map((m: any) => ({ role: m.role, content: m.content })) as any,
        });
        chatHistory[chatId].push({ role: 'assistant', content: reply });
    }

    return reply;
}

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
    chatLastActive[chatId] = Date.now();

    // Mirror to dashboard (fire-and-forget)
    setImmediate(async () => {
        const { logChatMessage } = await import('../lib/intelligence/chat-logger');
        await logChatMessage({ source: 'telegram', role: 'user', content: userText });
    });

    // ── "Please forward" shortcut — check for pending unmatched invoices ──────
    // If Will says "forward" and there are pending dropship invoices, offer buttons
    if (/\bforward\b/i.test(userText)) {
        const pending = await getAllPendingDropships();
        if (pending.length > 0) {
            const { Markup } = await import('telegraf');
            const lines = pending.map(p =>
                `• ${p.vendorName} — Invoice ${p.invoiceNumber} ($${p.total.toLocaleString()})`
            ).join('\n');
            const buttons = pending.slice(0, 3).map(p =>
                [Markup.button.callback(`📦 Forward ${p.invoiceNumber}`, `dropship_fwd_${p.id}`)]
            );
            await ctx.reply(
                `${pending.length} unmatched invoice(s) pending:\n${lines}\n\nForward one to bill.com?`,
                Markup.inlineKeyboard(buttons)
            );
            return;
        }
    }

    // ── Manual PO# entry intercept ────────────────────────────────────────────
    // When Will tapped "This Has a PO — Enter PO#", we're waiting for the number.
    // Intercept it here, run reconciliation, and skip the LLM entirely.
    if (pendingPoEntry.has(chatId)) {
        const dropId = pendingPoEntry.get(chatId)!;
        pendingPoEntry.delete(chatId); // Clear state regardless of outcome

        const poNumber = userText.trim().toUpperCase();
        const pending = await getPendingDropship(dropId);

        if (!pending) {
            await ctx.reply(`⚠️ Invoice session expired — the 48-hour window passed. Start a fresh AP scan if needed.`);
            return;
        }
        if (!poNumber || poNumber.length < 2) {
            await ctx.reply(`That doesn't look like a PO number. Tap the button again to retry.`);
            return;
        }

        ctx.sendChatAction('typing');
        try {
            const { extractPDF } = await import('../lib/pdf/extractor');
            const { parseInvoice } = await import('../lib/pdf/invoice-parser');

            const buffer = Buffer.from(pending.base64Pdf, 'base64');
            const extracted = await extractPDF(buffer);
            const invoiceData = await parseInvoice(extracted.rawText);

            // Force-inject the user-supplied PO number regardless of what the parser found
            invoiceData.poNumber = poNumber;

            await ctx.reply(`🔍 Running reconciliation for *${pending.invoiceNumber}* against Finale PO *${poNumber}*...`, { parse_mode: 'Markdown' });

            const recon = await reconcileInvoiceToPO(invoiceData, poNumber, finale);

            if (recon.overallVerdict === 'no_match') {
                await ctx.reply(`❌ PO *${poNumber}* not found in Finale. Double-check the number and tap the button to try again.`, { parse_mode: 'Markdown' });
                return;
            }

            const { Markup } = await import('telegraf');

            if (recon.overallVerdict === 'auto_approve') {
                const applyResult = await applyReconciliation(recon, finale);
                await removePendingDropship(dropId);
                await ctx.reply(
                    recon.summary + `\n\n✅ Applied ${applyResult.applied.length} change(s) to Finale PO ${poNumber}.`,
                    { parse_mode: 'Markdown' }
                );
            } else if (recon.overallVerdict === 'needs_approval') {
                const approvalId = await storePendingApproval(recon, finale);
                await ctx.reply(
                    recon.summary + '\n\n☝️ Tap to approve or reject:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            Markup.button.callback('✅ Approve & Apply', `approve_${approvalId}`),
                            Markup.button.callback('❌ Reject', `reject_${approvalId}`),
                        ])
                    }
                );
            } else {
                // no_change, duplicate, rejected — just show summary
                await ctx.reply(recon.summary, { parse_mode: 'Markdown' });
            }
        } catch (err: any) {
            await ctx.reply(`❌ Reconciliation failed: ${err.message}`);
        }
        return; // Do NOT fall through to LLM
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

        try {
            // DECISION(2026-03-06): Same Gemini + tools pattern as processTextMessage.
            const tools = getAriaTools({ finale, perplexity, bot, chatId });
            const conversationMessages = chatHistory[chatId]
                .filter((m: any) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

            const { text: geminiReply, steps } = await generateText({
                model: googleAI('gemini-2.0-flash'),
                system: SYSTEM_PROMPT + memoryContext + runtimeRules,
                messages: conversationMessages,
                tools,
                stopWhen: stepCountIs(5),
            });
            reply = geminiReply;
            chatHistory[chatId].push({ role: 'assistant', content: reply });

            // Auto-learn: store tool usage patterns in memory (fire-and-forget)
            const toolsUsed = steps
                .flatMap(s => s.toolCalls || [])
                .map((tc: any) => tc.toolName);
            if (toolsUsed.length > 0) {
                setImmediate(async () => {
                    try {
                        const { remember } = await import('../lib/intelligence/memory');
                        const firstTool = toolsUsed[0];
                        const category =
                            firstTool.includes('vendor') ? 'vendor_pattern' :
                                firstTool.includes('product') || firstTool.includes('sku') || firstTool.includes('consumption') || firstTool.includes('purchase') ? 'product_note' :
                                    firstTool.includes('invoice') || firstTool.includes('purchase_order') ? 'process' :
                                        'conversation';
                        const tagMatches = (userText + ' ' + reply).match(/\b([A-Z][A-Z0-9-]{2,15})\b/g) || [];
                        const tags = [...new Set(tagMatches)].slice(0, 5);
                        await remember({
                            category,
                            content: `Q: "${userText.slice(0, 150)}" → Tools: ${toolsUsed.join(', ')} → A: "${reply.slice(0, 300)}"`,
                            tags,
                            source: 'telegram_auto',
                            priority: 'low',
                        });
                    } catch { /* non-critical, never block the response */ }
                });
            }
        } catch (geminiErr: any) {
            // Fallback: if Gemini fails, use the unified chain (which includes Ollama)
            console.warn(`⚠️ Gemini chat failed: ${geminiErr.message}. Falling back to unified chain.`);
            reply = await unifiedTextGeneration({
                system: SYSTEM_PROMPT + memoryContext + runtimeRules,
                messages: chatHistory[chatId]
                    .filter((m: any) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                    .map((m: any) => ({ role: m.role, content: m.content })) as any,
            });
            chatHistory[chatId].push({ role: 'assistant', content: reply });
        }

        // Mirror to dashboard (fire-and-forget)
        setImmediate(async () => {
            const { logChatMessage } = await import('../lib/intelligence/chat-logger');
            await logChatMessage({ source: 'telegram', role: 'assistant', content: reply });
        });

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

    // TEXT COMMAND FALLBACK for approvals — handles /approve_<id> and /reject_<id>
    // typed as plain text. Useful when the inline buttons are no longer tappable
    // (e.g., old message scrolled past, or approval came from the test pipeline script).
    bot.hears(/^\/approve_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`🔑 Approval text command: ${approvalId}`);
        try {
            const result = await approvePendingReconciliation(approvalId);
            const responseMsg = result.success
                ? `${result.message}\n\nApplied:\n${result.applied.map((a: string) => `  ✅ ${a}`).join('\n')}${result.errors.length > 0 ? `\n\nErrors:\n${result.errors.map((e: string) => `  ❌ ${e}`).join('\n')}` : ''}`
                : `⚠️ ${result.message}`;
            await ctx.reply(responseMsg, { parse_mode: 'Markdown' });
        } catch (err: any) {
            await ctx.reply(`❌ Approval failed: ${err.message}`);
        }
    });

    bot.hears(/^\/reject_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`🔒 Rejection text command: ${approvalId}`);
        const message = await rejectPendingReconciliation(approvalId);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // DROPSHIP INVOICE INLINE BUTTONS
    // ──────────────────────────────────────────────────
    // When an unmatched invoice arrives, AP agent sends three buttons.
    // These handlers forward to bill.com, prompt for a PO#, or skip.

    bot.action(/^dropship_fwd_(.+)$/, async (ctx) => {
        const dropId = ctx.match[1];
        const pending = await getPendingDropship(dropId);

        // Must answer the callback query within 10s regardless of outcome.
        // Use neutral text here; the editMessageText below gives the real status.
        await ctx.answerCbQuery(pending ? 'Forwarding to bill.com...' : 'Data expired — see recovery options');

        if (!pending) {
            await ctx.editMessageText(
                (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                '\n\n⚠️ Invoice data no longer in memory (bot restarted and cleared in-memory store).\n\nRecovery options:\n• Forward the original email to buildasoilap@bill.com manually\n• Run /ap scan to re-poll the inbox\n• Check Supabase `invoices` table for this invoice'
            );
            return;
        }

        try {
            // Build MIME email and send via Gmail (use ap token, fall back to default)
            let authClient: any;
            try {
                authClient = await getAuthenticatedClient('ap');
            } catch {
                authClient = await getAuthenticatedClient('default');
            }
            const gmail = GmailApi({ version: 'v1', auth: authClient });

            const boundary = 'b_aria_drop_' + Math.random().toString(36).substring(2);
            const mime = [
                `To: buildasoilap@bill.com`,
                `Subject: Fwd: ${pending.subject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                ``,
                `--${boundary}`,
                `Content-Type: text/plain; charset="UTF-8"`,
                ``,
                `Dropship invoice forwarded via Aria AP Agent.`,
                `Vendor: ${pending.vendorName} | Invoice: ${pending.invoiceNumber} | Total: $${pending.total}`,
                ``,
                `--${boundary}`,
                `Content-Type: application/pdf; name="${pending.filename}"`,
                `Content-Transfer-Encoding: base64`,
                `Content-Disposition: attachment; filename="${pending.filename}"`,
                ``,
                pending.base64Pdf,
                `--${boundary}--`,
            ].join('\r\n');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: Buffer.from(mime).toString('base64url') },
            });

            await removePendingDropship(dropId);

            const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text : '';
            await ctx.editMessageText(
                original + `\n\n✅ Forwarded to buildasoilap@bill.com as dropship.\nAdding ${pending.vendorName} to known dropship list.`
            );
            console.log(`📦 Dropship forwarded: ${pending.invoiceNumber} (${pending.vendorName})`);
        } catch (err: any) {
            await ctx.reply(`❌ Forward failed: ${err.message}`);
        }
    });

    bot.action(/^invoice_has_po_(.+)$/, async (ctx) => {
        const dropId = ctx.match[1];
        const pending = await getPendingDropship(dropId);
        await ctx.answerCbQuery('Enter the PO number in chat');
        const name = pending ? pending.invoiceNumber : dropId;

        const chatId = ctx.chat?.id;

        if (!pending) {
            // Bot restarted — in-memory store is gone. Give the same three recovery
            // options as the dropship_fwd_ stale path for consistency.
            if (chatId) pendingPoEntry.set(chatId, dropId);
            await ctx.reply(
                `⚠️ Invoice data expired (bot restarted — in-memory store cleared).\n\nRecovery options:\n• Forward the original email to buildasoilap@bill.com manually\n• Reply with the PO# and I'll check Supabase for the invoice\n• Run /ap scan to re-poll the inbox`
            );
            return;
        }

        // Register state so the text handler knows to intercept the next message
        if (chatId) pendingPoEntry.set(chatId, dropId);
        await ctx.reply(
            `What's the Finale PO number for invoice ${name}?\nReply with just the PO# and I'll run the match.`
        );
    });

    bot.action(/^invoice_skip_(.+)$/, async (ctx) => {
        const dropId = ctx.match[1];
        await ctx.answerCbQuery('Skipped');
        await removePendingDropship(dropId);
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n⏭️ Skipped — invoice left unmatched in Supabase.');
    });

    // PO COMMIT & SEND INLINE BUTTONS
    // ──────────────────────────────────────────────────
    // Three-step flow:
    //   po_review_<orderId>      → fetch PO details, look up vendor email, show confirm screen
    //   po_confirm_send_<sendId> → commit in Finale + send email
    //   po_cancel_send_<sendId>  → dismiss, PO stays as draft
    //   po_skip_<orderId>        → silent dismiss (no review needed)

    bot.action(/^po_review_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery('Fetching PO details…');
        try {
            // Reuse module-level finale singleton instead of creating a new instance
            const reviewClient = finale;
            const review = await reviewClient.getDraftPOForReview(orderId);

            if (!review.canCommit) {
                await ctx.editMessageText(
                    (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                    `\n\n⚠️ PO #${orderId} is no longer in draft status — cannot commit.`
                );
                return;
            }

            const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);

            const itemLines = review.items.map(i =>
                `  • ${i.productId}  ${i.productName.slice(0, 28).padEnd(28)}  ×${i.quantity}  $${i.unitPrice.toFixed(2)} = $${i.lineTotal.toFixed(2)}`
            ).join('\n');

            const reviewText = [
                `📋 *PO #${review.orderId} — ${review.vendorName}*`,
                ``,
                itemLines,
                ``,
                `*Total: $${review.total.toFixed(2)}*`,
                `To: ${email ? `${email} _(${source})_` : '⚠️ No vendor email on file'}`,
                ``,
                email
                    ? `⚠️ _This will commit in Finale AND email the vendor._`
                    : `_Cannot send — no email address found for ${review.vendorName}._\n_Add it to vendor\\_profiles or the vendors table._`,
            ].join('\n');

            if (!email) {
                await ctx.editMessageText(reviewText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '❌ Cancel', callback_data: `po_cancel_send_noop_${orderId}` },
                        ]],
                    },
                });
                return;
            }

            const sendId = storePendingPOSend(orderId, review, email, source);
            await ctx.editMessageText(reviewText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Confirm Send', callback_data: `po_confirm_send_${sendId}` },
                        { text: '❌ Cancel', callback_data: `po_cancel_send_${sendId}` },
                    ]],
                },
            });
        } catch (err: any) {
            await ctx.reply(`❌ Failed to fetch PO #${orderId}: ${err.message}`);
        }
    });

    bot.action(/^po_confirm_send_(.+)$/, async (ctx) => {
        const sendId = ctx.match[1];
        await ctx.answerCbQuery('Committing and sending…');
        const pending = getPendingPOSend(sendId);
        if (!pending) {
            await ctx.editMessageText(
                (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                '\n\n⚠️ Send data expired (bot restarted). Please tap "Review & Send" again to re-initiate.'
            );
            return;
        }
        try {
            const result = await commitAndSendPO(sendId, 'telegram');
            await ctx.editMessageText(
                (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                `\n\n✅ PO #${result.orderId} committed in Finale and emailed to ${result.sentTo}`
            );
            // Pinecone auto-learn
            setImmediate(async () => {
                try {
                    const { remember } = await import('../lib/intelligence/memory');
                    await remember({
                        category: 'process',
                        content: `PO #${result.orderId} committed in Finale and emailed to ${result.sentTo}`,
                        source: 'telegram',
                        priority: 'normal',
                    });
                } catch { }
            });
        } catch (err: any) {
            await ctx.reply(`❌ Failed to commit/send PO: ${err.message}`);
        }
    });

    bot.action(/^po_cancel_send_(.+)$/, async (ctx) => {
        const sendId = ctx.match[1];
        await ctx.answerCbQuery('Cancelled');
        expirePendingPOSend(sendId);
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n_Cancelled — PO remains as draft in Finale._', { parse_mode: 'Markdown' });
    });

    bot.action(/^po_skip_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Skipped');
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n_Skipped — PO stays as draft in Finale._', { parse_mode: 'Markdown' });
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

    // Start aria-review folder watcher
    try {
        const reviewAgent = new APAgent(bot);
        await initAriaReviewWatcher(reviewAgent);
    } catch (err: any) {
        console.warn('[aria-review] Watcher failed to start (non-fatal):', err.message);
    }

    // ── Restore pending approvals from Supabase (survive pm2 restart) ────────────
    try {
        const pending = await loadPendingApprovalsFromSupabase();

        if (pending.length > 0) {
            console.log(`[boot] Restoring ${pending.length} pending approval(s) from Supabase...`);

            for (const entry of pending) {
                const { approvalId, result, telegramChatId, expiresAt } = entry;

                const minutesLeft = Math.round((expiresAt.getTime() - Date.now()) / 60000);

                if (minutesLeft <= 0) {
                    console.log(`[boot] Skipping expired approval ${approvalId} (already past 24h window)`);
                    continue;
                }

                const chatId = Number(telegramChatId) || Number(process.env.TELEGRAM_CHAT_ID);
                if (!chatId) {
                    console.warn(`[boot] No chat ID for approval ${approvalId} — skipping`);
                    continue;
                }

                const summaryText = buildRestoredApprovalMessage(result, approvalId, minutesLeft);

                try {
                    await bot.telegram.sendMessage(chatId, summaryText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Approve & Apply', callback_data: `approve_${approvalId}` },
                                { text: '❌ Reject', callback_data: `reject_${approvalId}` },
                            ]],
                        },
                    });
                    console.log(`[boot] Restored approval prompt for ${approvalId} (${minutesLeft}m remaining)`);
                } catch (sendErr: any) {
                    console.warn(`[boot] Could not send restored approval for ${approvalId}: ${sendErr.message}`);
                }
            }
        }
    } catch (err: any) {
        console.warn('[boot] Could not restore pending approvals (non-fatal):', err.message);
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

    console.log('   📊 Daily PO Summary:  8:00 AM MT (Daily)');
    console.log('   🗓️  Weekly Review:     8:01 AM MT (Fridays)');
    console.log('   📦 PO Sync:           Every 30 min');
    console.log('   🧹 Ad Cleanup:        Every hour');

    // ── MEMORY MONITORING (OOM prevention) ──
    // DECISION(2026-03-09): Log memory usage hourly for PM2 log analysis.
    // Also provides /memory command for on-demand diagnostics.
    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
        console.log(
            `[memory] RSS: ${mb(mem.rss)}MB | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB` +
            ` | External: ${mb(mem.external)}MB | Chats: ${Object.keys(chatHistory).length}`
        );
    }, 15 * 60 * 1000); // every 15 minutes

    let lastMemAlertSent = 0;
    setInterval(async () => {
        const heapUsed = process.memoryUsage().heapUsed;
        const HEAP_THRESHOLD = 768 * 1024 * 1024;
        const COOLDOWN = 2 * 60 * 60 * 1000;
        if (heapUsed > HEAP_THRESHOLD && Date.now() - lastMemAlertSent > COOLDOWN) {
            const mb = Math.round(heapUsed / 1024 / 1024);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                await bot.telegram.sendMessage(
                    chatId,
                    `⚠️ Memory alert: heap at ${mb}MB / 768MB threshold (1GB hard cap) — consider restarting if this persists.`
                ).catch(() => { });
                lastMemAlertSent = Date.now();
            }
        }
    }, 30 * 60 * 1000); // every 30 minutes
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
