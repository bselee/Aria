import type { BotCommand } from './types';
import { getCmdText } from './types';
import {
    addSlackReaction,
    completeTrackedSlackRequestManually,
    listTrackedSlackRequests,
} from '../../lib/slack/request-tracker';

const buildriskCommand: BotCommand = {
    name: 'buildrisk',
    description: 'Run 30-day build risk analysis',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('Running 30-day build risk analysis...', { parse_mode: 'Markdown' });

        try {
            const { runBuildRiskAnalysis } = await import('../../lib/builds/build-risk');
            const report = await runBuildRiskAnalysis(30, (msg) => {
                console.log(`[buildrisk] ${msg}`);
            });

            await ctx.reply(report.telegramMessage, { parse_mode: 'Markdown' });

            setImmediate(async () => {
                const { saveBuildRiskSnapshot } = await import('../../lib/builds/build-risk-logger');
                await saveBuildRiskSnapshot(report);

                try {
                    const { generateReorderPrescriptions, formatPrescriptionsTelegram } = await import('../../lib/builds/reorder-engine');
                    const { createClient } = await import('../../lib/supabase');
                    const prescriptions = await generateReorderPrescriptions(report.components, report.fgVelocity);

                    if (prescriptions.length === 0) return;

                    const db = createClient();
                    const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                    const { data: recent } = db
                        ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff)
                        : { data: [] };

                    const recentSet = new Set((recent ?? []).map((row: any) => `${row.sku}:${row.risk_level}`));
                    const fresh = prescriptions.filter((p) => !recentSet.has(`${p.componentSku}:${p.riskLevel}`));

                    if (fresh.length === 0) {
                        await ctx.reply('_Smart reorder alerts already sent recently._', { parse_mode: 'Markdown' });
                        return;
                    }

                    await ctx.reply(formatPrescriptionsTelegram(fresh), { parse_mode: 'Markdown' });

                    if (db) {
                        await db.from('proactive_alerts').upsert(
                            fresh.map((p) => ({
                                sku: p.componentSku,
                                alert_type: 'reorder',
                                risk_level: p.riskLevel,
                                stockout_days: p.stockoutDays,
                                suggested_order_qty: p.suggestedOrderQty,
                                days_after_order: p.daysAfterOrder,
                                alerted_at: new Date().toISOString(),
                            })),
                            { onConflict: 'sku,alert_type' },
                        );
                    }
                } catch (err: any) {
                    console.warn('[buildrisk/prescriptions] non-fatal:', err.message);
                }
            });

            if (report.unrecognizedSkus.length > 0) {
                let askMsg = `*I couldn't find these SKUs in Finale:*\n\n`;
                for (const item of report.unrecognizedSkus) {
                    askMsg += `- \`${item.sku}\` (${item.totalQty} units, needed ${item.earliestDate})\n`;
                    if (item.suggestions.length > 0) {
                        askMsg += `  Similar items found: ${item.suggestions.slice(0, 3).map((s) => `\`${s}\``).join(', ')}\n`;
                    }
                    askMsg += `\n`;
                }
                await ctx.reply(askMsg, { parse_mode: 'Markdown' });
            }

            if (process.env.SLACK_BOT_TOKEN) {
                try {
                    const { WebClient } = await import('@slack/web-api');
                    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
                    await slack.chat.postMessage({
                        channel: '#purchasing',
                        text: report.slackMessage,
                        mrkdwn: true,
                    });
                    await ctx.reply('_Also posted to Slack #purchasing_', { parse_mode: 'Markdown' });
                } catch (slackErr: any) {
                    console.error('Slack post error:', slackErr.message);
                }
            }
        } catch (err: any) {
            console.error('Build risk error:', err.message);
            await ctx.reply(`Build risk analysis failed: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

const requestsCommand: BotCommand = {
    name: 'requests',
    description: 'Show Slack product requests',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');

        try {
            const tracked = await listTrackedSlackRequests();

            if (
                tracked.open.length === 0 &&
                tracked.recentCompletedAuto.length === 0 &&
                tracked.recentCompletedManual.length === 0
            ) {
                await ctx.reply(
                    `*Slack Request Tracker*\n\n` +
                    `No tracked Slack requests right now.\n\n` +
                    `Monitoring: #purchasing, #purchase-orders, DMs\n` +
                    `Thread replies: included\n` +
                    `_Requests will show here once Aria starts tracking them durably._`,
                    { parse_mode: 'Markdown' },
                );
                return;
            }

            const sections: string[] = ['*Slack Request Tracker*'];

            if (tracked.open.length > 0) {
                sections.push(
                    `*Open Requests*\n${tracked.open.map((req) =>
                        `- *${req.requester_name}* in #${req.channel_name}\n` +
                        `  ${req.original_text}\n` +
                        `  SKU(s): ${(req.matched_skus ?? []).map((sku) => `\`${sku}\``).join(', ') || '_unresolved_'}\n` +
                        `  ID: \`${req.id}\``
                    ).join('\n\n')}`,
                );
            }

            if (tracked.recentCompletedAuto.length > 0) {
                sections.push(
                    `*Recently Auto-Completed*\n${tracked.recentCompletedAuto.map((req) =>
                        `- *${req.requester_name}* in #${req.channel_name}\n` +
                        `  SKU(s): ${(req.matched_skus ?? []).map((sku) => `\`${sku}\``).join(', ') || '_unresolved_'}\n` +
                        `  PO(s): ${(req.completion_po_numbers ?? []).join(', ')}`
                    ).join('\n\n')}`,
                );
            }

            if (tracked.recentCompletedManual.length > 0) {
                sections.push(
                    `*Recently Completed Manually*\n${tracked.recentCompletedManual.map((req) =>
                        `- *${req.requester_name}* in #${req.channel_name}\n` +
                        `  SKU(s): ${(req.matched_skus ?? []).map((sku) => `\`${sku}\``).join(', ') || '_unresolved_'}\n` +
                        `  PO(s): ${(req.completion_po_numbers ?? []).join(', ') || '_manual override_'}`
                    ).join('\n\n')}`,
                );
            }

            sections.push(`_Channels: #purchasing, #purchase-orders, DMs + thread replies_`);
            await ctx.reply(sections.join('\n\n'), { parse_mode: 'Markdown' });
        } catch (err: any) {
            await ctx.reply(`Error: ${err.message}`);
        }
    },
};

