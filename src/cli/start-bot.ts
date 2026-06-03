/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Gemini (primary chat) with automatic OpenRouter fallback, and
 *          Vercel AI SDK tool calling.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-05-26
 *
 * DECISION(2026-03-18): Chat now uses a provider chain with tool support.
 * Refactored on 2026-05-26 to delegate heavy lifters to modular handlers under ./handlers/.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import { TELEGRAM_CONFIG } from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import '../cron/jobs'; // side-effect: registers every cron job
import { startCronRunner } from '../cron/runner';
import { registerAllCommands } from './commands';
import { FinaleClient } from '../lib/finale/client';
import { APAgent } from '../lib/intelligence/ap-agent';
import { initSandboxWatcher } from '../lib/intelligence/sandbox-watcher';
import { startBotControlPlane } from '../lib/ops/bot-control-plane';
import {
    loadPendingApprovalsFromSupabase,
    type ReconciliationResult,
} from '../lib/finale/reconciler';
import { handleTelegramText } from '../lib/copilot/channels/telegram';
// Slack removed — getStartupHealth deleted

// ── Import modular handlers ──────────────────────────
import { handlePhotoUpload, handleDocumentUpload } from './handlers/media-handler';
import {
    handleApproveReconciliation,
    handleRejectReconciliation,
    handleNotedReconciliation,
    handleFlagReconciliation,
} from './handlers/reconciliation-actions';
import {
    handlePoReview,
    handlePoConfirmSend,
    handlePoCancelSend,
    handlePoSkip,
    handleApproveUlineFriday,
    handleSkipUlineFriday,
} from './handlers/po-uline-actions';
import {
    handleTasksPage,
    handleTaskApprove,
    handleTaskReject,
    handleTaskDismiss,
    handleIssueApprove,
    handleIssueReject,
    handleIssueResolve,
    handleIssuePause,
    handleIssueResume,
    handleIssueRun,
    handleIssueDetail,
} from './handlers/task-issue-actions';
import {
    handleReceiptConfirm,
    handleReceiptSkip,
} from './handlers/receipt-actions';
import {
    handleEscalationReplace,
    handleEscalationDraft,
} from './handlers/escalation-actions';
import {
    handleExceptionReview,
    handleExceptionDismiss,
} from './handlers/exception-actions';
import {
    handleOrderApprove,
    handleOrderAbandon,
} from './handlers/order-actions';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build the Telegram message text for a restored (post-restart) approval prompt.
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
        `👇 👇 👇 👇 👇 👇 👇 👇 👇 👇\n` +
        `*Vendor:* ${vendor}\n` +
        `*Invoice:* ${invNum}  →  *PO:* ${poNum}\n` +
        `*Impact:* ${impact}\n\n` +
        `*Changes pending approval:*\n${changeList}\n\n` +
        `_Tap Approve or Reject below_`
    );
}

// ============================================================================
// CLIENT INITIALIZATION
// ============================================================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const perplexityKey = process.env.PERPLEXITY_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);

// Finale Inventory client
const finale = new FinaleClient();

console.log('🚀 ARIA BOT BOOTING...');
console.log(`🤖 Telegram: ✅ Connected`);
console.log(`🧠 Chat LLM: ✅ Gemini 2.0 Flash (free)`);
console.log(`🧠 Background LLM: ✅ Unified chain (Gemini → OpenRouter → OpenAI → Anthropic)`);
console.log(`🔭 Perplexity: ${perplexityKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`🎙️ ElevenLabs: ${elevenLabsKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`📦 Finale: ${process.env.FINALE_API_KEY ? '✅ Connected' : '❌ Not Configured'}`);

// Slack removed — globalWatchdog deleted

// ============================================================================
// Telegram Event Listeners & Router Delegations
// ============================================================================

bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

const BOT_START_TIME = new Date();

// Shared chat history tracking
const chatHistory: Record<string, any[]> = {};
const chatLastActive: Record<string, number> = {};

// Periodic GC for stale chat history entries
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

// Document & Photo Listeners
bot.on('photo', (ctx) => handlePhotoUpload(ctx));
bot.on('document', (ctx) => handleDocumentUpload(ctx, finale, chatHistory, chatLastActive));

// Chat Personae text listener
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.from?.id || ctx.chat.id;

    if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
    }
    chatLastActive[chatId] = Date.now();

    ctx.sendChatAction('typing');

    try {
        const { reply } = await handleTelegramText({
            chatId,
            text: userText,
        });

        chatHistory[chatId].push({ role: "user", content: userText });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) {
            chatHistory[chatId] = chatHistory[chatId].slice(-20);
        }

        try {
            await ctx.reply(reply, { parse_mode: 'Markdown' });
        } catch (sendErr: any) {
            const desc = sendErr?.description ?? sendErr?.response?.description ?? sendErr?.message ?? '';
            if (/can't parse entities|parse_mode|byte offset/i.test(desc)) {
                console.warn('[chat] Markdown rejected by Telegram, retrying as plain text:', desc);
                await ctx.reply(reply);
            } else {
                throw sendErr;
            }
        }
    } catch (err: any) {
        console.error('Chat Error:', err.message);
        await ctx.reply(`⚠️ Ops: ${err.message}`);
    }
});

