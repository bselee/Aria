/**
 * @file    memory-cmds.ts
 * @purpose Telegram commands for Aria's Pinecone memory: store, search,
 *          seed, and backfill. Named memory-cmds.ts to avoid collision
 *          with the memory.ts library module.
 *          Extracted from start-bot.ts lines ~342-400, ~755-796.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    intelligence/memory, gmail/auth, @googleapis/gmail
 */

import type { BotCommand, BotDeps } from './types';
import { getCmdText } from './types';

/**
 * /remember <text> — Store something in Aria's Pinecone memory.
 */
const rememberCommand: BotCommand = {
    name: 'remember',
    description: 'Store a fact in Aria\'s memory',
    handler: async (ctx, _deps) => {
        const text = getCmdText(ctx).replace(/^\/remember\s*/, '').trim();
        if (!text) {
            return ctx.reply('Usage: `/remember AAACooper sends multi-page invoices as statements`', { parse_mode: 'Markdown' });
        }

        try {
            const { remember } = await import('../../lib/intelligence/memory');
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
    },
};

/**
 * /recall <query> — Search Aria's Pinecone memory.
 */
const recallCommand: BotCommand = {
    name: 'recall',
    description: 'Search Aria\'s memory',
    handler: async (ctx, _deps) => {
        const query = getCmdText(ctx).replace(/^\/recall\s*/, '').trim();
        if (!query) {
            return ctx.reply('Usage: `/recall AAACooper invoices`', { parse_mode: 'Markdown' });
        }

        ctx.sendChatAction('typing');
        try {
            const { recall } = await import('../../lib/intelligence/memory');
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
    },
};

/**
 * /seed — Initialize Aria's memory with known vendor patterns.
 */
const seedCommand: BotCommand = {
    name: 'seed',
    description: 'Seed memory with vendor patterns',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        try {
            const { seedMemories } = await import('../../lib/intelligence/memory');
            await seedMemories();
            await ctx.reply('🌱 ✅ Memory seeded with known vendor patterns and processes.');
        } catch (err: any) {
            ctx.reply(`❌ Seed error: ${err.message}`);
        }
    },
};

/**
 * /populate — PO Memory Backfill: index last 2 weeks of PO threads from Gmail.
 */
const populateCommand: BotCommand = {
    name: 'populate',
    description: 'Backfill PO memory from Gmail',
    handler: async (ctx, _deps) => {
        ctx.reply("🧠 Starting PO Memory Backfill (Last 2 Weeks)... This will take a moment.");
        try {
            const { processEmailAttachments } = require('../../lib/gmail/attachment-handler');
            const { getAuthenticatedClient } = await import('../../lib/gmail/auth');
            const { gmail: GmailApi } = await import('@googleapis/gmail');
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

                const { indexOperationalContext } = require('../../lib/intelligence/pinecone');
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
    },
};

export const memoryCommands: BotCommand[] = [
    rememberCommand,
    recallCommand,
    seedCommand,
    populateCommand,
];