const requestCompleteCommand: BotCommand = {
    name: 'requestcomplete',
    description: 'Manually mark a tracked Slack request complete',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');

        const requestId = getCmdText(ctx).split(' ').slice(1).join(' ').trim();
        if (!requestId) {
            await ctx.reply('Usage: /requestcomplete <request_id>', { parse_mode: 'Markdown' });
            return;
        }

        try {
            const request = await completeTrackedSlackRequestManually(requestId);
            await addSlackReaction({
                channelId: request.channel_id,
                messageTs: request.message_ts,
                reaction: 'white_check_mark',
            });

            await ctx.reply(
                `Request \`${request.id}\` for *${request.requester_name}* marked complete.`,
                { parse_mode: 'Markdown' },
            );
        } catch (err: any) {
            await ctx.reply(`Failed: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

const alertsCommand: BotCommand = {
    name: 'alerts',
    description: 'Show recent reorder alerts',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        try {
            const { createClient } = await import('../../lib/supabase');
            const db = createClient();
            if (!db) return ctx.reply('Supabase not configured.');

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
            await ctx.reply(`Error fetching alerts: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

const correlateCommand: BotCommand = {
    name: 'correlate',
    description: 'Run PO to Invoice correlation',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('Running cross-inbox PO correlation...', { parse_mode: 'Markdown' });

        try {
            const { runCorrelationPipeline } = await import('../../lib/intelligence/po-correlator');
            const result = await runCorrelationPipeline();
            const report = result.formattedReport;

            if (report.length <= 4000) {
                await ctx.reply(report, { parse_mode: 'Markdown' });
                return;
            }

            const lines = report.split('\n');
            let chunk = '';
            for (const line of lines) {
                if (chunk.length + line.length > 3900) {
                    await ctx.reply(chunk, { parse_mode: 'Markdown' });
                    chunk = '';
                }
                chunk += line + '\n';
            }
            if (chunk.trim()) {
                await ctx.reply(chunk, { parse_mode: 'Markdown' });
            }
        } catch (err: any) {
            console.error('Correlation error:', err.message);
            await ctx.reply(`Correlation failed: ${err.message}`, { parse_mode: 'Markdown' });
        }
    },
};

const notifyCommand: BotCommand = {
    name: 'notify',
    description: 'Send Amazon order update to Slack requester',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');

        const requestId = getCmdText(ctx).split(' ').slice(1).join(' ').trim();
        if (!requestId) {
            await ctx.reply('Usage: /notify <request_id>');
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

            const items = (req.amazon_items || [])
                .map((item: any) => `  ${item.quantity}x ${item.name}${item.price ? ` ($${item.price.toFixed(2)})` : ''}`)
                .join('\n');

            let slackMessage = '';
            if (req.status === 'shipped' && req.tracking_number) {
                slackMessage = `Your order has shipped.\n\n`;
                slackMessage += `Order: ${req.amazon_order_id}\n`;
                if (req.carrier) slackMessage += `Carrier: ${req.carrier}\n`;
                slackMessage += `Tracking: ${req.tracking_number}\n`;
                if (req.estimated_delivery) {
                    const eta = new Date(req.estimated_delivery).toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
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
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        timeZone: 'America/Denver',
                    });
                    slackMessage += `Expected delivery: ${eta}\n`;
                }
                if (items) slackMessage += `\nItems:\n${items}\n`;
            }

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
    requestCompleteCommand,
    alertsCommand,
    correlateCommand,
    notifyCommand,
];
