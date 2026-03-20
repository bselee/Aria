/**
 * @file    status.ts
 * @purpose Telegram commands for system status, diagnostics, and lifecycle.
 *          Extracted from start-bot.ts lines ~159-266, ~896-910.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    telegraf
 */

import type { BotCommand, BotDeps } from './types';
import { getProviderStatus } from '../../lib/intelligence/llm';

/**
 * /status — Full runtime status report: uptime, integrations,
 *           LLM chain health, and recent conversation context.
 */
const statusCommand: BotCommand = {
    name: 'status',
    description: 'Show Aria runtime status and integration health',
    handler: async (ctx, deps) => {
        const chatId = ctx.from?.id || ctx.chat!.id;
        const uptimeMs = Date.now() - deps.botStartTime.getTime();
        const uptimeMin = Math.floor(uptimeMs / 60000);
        const uptimeHrs = Math.floor(uptimeMin / 60);
        const uptimeStr = uptimeHrs > 0
            ? `${uptimeHrs}h ${uptimeMin % 60}m`
            : `${uptimeMin}m`;

        const historyLen = deps.chatHistory[chatId]?.length || 0;

        // Check Supabase connectivity
        let dbStatus = '❓ Not checked';
        try {
            const { createClient } = await import('../../lib/supabase');
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
            const { recall } = await import('../../lib/intelligence/memory');
            const mems = await recall('vendor', { topK: 1 });
            memStatus = mems.length > 0 ? `✅ ${mems.length} result(s) (seeded)` : '⚠️ No memories (run /seed)';
        } catch (e: any) {
            memStatus = `❌ ${e.message}`;
        }

        const recentHistory = (deps.chatHistory[chatId] || [])
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
            `🚀 Started: \`${deps.botStartTime.toLocaleTimeString('en-US', { timeZone: 'America/Denver' })} MT\`\n\n` +
            `*Integrations:*\n` +
            `🤖 Chat LLM: ✅ Gemini 2.0 Flash (free)\n` +
            `🗄️ Supabase: ${dbStatus}\n` +
            `🧠 Memory (Pinecone): ${memStatus}\n` +
            `📦 Finale: ${process.env.FINALE_API_KEY ? '✅ Connected' : '❌ Not configured'}\n` +
            `🔍 Perplexity: ${deps.perplexityKey ? '✅ Ready' : '❌ Not configured'}\n` +
            `🦊 Slack Watchdog: ${deps.watchdog ? '✅ Running' : '❌ Not started'}\n` +
            `🎙️ Voice: ${deps.elevenLabsKey ? '✅ ElevenLabs' : '❌ Not configured'}\n\n` +
            `*🧠 Background LLM Chain:*\n` +
            `${llmHealthLines}\n\n` +
            `*Conversation:*\n` +
            `💬 History: \`${historyLen} messages\` in context\n` +
            `${recentHistory}\n\n` +
            `_/clear to reset conversation context_`,
            { parse_mode: 'Markdown' }
        );
    },
};

/**
 * /clear — Reset conversation history for the current chat.
 */
const clearCommand: BotCommand = {
    name: 'clear',
    description: 'Reset conversation context',
    handler: async (ctx, deps) => {
        const chatId = ctx.from?.id || ctx.chat!.id;
        const count = deps.chatHistory[chatId]?.length || 0;
        deps.chatHistory[chatId] = [];
        delete deps.chatLastActive[chatId];
        ctx.reply(`🗑️ Cleared ${count} messages from context. Fresh start.`, { parse_mode: 'Markdown' });
    },
};

/**
 * /memory — On-demand memory diagnostics for OOM debugging.
 *
 * DECISION(2026-03-09): Surfaces RSS, heap, and cache sizes so Will can
 * spot memory trends without SSH-ing into the server.
 */
const memoryCommand: BotCommand = {
    name: 'memory',
    description: 'Show process memory diagnostics',
    handler: async (ctx, deps) => {
        const mem = process.memoryUsage();
        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
        const chatKeys = Object.keys(deps.chatHistory).length;
        const totalMsgs = Object.values(deps.chatHistory).reduce((s, arr) => s + arr.length, 0);

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
            `⌛ *Uptime:* \`${((Date.now() - deps.botStartTime.getTime()) / 3_600_000).toFixed(1)}h\``,
        ];

        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    },
};

/**
 * /crons — Show status of all scheduled cron tasks via the centralized CronRegistry.
 *
 * DECISION(2026-03-19): Upgraded to use centralized cron-registry.ts which
 * provides categorized output with descriptions instead of a flat list.
 */
const cronsCommand: BotCommand = {
    name: 'crons',
    description: 'Show status of all scheduled cron jobs',
    handler: async (ctx, deps) => {
        ctx.sendChatAction('typing');

        const report = deps.opsManager.getCronStatusReport();

        // Telegram message limit is 4096 chars
        const msg = report.length > 4000
            ? report.slice(0, 3990) + '\n\n<i>...truncated</i>'
            : report;

        await ctx.reply(msg, { parse_mode: 'HTML' });
    },
};

export const statusCommands: BotCommand[] = [
    statusCommand,
    clearCommand,
    memoryCommand,
    cronsCommand,
];