// Inline Action Callbacks Router Delegations
bot.action(/^approve_(.+)$/, (ctx) => handleApproveReconciliation(ctx, ctx.match[1]));
bot.action(/^reject_(.+)$/, (ctx) => handleRejectReconciliation(ctx, ctx.match[1]));
bot.action(/^noted_(.+)$/, (ctx) => handleNotedReconciliation(ctx, ctx.match[1]));
bot.action(/^flag_(.+)$/, (ctx) => handleFlagReconciliation(ctx, ctx.match[1]));

bot.action(/^po_review_(.+)$/, (ctx) => handlePoReview(ctx, finale, ctx.match[1]));
bot.action(/^po_confirm_send_(.+)$/, (ctx) => handlePoConfirmSend(ctx, ctx.match[1]));
bot.action(/^po_cancel_send_(.+)$/, (ctx) => handlePoCancelSend(ctx, ctx.match[1]));
bot.action(/^po_skip_(.+)$/, (ctx) => handlePoSkip(ctx, ctx.match[1]));

bot.action(/^task_approve_(.+)$/, (ctx) => handleTaskApprove(ctx, ctx.match[1]));
bot.action(/^task_reject_(.+)$/, (ctx) => handleTaskReject(ctx, ctx.match[1]));
bot.action(/^task_dismiss_(.+)$/, (ctx) => handleTaskDismiss(ctx, ctx.match[1]));
bot.action(/^tasks_page_(\d+)$/, (ctx) => handleTasksPage(ctx, parseInt(ctx.match[1], 10)));

bot.action(/^issue_approve_(.+)$/, (ctx) => handleIssueApprove(ctx, ctx.match[1]));
bot.action(/^issue_reject_(.+)$/, (ctx) => handleIssueReject(ctx, ctx.match[1]));
bot.action(/^issue_resolve_(.+)$/, (ctx) => handleIssueResolve(ctx, ctx.match[1]));
bot.action(/^issue_pause_(.+)$/, (ctx) => handleIssuePause(ctx, ctx.match[1]));
bot.action(/^issue_resume_(.+)$/, (ctx) => handleIssueResume(ctx, ctx.match[1]));
bot.action(/^issue_run_(.+)$/, (ctx) => handleIssueRun(ctx, ctx.match[1]));
bot.action(/^issue_detail_(.+)$/, (ctx) => handleIssueDetail(ctx, ctx.match[1]));

// ── Receipt confirmation actions ─────────────────────────────────────────
bot.action(/^receipt_confirm_(.+)$/, (ctx) => handleReceiptConfirm(ctx, ctx.match[1]));
bot.action(/^receipt_skip_(.+)$/, (ctx) => handleReceiptSkip(ctx, ctx.match[1]));

// ── Vendor escalation actions ──────────────────────────────────────────
bot.action(/^escalation_replace_(.+)$/, (ctx) => handleEscalationReplace(ctx, ctx.match[1]));
bot.action(/^escalation_draft_(.+)$/, (ctx) => handleEscalationDraft(ctx, ctx.match[1]));

// ── Exception escalation actions ─────────────────────────────────────────
bot.action(/^exception_review_(.+)$/, (ctx) => handleExceptionReview(ctx, ctx.match[1]));
bot.action(/^exception_dismiss_(.+)$/, (ctx) => handleExceptionDismiss(ctx, ctx.match[1]));

// ── Browser order actions ─────────────────────────────────────────────
bot.action(/^order_approve_(.+)$/, (ctx) => handleOrderApprove(ctx, ctx.match[1]));
bot.action(/^order_abandon_(.+)$/, (ctx) => handleOrderAbandon(ctx, ctx.match[1]));

bot.action('approve_uline_friday', (ctx) => {
    const opsManager = (bot.context as any).opsManager;
    return handleApproveUlineFriday(ctx, opsManager);
});
bot.action('skip_uline_friday', (ctx) => {
    const opsManager = (bot.context as any).opsManager;
    return handleSkipUlineFriday(ctx, opsManager);
});

