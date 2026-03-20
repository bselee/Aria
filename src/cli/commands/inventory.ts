/**
 * @file    inventory.ts
 * @purpose Telegram commands for Finale Inventory lookups, consumption,
 *          build simulation, and build completion history.
 *          Extracted from start-bot.ts lines ~268-455, ~590-651.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    finale-client, supabase, build-risk
 */

import type { BotCommand, BotDeps } from './types';
import { getCmdText } from './types';

/**
 * /product <SKU> — Look up a product in Finale Inventory.
 * Returns on-hand stock, PO status, demand velocity, and BOM breakdown.
 */
const productCommand: BotCommand = {
    name: 'product',
    description: 'Look up a product in Finale',
    handler: async (ctx, deps) => {
        const sku = getCmdText(ctx).replace('/product', '').trim();

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
            const report = await deps.finale.productReport(sku);
            await ctx.reply(report.telegramMessage, {
                parse_mode: 'Markdown',
                // @ts-ignore — Telegraf types don't include disable_web_page_preview
                disable_web_page_preview: true,
            });
        } catch (err: any) {
            console.error(`Product lookup error for ${sku}:`, err.message);
            ctx.reply(`❌ Error looking up \`${sku}\`: ${err.message}`);
        }
    },
};

/**
 * /receivings — Post today's received POs to Telegram + Slack #purchasing.
 */
const receivingsCommand: BotCommand = {
    name: 'receivings',
    description: 'Show today\'s received POs',
    handler: async (ctx, deps) => {
        ctx.sendChatAction('typing');

        try {
            const received = await deps.finale.getTodaysReceivedPOs();
            const digest = deps.finale.formatReceivingsDigest(received);

            // Send to Telegram (convert Slack mrkdwn to Telegram Markdown)
            const telegramMsg = digest
                .replace(/:package:/g, '📦')
                .replace(/:white_check_mark:/g, '✅')
                .replace(/<([^|]+)\|([^>]+)>/g, '[$2]($1)');

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
    },
};

/**
 * /consumption <SKU> [days] — BOM consumption report for raw material SKUs.
 */
const consumptionCommand: BotCommand = {
    name: 'consumption',
    description: 'Show BOM consumption for a SKU',
    handler: async (ctx, deps) => {
        const args = getCmdText(ctx).replace(/^\/consumption\s*/, '').trim().split(/\s+/);
        const sku = args[0];
        const days = parseInt(args[1]) || 90;

        if (!sku) {
            return ctx.reply('Usage: `/consumption 3.0BAGCF` or `/consumption 3.0BAGCF 60`\n_Default: last 90 days_', { parse_mode: 'Markdown' });
        }

        ctx.sendChatAction('typing');
        await ctx.reply(`👀📊 Pulling consumption data for \`${sku}\` (last ${days} days)...`, { parse_mode: 'Markdown' });

        try {
            const report = await deps.finale.getBOMConsumption(sku, days);
            await ctx.reply(report.telegramMessage, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error('Consumption error:', err.message);
            await ctx.reply(`❌ Failed to get consumption for \`${sku}\`: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

/**
 * /simulate (or /build) — Simulate a production build explosion.
 * Shows component requirements and stock availability.
 */
const simulateCommand: BotCommand = {
    name: ['simulate', 'build'],
    description: 'Simulate a production build explosion',
    handler: async (ctx, deps) => {
        const rawArgs = getCmdText(ctx).split(' ');
        rawArgs.shift(); // Remove the command part

        const argsStr = rawArgs.join(' ').replace(/=|x|X/g, ' ').trim();
        const cleanArgs = argsStr.split(/\s+/).filter(Boolean);

        const sku = cleanArgs[0];
        const qty = parseInt(cleanArgs[1]) || 1;

        if (!sku || isNaN(qty)) {
            return ctx.reply('Usage: `/simulate CRAFT8 15` or `/build CRAFT8 = 15`', { parse_mode: 'Markdown' });
        }

        ctx.sendChatAction('typing');
        try {
            const { simulateBuild } = await import('../../lib/builds/build-risk');
            const report = await simulateBuild(sku, qty, (msg) => {
                console.log(`[simulate] ${msg}`);
            });
            await ctx.reply(report, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error('Simulation error:', err.message);
            await ctx.reply(`❌ Simulation failed for \`${sku}\`: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

/**
 * /builds [days] — Show completed builds from the last N days.
 * Default: last 24 hours.
 */
const buildsCommand: BotCommand = {
    name: 'builds',
    description: 'Show recent completed builds',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');

        const args = getCmdText(ctx).replace(/^\/builds\s*/, '').trim();
        const days = Math.min(Math.max(parseInt(args) || 1, 1), 30);

        try {
            const { createClient } = await import('../../lib/supabase');
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

            for (const [dateStr, rows] of Array.from(byDate)) {
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
    },
};

/**
 * /stock <SKU> — Alias for /product (kept for discovery).
 * Could be extended with quick-view formatting in the future.
 */

export const inventoryCommands: BotCommand[] = [
    productCommand,
    receivingsCommand,
    consumptionCommand,
    simulateCommand,
    buildsCommand,
];
