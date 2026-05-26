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
import * as fs from 'fs';
import * as path from 'path';

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

 /**
  * /purchases — Run purchasing intelligence pipeline on-demand.
  * Runs the separate run-purchase-assessment.ts subprocess.
  */
 const purchasesCommand: BotCommand = {
     name: 'purchases',
     description: 'Run purchasing intelligence pipeline on-demand',
     handler: async (ctx, _deps) => {
         await ctx.reply('🔍 Starting purchase assessment pipeline... This may take a few minutes.');
         const { exec } = await import('child_process');
         const { promisify } = await import('util');
         const execAsync = promisify(exec);
         try {
             await execAsync('node --import tsx src/cli/run-purchase-assessment.ts', { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
             await ctx.reply('✅ Pipeline triggered. You will receive a Telegram digest when complete.');
         } catch (err: any) {
             await ctx.reply(`❌ Failed to start pipeline: ${err.message}`);
         }
     },
 };

 /**
  * /vendor — Run vendor-specific sync/reconcile commands.
  */
 const vendorCommand: BotCommand = {
     name: 'vendor',
     description: 'Reconcile vendor order confirmations against Finale POs',
     handler: async (ctx, _deps) => {
         const { exec: _exec } = await import('child_process');
         const { promisify: _promisify } = await import('util');
         const execAsync = _promisify(_exec);

         const args = getCmdText(ctx).split(' ').slice(1);
         const [vendor, ...flags] = args;
         const dryRun = flags.includes('--dry-run');
         const scrapeOnly = flags.includes('--scrape-only');
         const updateOnly = flags.includes('--update-only');
         const poFlag = flags.includes('--po') ? flags[flags.indexOf('--po') + 1] : null;
         const csvFlag = flags.includes('--csv') ? flags[flags.indexOf('--csv') + 1] : null;
         const limitFlag = flags.includes('--limit') ? flags[flags.indexOf('--limit') + 1] : null;

         const VENDORS: Record<string, { script: string; label: string; needsChrome?: boolean; needsCsv?: boolean }> = {
             uline:     { script: 'src/cli/order-uline.ts',          label: 'ULINE' },
             axiom:     { script: 'src/cli/reconcile-axiom.ts',      label: 'Axiom Print', needsChrome: true },
             fedex:     { script: 'src/cli/reconcile-fedex.ts',       label: 'FedEx', needsCsv: true },
             teraganix: { script: 'src/cli/reconcile-teraganix.ts',   label: 'TeraGanix' },
             aaa:       { script: 'src/cli/reconcile-aaa.ts',         label: 'AAA Cooper' },
         };

         const FLAG_HINTS: Record<string, string> = {
             uline:     '--dry-run --scrape-only --update-only --po <id>',
             axiom:     '--dry-run --scrape-only --update-only --po <id>',
             fedex:     '--dry-run --csv <path>',
             teraganix: '--dry-run',
             aaa:       '--dry-run --scrape-only --limit <N>',
         };

         if (!vendor) {
             const rows = Object.entries(VENDORS).map(([key, v]) => {
                 return `/vendor ${key.padEnd(10)} — ${v.label.padEnd(12)} [${FLAG_HINTS[key]}]`;
             }).join('\n');
             await ctx.reply(
                 `🛒 <b>Vendor Commands</b>\n\n` +
                 `${rows}\n\n` +
                 `Also: <code>/received</code> — sweep received POs for invoice matches\n` +
                 `Also: <code>/uline</code> — ULINE pre-check + order\n` +
                 `Also: <code>/ulinetest &lt;po&gt;</code> — test ULINE flow against a specific PO\n\n` +
                 `<i>Flags: --dry-run | --scrape-only | --update-only | --po &lt;id&gt; | --csv &lt;path&gt;</i>`,
                 { parse_mode: 'HTML' }
             );
             return;
         }

         const key = vendor.toLowerCase();
         const entry = VENDORS[key];
         if (!entry) {
             await ctx.reply(`❌ Unknown vendor: <b>${vendor}</b>\n\nTry: <code>/vendor</code> to see available vendors.`, { parse_mode: 'HTML' });
             return;
         }

         // AAA Cooper — extract invoices from ap@ Gmail, forward each to Bill.com
         if (key === 'aaa') {
             const extraFlags: string[] = [];
             if (dryRun) extraFlags.push('--dry-run');
             if (scrapeOnly) extraFlags.push('--scrape-only');
             if (limitFlag) extraFlags.push('--limit', limitFlag);
             const flagStr = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : '';
             const cmd = `node --import tsx src/cli/reconcile-aaa.ts${flagStr}`;
             await ctx.reply('🔄 Running <b>AAA Cooper</b> invoice extraction…\n<i>Scans ap@buildasoil.com, splits statement PDFs, forwards invoices to Bill.com.</i>', { parse_mode: 'HTML' });
             try {
                 const { stdout, stderr } = await execAsync(cmd, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
                 const out = (stdout || '').slice(-2000);
                 const errOut = (stderr || '').slice(-500);
                 const summary = out || errOut || 'No output';
                 await ctx.reply(`✅ <b>AAA Cooper Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`, { parse_mode: 'HTML', disable_web_page_preview: true });
             } catch (err: any) {
                 const out = (err.stdout || '').slice(-1500);
                 const errOut = (err.stderr || '').slice(-500);
                 await ctx.reply(`⚠️ <b>AAA Cooper Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`, { parse_mode: 'HTML', disable_web_page_preview: true });
             }
             return;
         }

         // Build flags list per vendor
         const extraFlags: string[] = [];
         if (dryRun && ['uline', 'axiom', 'fedex', 'teraganix', 'aaa'].includes(key)) extraFlags.push('--dry-run');
         if (scrapeOnly && ['uline', 'axiom', 'aaa'].includes(key)) extraFlags.push('--scrape-only');
         if (updateOnly && ['uline', 'axiom'].includes(key)) extraFlags.push('--update-only');
         if (poFlag && ['uline', 'axiom'].includes(key)) extraFlags.push('--po', poFlag);
         if (csvFlag && key === 'fedex') extraFlags.push('--csv', csvFlag);

         const flagStr = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : '';
         const cmd = `node --import tsx ${entry.script}${flagStr}`;

         const chromeNote = entry.needsChrome ? '\n⚠️ <i>Close Chrome before running (Playwright).</i>' : '';
         const csvNote = entry.needsCsv ? '\n📎 <i>Auto-finds latest CSV in Sandbox if --csv omitted.</i>' : '';

         await ctx.reply(`🔄 Running <b>${entry.label}</b>…${chromeNote}${csvNote}`, { parse_mode: 'HTML' });

         try {
             const { stdout, stderr } = await execAsync(cmd, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
             const out = (stdout || '').slice(-2000);
             const errOut = (stderr || '').slice(-500);
             const summary = out || errOut || 'No output';
             await ctx.reply(
                 `✅ <b>${entry.label} Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`,
                 { parse_mode: 'HTML', disable_web_page_preview: true }
             );
         } catch (err: any) {
             const out = (err.stdout || '').slice(-1500);
             const errOut = (err.stderr || '').slice(-500);
             await ctx.reply(
                 `⚠️ <b>${entry.label} Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`,
                 { parse_mode: 'HTML', disable_web_page_preview: true }
             );
         }
     }
 };

 /**
  * /uline — Run ULINE precheck.
  */
 const ulineCommand: BotCommand = {
     name: 'uline',
     description: 'Check ULINE Friday pre-checks and show manifest',
     handler: async (ctx, deps) => {
         await ctx.reply('🔍 Checking ULINE status…');
         const ops = deps.opsManager;
         if (!ops) {
             await ctx.reply('OpsManager not initialized.');
             return;
         }
         const { runFridayUlinePreCheck } = await import('../order-uline');
         const { FinaleClient } = await import('../../lib/finale/client');
         const finale = new FinaleClient();

         let preCheck: Awaited<ReturnType<typeof runFridayUlinePreCheck>>;
         try {
              preCheck = await runFridayUlinePreCheck(finale);
         } catch (err: any) {
              await ctx.reply(`❌ Pre-check failed: ${err.message}`);
              return;
         }

         const account = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';

         if (preCheck.reason === 'recent_po_exists') {
              const po = preCheck.recentDraftPO!;
              const poUrl = `https://app.finaleinventory.com/${account}/purchaseOrder?orderId=${po.orderId}`;
              await ctx.reply(
                  `✅ <b>ULINE Status</b>\n\n` +
                  `Draft PO <a href="${poUrl}">#${po.orderId}</a> ` +
                  `created ${new Date(po.orderDate).toLocaleDateString('en-US', { timeZone: 'America/Denver' })}.\n` +
                  `A ULINE order may already be in progress — review the PO and cart.`,
                  { parse_mode: 'HTML' }
              );
              return;
         }

         if (preCheck.reason === 'no_items_needed') {
              await ctx.reply(
                  `✅ <b>ULINE Status</b>\n\n` +
                  `All ULINE items are above reorder threshold.\n` +
                  `No order needed.`,
                  { parse_mode: 'HTML' }
              );
              return;
         }

         const manifest = preCheck.manifest;
         const itemLines = manifest.items
              .slice(0, 15)
              .map((i: any) => {
                  const qtyLabel = i.finaleEachQuantity === i.effectiveEachQuantity
                      ? `${i.quantity}`
                      : `${i.quantity} <i>(→ ${i.effectiveEachQuantity} ea)</i>`;
                  return `  <code>${i.ulineModel}</code> × ${qtyLabel}  ($${(i.quantity * i.unitPrice).toFixed(2)})`;
              })
              .join('\n');
         const more = manifest.items.length > 15 ? `\n  <i>…and ${manifest.items.length - 15} more items</i>` : '';

         const skippedNote = manifest.skippedLowVelocity && manifest.skippedLowVelocity.length > 0
              ? `\n<i>⚠️ ${manifest.skippedLowVelocity.length} low-velocity items skipped</i>\n`
              : '';

         const msg = `🛒 <b>ULINE Order — Approval Needed</b>\n\n` +
              `${skippedNote}` +
              `📦 ${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'} needing reorder\n` +
              `💰 Est. Total: <b>$${manifest.totalEstimate.toFixed(2)}</b>\n\n` +
              `${itemLines}${more}\n\n` +
              `<i>Create draft PO and fill ULINE cart?</i>`;

         const sentMsg = await ctx.reply(msg, {
              parse_mode: 'HTML',
              reply_markup: {
                  inline_keyboard: [[
                      { text: '✅ Approve & Fill Cart', callback_data: 'approve_uline_friday' },
                      { text: '⏭️ Skip', callback_data: 'skip_uline_friday' },
                  ]],
              },
         });

         (ops as any).pendingUlineFriday = {
              messageId: sentMsg.message_id,
              manifest,
              manifestJson: JSON.stringify(manifest),
         };
     }
 };

 /**
  * /ulinetest — Run ULINE flow test.
  */
 const ulineTestCommand: BotCommand = {
     name: 'ulinetest',
     description: 'Test ULINE flow against specific or latest PO',
     handler: async (ctx, _deps) => {
         const args = getCmdText(ctx).split(' ').slice(1);
         const poId = args[0];

         await ctx.reply(poId
             ? `🔍 Testing ULINE flow with PO #${poId}…`
             : '🔍 Testing ULINE flow with most recent draft PO…');

         const { gatherFromPO, executeUlineFridayApproval, gatherAllUlineDraftPOs } = await import('../order-uline');
         const { FinaleClient } = await import('../../lib/finale/client');
         const finale = new FinaleClient();

         let manifest: any;
         if (poId) {
             manifest = await gatherFromPO(finale, poId);
         } else {
             const allDrafts = await gatherAllUlineDraftPOs(finale);
             if (allDrafts.length === 0) {
                 await ctx.reply('❌ No ULINE draft POs found in Finale.');
                 return;
             }
             manifest = allDrafts[0];
         }

         if (manifest.items.length === 0) {
             await ctx.reply(`❌ No ULINE items found in PO #${poId || 'latest draft'}.`);
             return;
         }

         const result = await executeUlineFridayApproval(manifest);

         if (!result.success) {
             await ctx.reply(
                 `🚨 <b>ULINE Test Failed</b>\n\n` +
                 `<b>Error:</b> ${result.error || 'Unknown error'}\n` +
                 `Items: ${result.itemCount} | Total: $${result.estimatedTotal.toFixed(2)}`,
                 { parse_mode: 'HTML' }
             );
             return;
         }

         const itemLines = result.items
             .slice(0, 10)
             .map((i: any) => `  <code>${i.ulineModel}</code> × ${i.qty}  ($${(i.qty * i.unitPrice).toFixed(2)})`)
             .join('\n');
         const more = result.items.length > 10 ? `\n  <i>…and ${result.items.length - 10} more</i>` : '';

         const poLine = result.finalePO && result.finaleUrl
             ? `<a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
             : result.finalePO ? `Finale PO #${result.finalePO}` : '⚠️ PO creation skipped';

         const cartIcon = result.cartVerificationStatus === 'verified' ? '🛒'
             : result.cartVerificationStatus === 'partial' ? '⚠️' : '🟡';

         await ctx.reply(
             `🛒 <b>ULINE Test — Done</b>\n\n` +
             `📄 ${poLine}\n` +
             `💰 Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n` +
             `📦 ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n` +
             `${itemLines}${more}\n\n` +
             `${cartIcon} Cart: ${result.cartResult}\n` +
             (result.cartUrl
                 ? `Cart link: <a href="${result.cartUrl}">Load in browser</a>`
                 : `<a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a>`),
             { parse_mode: 'HTML', disable_web_page_preview: true }
         );
     }
 };

 /**
  * /received — Sweep received POs.
  */
 const receivedCommand: BotCommand = {
     name: 'received',
     description: 'Sweep received POs for invoice matches',
     handler: async (ctx, _deps) => {
         const args = getCmdText(ctx).split(' ').slice(1);
         const dryRun = args.includes('--dry-run');
         const daysArg = args.find((a: string) => a.startsWith('--days='));
         const days = daysArg ? daysArg.split('=')[1] : '60';
         const flagStr = dryRun ? ' --dry-run' : '';

         await ctx.reply(`🔄 Running PO sweep (last ${days} days)…`);

         const { exec: _exec } = await import('child_process');
         const { promisify: _promisify } = await import('util');
         const execAsync = _promisify(_exec);

         try {
             const { stdout, stderr } = await execAsync(
                 `node --import tsx src/cli/reconcile-received-pos.ts --days=${days}${flagStr}`,
                 { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }
             );
             const out = (stdout || '').slice(-2000);
             const errOut = (stderr || '').slice(-500);
             const summary = out || errOut || 'No output';
             await ctx.reply(
                 `✅ <b>PO Sweep Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`,
                 { parse_mode: 'HTML', disable_web_page_preview: true }
             );
         } catch (err: any) {
             const out = (err.stdout || '').slice(-1500);
             const errOut = (err.stderr || '').slice(-500);
             await ctx.reply(
                 `⚠️ <b>PO Sweep Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`,
                 { parse_mode: 'HTML', disable_web_page_preview: true }
             );
         }
     }
 };

 /**
  * /qty-status — Calibration health.
  */
 const qtyStatusCommand: BotCommand = {
     name: ['qty-status', 'qtystatus', 'qty'],
     description: 'Show calibration health and safety parameters',
     handler: async (ctx, _deps) => {
         try {
             const { createClient } = await import('../../lib/supabase');
             const { summarizeAriaVsFinale } = await import('../../lib/purchasing/calibration-engine');
             const db = createClient();
             if (!db) {
                 await ctx.reply("⚠️ Supabase not configured");
                 return;
             }

             const since30 = new Date();
             since30.setDate(since30.getDate() - 30);

             const [{ data: vendorStats }, summary, { count: openReservations }, { count: pendingRecs }] = await Promise.all([
                 db.from('vendor_calibration_stats')
                     .select('vendor_name, sample_count, median_error_pct, bias_pct, safety_multiplier')
                     .gte('sample_count', 5)
                     .order('sample_count', { ascending: false })
                     .limit(8),
                 summarizeAriaVsFinale(30),
                 db.from('qty_reservations').select('id', { count: 'exact', head: true }).is('released_at', null),
                 db.from('qty_recommendations').select('id', { count: 'exact', head: true }).is('calibrated_at', null).gte('recommended_at', since30.toISOString()),
             ]);

             const lines: string[] = [];
             lines.push("📊 *Qty Calibration Status*\n");
             lines.push(`Open draft reservations: ${openReservations ?? 0}`);
             lines.push(`Uncalibrated recs (30d): ${pendingRecs ?? 0}`);
             lines.push(`Calibrated samples (30d): ${summary.totalSamples}`);
             if (summary.medianAriaErrorPct != null) {
                 lines.push(`Aria median error: ${summary.medianAriaErrorPct >= 0 ? "+" : ""}${summary.medianAriaErrorPct.toFixed(0)}%`);
             }
             if (summary.medianFinaleErrorPct != null) {
                 lines.push(`Finale median error: ${summary.medianFinaleErrorPct >= 0 ? "+" : ""}${summary.medianFinaleErrorPct.toFixed(0)}%`);
             }

             if (vendorStats && vendorStats.length > 0) {
                 lines.push("\n*Top vendors (by sample count):*");
                 for (const v of vendorStats) {
                     const med = v.median_error_pct != null ? `${v.median_error_pct >= 0 ? '+' : ''}${Number(v.median_error_pct).toFixed(0)}%` : 'n/a';
                     const mul = Number(v.safety_multiplier).toFixed(2);
                     lines.push(`  • ${v.vendor_name ?? '?'} — n=${v.sample_count}, med ${med}, ×${mul}`);
                  }
             } else {
                 lines.push("\n_No vendor stats yet — need ≥5 calibrated samples per vendor._");
             }

             await ctx.reply(lines.join("\n"), { parse_mode: 'Markdown' });
         } catch (err: any) {
             console.error('[qty-status] error:', err.message);
             await ctx.reply(`⚠️ /qty-status failed: ${err.message ?? String(err)}`);
         }
     }
 };

 /**
  * /recon-status — AP reconciliation outcomes.
  */
 const reconStatusCommand: BotCommand = {
     name: ['recon-status', 'reconstatus', 'recon'],
     description: 'AP reconciliation outcomes status',
     handler: async (ctx, _deps) => {
         try {
             const reconStatusModule = await import('../../lib/runtime/observability/recon-status');
             const reconStatusAny = reconStatusModule as any;
             const getReconStatus =
                 reconStatusModule.getReconStatus ??
                 reconStatusAny.default?.getReconStatus ??
                 reconStatusAny["module.exports"]?.getReconStatus;
             const formatReconStatus =
                 reconStatusModule.formatReconStatus ??
                 reconStatusAny.default?.formatReconStatus ??
                 reconStatusAny["module.exports"]?.formatReconStatus;
             if (typeof getReconStatus !== "function" || typeof formatReconStatus !== "function") {
                 throw new Error("recon-status exports unavailable");
             }
             const status = await getReconStatus();
             const text = formatReconStatus(status);
             await ctx.reply(text, { parse_mode: 'Markdown' });
         } catch (err: any) {
             console.error('[recon-status] error:', err.message);
             await ctx.reply(`⚠️ /recon-status failed: ${err.message ?? String(err)}`);
         }
     }
 };

 export const operationsCommands: BotCommand[] = [
     buildriskCommand,
     requestsCommand,
     alertsCommand,
     correlateCommand,
     notifyCommand,
     purchasesCommand,
     vendorCommand,
     ulineCommand,
     ulineTestCommand,
     receivedCommand,
     qtyStatusCommand,
     reconStatusCommand,
 ];
