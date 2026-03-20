/**
 * @file    operations.ts
 * @purpose Telegram commands for operational intelligence: build risk analysis,
 *          PO correlation, proactive alerts, Slack request tracking, and
 *          Amazon order notification approval.
 *          Extracted from start-bot.ts lines ~457-587, ~653-705, ~912-1012.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    build-risk, reorder-engine, po-correlator, supabase, @slack/web-api
 */

import type { BotCommand, BotDeps } from './types';
import { getCmdText } from './types';

/**
 * /buildrisk — 30-day build risk analysis (Calendar → BOM → Stock + POs).
 * Fires off smart reorder prescriptions as a side effect.
 */
const buildriskCommand: BotCommand = {
    name: 'buildrisk',
    description: 'Run 30-day build risk analysis',
    handler: async (ctx, deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('🏭 Running 30-Day Build Risk Analysis...\n_Fetching calendars, parsing builds, exploding BOMs, checking stock + POs (now 5x parallel)..._', { parse_mode: 'Markdown' });

        try {
            const { runBuildRiskAnalysis } = await import('../../lib/builds/build-risk');
            const report = await runBuildRiskAnalysis(30, (msg) => {
                console.log(`[buildrisk] ${msg}`);
            });

            await ctx.reply(report.telegramMessage, { parse_mode: 'Markdown' });

            // Persist snapshot + generate smart reorder prescriptions (fire-and-forget)
            setImmediate(async () => {
                const { saveBuildRiskSnapshot } = await import('../../lib/builds/build-risk-logger');
                await saveBuildRiskSnapshot(report);

                // Smart prescriptions: only send if not alerted in last 20h
                try {
                    const { generateReorderPrescriptions, formatPrescriptionsTelegram } = await import('../../lib/builds/reorder-engine');
                    const { createClient } = await import('../../lib/supabase');
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
    },
};

/**
 * /requests — Show recent Slack product requests detected by the watchdog.
 */
const requestsCommand: BotCommand = {
    name: 'requests',
    description: 'Show Slack product requests',
    handler: async (ctx, deps) => {
        ctx.sendChatAction('typing');

        try {
            const pending = deps.watchdog?.getRecentRequests() || [];

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
    },
};

/**
 * /alerts — Show recent smart reorder/build prescriptions from the last 24 hours.
 */
const alertsCommand: BotCommand = {
    name: 'alerts',
    description: 'Show recent reorder alerts',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        try {
            const { createClient } = await import('../../lib/supabase');
            const db = createClient();
            if (!db) return ctx.reply('❌ Supabase not configured.');

            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await db
                .from('proactive_alerts')
                .select('sku,risk_level,stockout_days,suggested_order_qty,days_after_order,alerted_at')
                .gte('alerted_at', since)
                .order('alerted_at', { ascending: false });

            if (error) throw new Error(error.message);

            const { formatAlertsDigest } = await import('../../lib/builds/reorder-engine');
            await ctx.reply(formatAlertsDigest(data ?? []), { parse_mode: 'Markdown' });
        } catch (err: any) {
            await ctx.reply(`❌ Error fetching alerts: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

/**
 * /correlate — Cross-inbox PO ↔ Invoice correlation and vendor intelligence.
 */
const correlateCommand: BotCommand = {
    name: 'correlate',
    description: 'Run PO ↔ Invoice correlation',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('🔗 Running cross-inbox PO correlation...\n_Scanning bill.selee label:PO → matching with AP invoices_', { parse_mode: 'Markdown' });

        try {
            const { runCorrelationPipeline } = await import('../../lib/intelligence/po-correlator');
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
    },
};

/**
 * /notify <request_id> — Approve sending an Amazon order update to the Slack requester.
 *
 * DECISION(2026-03-19): Manual review gate before any Slack notification.
 * Will reviews the Amazon order match on Telegram and approves with /notify.
 */
const notifyCommand: BotCommand = {
    name: 'notify',
    description: 'Send Amazon order update to Slack requester',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');

        const requestId = getCmdText(ctx).split(' ').slice(1).join(' ').trim();
        if (!requestId) {
            await ctx.reply('Usage: /notify <request_id>\n\nCopy the ID from an Amazon order notification.');
            return;
        }

        try {
            const { createClient } = await import('../../lib/supabase');
            const supabase = createClient();
            if (!supabase) {
                await ctx.reply('Database unavailable.');
                return;
            }

            const { data: req, error } = await supabase
                .from('slack_requests')
                .select('*')
                .eq('id', requestId)
                .single();

            if (error || !req) {
                await ctx.reply(`Request not found: ${requestId}`);
                return;
            }

            if (req.notified_at) {
                await ctx.reply(`Already notified on ${new Date(req.notified_at).toLocaleString('en-US', { timeZone: 'America/Denver' })}`);
                return;
            }

            if (req.channel_id === 'unmatched') {
                await ctx.reply('This order has no matched Slack request. Nothing to notify.');
                return;
            }

            // Build the Slack message — factual, no emojis, precise
            const items = (req.amazon_items || [])
                .map((i: any) => `  ${i.quantity}x ${i.name}${i.price ? ` ($${i.price.toFixed(2)})` : ''}`)
                .join('\n');

            let slackMessage = '';
            if (req.status === 'shipped' && req.tracking_number) {
                slackMessage = `Your order has shipped.\n\n`;
                slackMessage += `Order: ${req.amazon_order_id}\n`;
                if (req.carrier) slackMessage += `Carrier: ${req.carrier}\n`;
                slackMessage += `Tracking: ${req.tracking_number}\n`;
                if (req.estimated_delivery) {
                    const eta = new Date(req.estimated_delivery).toLocaleDateString('en-US', {
                        weekday: 'long', month: 'long', day: 'numeric',
                        timeZone: 'America/Denver',
                    });
                    slackMessage += `Expected delivery: ${eta}\n`;
                }
                if (items) slackMessage += `\nItems:\n${items}\n`;
            } else {
                slackMessage = `Your order has been placed.\n\n`;
                slackMessage += `Order: ${req.amazon_order_id}\n`;
                if (req.estimated_delivery) {
                    const eta = new Date(req.estimated_delivery).toLocaleDateString('en-US', {
                        weekday: 'long', month: 'long', day: 'numeric',
                        timeZone: 'America/Denver',
                    });
                    slackMessage += `Expected delivery: ${eta}\n`;
                }
                if (items) slackMessage += `\nItems:\n${items}\n`;
            }

            // Send to Slack in the original thread
            const slackToken = process.env.SLACK_BOT_TOKEN;
            if (!slackToken) {
                await ctx.reply('SLACK_BOT_TOKEN not configured.');
                return;
            }

            const { WebClient } = await import('@slack/web-api');
            const slack = new WebClient(slackToken);

            await slack.chat.postMessage({
                channel: req.channel_id,
                text: slackMessage,
                thread_ts: req.thread_ts || req.message_ts,
            });

            // Mark as notified
            await supabase
                .from('slack_requests')
                .update({ notified_at: new Date().toISOString() })
                .eq('id', requestId);

            await ctx.reply(`Sent to ${req.requester_name} in Slack.`);
        } catch (err: any) {
            await ctx.reply(`Failed: ${err.message}`);
        }
    },
};

export const operationsCommands: BotCommand[] = [
    buildriskCommand,
    requestsCommand,
    alertsCommand,
    correlateCommand,
    notifyCommand,
];