// Text Fallbacks for approvals
bot.hears(/^\/approve_(.+)$/, async (ctx) => {
    const approvalId = ctx.match[1];
    console.log(`🔑 Approval text command: ${approvalId}`);
    try {
        const { approvePendingReconciliation } = await import('../lib/finale/reconciler');
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
    console.log(`➡️ Rejection text command: ${approvalId}`);
    try {
        const { rejectPendingReconciliation } = await import('../lib/finale/reconciler');
        const message = await rejectPendingReconciliation(approvalId);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err: any) {
        await ctx.reply(`❌ Rejection failed: ${err.message}`);
    }
});

// Legacy Button callback stubs
bot.action(/^dropship_fwd_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Dropship forwarding has been retired');
    const original = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : '';
    await ctx.editMessageText(
        original + '\n\n⚠️ Dropship forwarding has been retired. All invoices now go through PO matching.\nForward manually if needed.'
    );
});

bot.action(/^invoice_has_po_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Legacy workflow retired');
    await ctx.reply('Legacy PO entry flow has been retired. Please use PO matching.');
});

bot.action(/^invoice_skip_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Skipped');
    const original = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : '';
    await ctx.editMessageText(original + '\n\n🔘 Skipped — invoice left unmatched.');
});

// ============================================================================
// BOOT ORCHESTRATION
// ============================================================================

(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🔄 Cleared previous Telegram session');
    } catch (err: any) {
        console.log('⚠️ Webhook clear failed (non-fatal):', err.message);
    }

    bot.launch({ dropPendingUpdates: true })
        .catch((err: any) => console.error('❌ Bot launch error:', err.message));

    console.log('✅ ARIA IS LIVE AND LISTENING');

    bot.telegram.setMyCommands([
        { command: 'issues', description: 'Open issues — blocking-me-first' },
        { command: 'blockers', description: 'Just the blocked subset' },
        { command: 'issue', description: 'Issue detail (paste id from /issues)' },
        { command: 'tasks', description: 'Task hub — approvals + recent work' },
        { command: 'crons', description: 'Cron job status' },
        { command: 'status', description: 'Aria heartbeat / health' },
        { command: 'memory', description: 'Recall a pattern from Pinecone' },
        { command: 'product', description: 'Look up a Finale SKU' },
        { command: 'consumption', description: 'BOM consumption for a SKU' },
        { command: 'builds', description: 'Upcoming calendar builds' },
        { command: 'buildrisk', description: 'Build risk analysis' },
        { command: 'requests', description: 'Slack purchase-request feed' },
        { command: 'kaizen', description: 'Recent corrections / learnings' },
    ]).catch((err: any) => console.warn('setMyCommands failed:', err.message));

    try {
        const { seedMemories } = await import('../lib/intelligence/memory');
        const { seedKnownVendorPatterns } = await import('../lib/intelligence/vendor-memory');
        await Promise.all([seedMemories(), seedKnownVendorPatterns()]);
        console.log('🧠 Memory: ✅ Vendor patterns seeded');
    } catch (err: any) {
        console.warn('⚠️ Memory seed failed (non-fatal):', err.message);
    }

    // watchers
    try {
        const reviewAgent = new APAgent(bot);
        await initAriaReviewWatcher(reviewAgent);
    } catch (err: any) {
        console.warn('[aria-review] Watcher failed to start (non-fatal):', err.message);
    }

    try {
        const sandboxAgent = new APAgent(bot);
        await initSandboxWatcher(sandboxAgent, bot);
    } catch (err: any) {
        console.warn('[sandbox] Watcher failed to start (non-fatal):', err.message);
    }

    // restore approvals
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
    bot.context.opsManager = ops; // inject ops to context for callbacks
    ops.registerJobs();
    startCronRunner();
    console.log('[boot] Cron registry started.');

    // ── HERMIA(2026-05-29): Orchestrator boot wiring ───────────────────
    // Initialize the HermesOrchestrator singleton so:
    //   1) All domain agents transition from "starting" → "healthy"
    //   2) Supabase agent_heartbeats are synced into memory
    //   3) Cron hooks (success/failure) bridge to orchestrator agent registry
    //      (see ops-manager cronHookSuccess/cronHookFailure)
    try {
        const { getOrchestrator } = await import('../lib/intelligence/hermes-orchestrator');
        const orch = getOrchestrator();
        orch.markAllBooted();
        await orch.syncFromSupabase();
        console.log('[boot] HermesOrchestrator: ✅ 24 agents initialized');
    } catch (err: any) {
        console.warn(`[boot] Orchestrator init failed (non-fatal): ${err.message}`);
    }
    // ── End orchestrator wiring ─────────────────────────────────────────

    // ── Boot-time warmup ────────────────────────────────────────────
    // (a) Fix: AP polling shows "stale" after every PM2 restart because
    //     the cron scheduler waits for the first */15 tick. Fire immediately
    //     so ops_health_summary doesn't flag it.
    // (b) Fix: Bot heartbeat starts at "stale" (0 min = 10 min stale threshold)
    //     because heartbeats only fire after cron hook success. Register
    //     a startup heartbeat so control-plane doesn't trigger a restart alert.
    // (c) Nightshift queue backlog — intentionally NOT suppressed. It's
    //     expected during dev iteration and clears itself within a few hours.

    try {
        // Startup heartbeat (writes to agent_heartbeats via oversightAgent)
        await ops.cronHookSuccess("aria-bot-startup");
        console.log('[boot] Startup heartbeat written.');
    } catch (e: any) {
        console.warn(`[boot] startup heartbeat failed (non-fatal): ${e.message}`);
    }

    try {
        // Fire AP polling immediately so it's not "stale" until the next */15 tick
        console.log('[boot] Firing immediate AP poll...');
        await ops.pollAPInbox().catch((e: any) => {
            console.warn(`[boot] immediate AP poll failed (non-fatal): ${e.message}`);
        });
        await ops.cronHookSuccess("ap-polling");
        console.log('[boot] AP polling boot run complete.');
    } catch (e: any) {
        console.warn(`[boot] AP polling boot run failed (non-fatal): ${e.message}`);
    }
    // ── End boot-time warmup ────────────────────────────────────────
    const botDeps = {
        bot,
        finale,
        opsManager: ops,
        chatHistory,
        chatLastActive,
        perplexityKey: perplexityKey || null,
        elevenLabsKey: elevenLabsKey || null,
        botStartTime: BOT_START_TIME,
    };
    registerAllCommands(bot, botDeps);
    startBotControlPlane(ops);

    console.log('📅 Cron schedules registered:');
    console.log('   🐨 Build Risk Report:  7:30 AM MT (Weekdays)');
    console.log('   📊 Daily PO Summary:  8:00 AM MT (Weekdays)');
    console.log('   🗓️   Weekly Review:     8:01 AM MT (Fridays)');
    console.log('   📦 PO Sync:           Every 30 min');
    console.log('   🧹 Ad Cleanup:        Every hour');

    const hcUrl = process.env.HEALTHCHECK_PING_URL;
    if (hcUrl) fetch(hcUrl).catch(() => {});

    // hourly memory monitoring
    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
        console.log(
            `[memory] RSS: ${mb(mem.rss)}MB | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB` +
            ` | External: ${mb(mem.external)}MB | Chats: ${Object.keys(chatHistory).length}`
        );

        const hcUrl = process.env.HEALTHCHECK_PING_URL;
        if (hcUrl) fetch(hcUrl).catch(() => {});
    }, 15 * 60 * 1000);

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
    }, 30 * 60 * 1000);

    // cron health watchdog
    const CRON_WATCHDOG_INTERVAL = 30 * 60 * 1000;
    const CRITICAL_CRONS: { name: string; maxStaleMin: number }[] = [
        { name: 'ap-polling', maxStaleMin: 25 },
        { name: 'po-sync', maxStaleMin: 6 * 60 },
        { name: 'build-completion-watcher', maxStaleMin: 45 },
        { name: 'po-receiving-watcher', maxStaleMin: 45 },
    ];
    let lastCronWatchdogAlert = 0;
    setInterval(async () => {
        try {
            const { createClient } = await import('../lib/supabase');
            const supabase = createClient();
            if (!supabase) return;

            const maxCutoffMin = Math.max(...CRITICAL_CRONS.map(c => c.maxStaleMin));
            const cutoff = new Date(Date.now() - maxCutoffMin * 60 * 1000).toISOString();
            const { data } = await supabase.from('cron_runs')
                .select('task_name, started_at')
                .in('task_name', CRITICAL_CRONS.map(c => c.name))
                .gte('started_at', cutoff)
                .order('started_at', { ascending: false });

            const lastRunByTask = new Map<string, string>();
            for (const row of (data || [])) {
                if (!lastRunByTask.has(row.task_name)) {
                    lastRunByTask.set(row.task_name, row.started_at);
                }
            }
            const now = Date.now();
            const stale = CRITICAL_CRONS.filter(c => {
                const lastRun = lastRunByTask.get(c.name);
                if (!lastRun) return true;
                const ageMin = (now - new Date(lastRun).getTime()) / 60000;
                return ageMin > c.maxStaleMin;
            });

            if (stale.length > 0 && Date.now() - lastCronWatchdogAlert > 60 * 60 * 1000) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    const names = stale.map(s => `${s.name} (>${s.maxStaleMin}m)`).join(', ');
                    await bot.telegram.sendMessage(
                        chatId,
                        `🚨 <b>Cron Watchdog Alert</b>\n\n` +
                        `Stale crons:\n<code>${names}</code>\n\n` +
                        `Possible node-cron heartbeat death. Consider <code>pm2 restart aria-bot</code>.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                    lastCronWatchdogAlert = Date.now();
                    console.warn(`[cron-watchdog] ⚠️ Stale crons detected: ${names}`);
                }
            }
        } catch { /* non-critical */ }
    }, CRON_WATCHDOG_INTERVAL);

})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
