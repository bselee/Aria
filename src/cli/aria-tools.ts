/**
 * @file    aria-tools.ts
 * @purpose Shared Vercel AI SDK tool definitions for Aria's Telegram bot.
 *          Consolidates all 14 tools into one place — used by both the text
 *          message handler and the photo/document follow-up handler.
 * @author  Will / Antigravity
 * @created 2026-03-06
 * @updated 2026-03-06
 * @deps    ai, zod, ../lib/finale/client, ../lib/supabase, ../lib/gmail/auth
 *
 * DECISION(2026-03-06): Extracted from start-bot.ts to eliminate 400+ lines
 * of duplication. Each tool has its schema AND execute() co-located.
 * Uses Vercel AI SDK tool() format for use with generateText().
 */

import { tool } from 'ai';
import { z } from 'zod';
import { FinaleClient } from '../lib/finale/client';
import OpenAI from 'openai';

// Type for Telegraf bot instance — avoids importing full Telegraf types
type TelegramBot = { telegram: { sendMessage: (chatId: string | number, text: string, extra?: any) => Promise<any> } };

/**
 * Creates Aria's full tool set for Vercel AI SDK generateText().
 *
 * @param opts.finale      Finale Inventory client instance
 * @param opts.perplexity  Optional Perplexity client for web search
 * @param opts.bot         Telegraf bot instance (for inline keyboards in create_draft_pos)
 * @param opts.chatId      Telegram chat ID (for inline keyboards)
 * @returns Tool definitions compatible with generateText({ tools: ... })
 */
export function getAriaTools(opts: {
    finale: FinaleClient;
    perplexity: OpenAI | null;
    bot: TelegramBot;
    chatId: number | string;
}) {
    const { finale, perplexity, bot, chatId } = opts;

    return {
        get_weather: tool({
            description: 'Get real-time weather information for a specific location.',
            inputSchema: z.object({
                location: z.string().describe('City and State, e.g. Montrose, CO'),
            }),
            execute: async ({ location }) => {
                try {
                    const Firecrawl = require('@mendable/firecrawl-js').default;
                    const app = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
                    const scrape = await app.scrapeUrl(
                        `https://duckduckgo.com/?q=weather+in+${encodeURIComponent(location)}`,
                        { formats: ['markdown'] }
                    );
                    return scrape.success ? scrape.markdown : 'Could not retrieve weather.';
                } catch (err: any) {
                    return `Weather lookup failed: ${err.message}`;
                }
            },
        }),

        list_recent_emails: tool({
            description: 'List the 5 most recent emails from the inbox.',
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const { getAuthenticatedClient } = await import('../lib/gmail/auth');
                    const { gmail: GmailApi } = await import('@googleapis/gmail');
                    const auth = await getAuthenticatedClient('default');
                    const gmail = GmailApi({ version: 'v1', auth });
                    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 5 });
                    return JSON.stringify(data.messages);
                } catch (err: any) {
                    return `Email lookup failed: ${err.message}`;
                }
            },
        }),

        perplexity_search: tool({
            description: 'Search the internet for real-time information.',
            inputSchema: z.object({
                query: z.string().describe('Search query'),
            }),
            execute: async ({ query }) => {
                if (!perplexity) return 'Perplexity not configured.';
                try {
                    const res = await perplexity.chat.completions.create({
                        model: 'sonar-reasoning',
                        messages: [{ role: 'user', content: query }],
                    });
                    return res.choices[0].message.content || '';
                } catch (err: any) {
                    return `Search failed: ${err.message}`;
                }
            },
        }),

        lookup_product: tool({
            description: 'Look up a SPECIFIC product in Finale Inventory by EXACT SKU. Returns stock, lead time, supplier, cost, and reorder info. Only use this when you know the exact SKU.',
            inputSchema: z.object({
                sku: z.string().describe('The exact product SKU/ID in Finale (e.g. S-12527, BC101, PU102)'),
            }),
            execute: async ({ sku }) => {
                try {
                    const report = await finale.productReport(sku);
                    return report.telegramMessage;
                } catch (err: any) {
                    return `Product lookup failed for ${sku}: ${err.message}`;
                }
            },
        }),

        search_products: tool({
            description: "Search Finale Inventory for products by keyword in name or description. Use this when Will asks to find, list, or search for products by name, ingredient, vendor, or description — e.g. 'kashi skus', 'kelp products', 'find castings items'. Returns matching SKUs with stock levels.",
            inputSchema: z.object({
                keyword: z.string().describe("Search keyword to match against product names and SKUs (e.g. 'kashi', 'kelp', 'castings', 'bag')"),
                limit: z.number().optional().describe('Max results to return (default 20)'),
            }),
            execute: async ({ keyword, limit }) => {
                try {
                    const searchResult = await finale.searchProducts(keyword, limit || 20);
                    return searchResult.telegramMessage;
                } catch (err: any) {
                    return `Product search failed: ${err.message}`;
                }
            },
        }),

        get_consumption: tool({
            description: "Get BOM consumption and stock info for a specific SKU over a number of days. Use this when the user asks for consumption of a SKU, e.g., 'consumption for KM106' or '/consumption KM106'.",
            inputSchema: z.object({
                sku: z.string().describe('The exact product SKU/ID (e.g. KM106, S-12527)'),
                days: z.number().optional().describe('Number of days to analyze (default 90)'),
            }),
            execute: async ({ sku, days }) => {
                try {
                    const report = await finale.getBOMConsumption(sku, days || 90);
                    return report.telegramMessage;
                } catch (err: any) {
                    return `Consumption lookup failed for ${sku}: ${err.message}`;
                }
            },
        }),

        build_risk_analysis: tool({
            description: "Run advanced 30-day build risk analysis to predict stockouts for upcoming production. Explodes BOMs against the manufacturing calendar and current stock. Use when the user asks for 'build risk', 'what are we short on', 'stockouts', or '/buildrisk'.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const { runBuildRiskAnalysis } = await import('../lib/builds/build-risk');
                    const report = await runBuildRiskAnalysis(30, () => { });
                    return report.slackMessage;
                } catch (err: any) {
                    return `Build risk analysis failed: ${err.message}`;
                }
            },
        }),

        get_purchase_history: tool({
            description: "Get the total quantity purchased/received for a specific SKU over a time period. Use this when the user asks 'how much was purchased', 'total received', 'purchase history', or 'how much did we buy' for a product. Returns exact PO quantities from Finale.",
            inputSchema: z.object({
                sku: z.string().describe('The exact product SKU/ID (e.g. PLQ101, KM106)'),
                days: z.number().optional().describe('Number of days back to search (default 365)'),
            }),
            execute: async ({ sku, days }) => {
                try {
                    const purchased = await finale.getPurchasedQty(sku, days || 365);
                    if (purchased.totalQty > 0) {
                        return `${sku}: Purchased ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s) in the last ${days || 365} days.`;
                    }
                    return `${sku}: No purchase/receiving records found in the last ${days || 365} days.`;
                } catch (err: any) {
                    return `Purchase history lookup failed for ${sku}: ${err.message}`;
                }
            },
        }),

        query_vendors: tool({
            description: "Look up vendor info from our database by name. Returns payment terms, contact, AR email, total spend, last order date. Use when Will asks about a specific vendor, payment terms, who to contact, or vendor history.",
            inputSchema: z.object({
                name: z.string().describe("Partial or full vendor name to search (e.g. 'AAA Cooper', 'Kashi', 'BioAg')"),
            }),
            execute: async ({ name }) => {
                try {
                    const { createClient } = await import('../lib/supabase');
                    const db = createClient();
                    if (!db) return 'Supabase not configured.';
                    const { data, error } = await db.from('vendors')
                        .select('name, aliases, payment_terms, contact_name, contact_email, ar_email, category, total_spend, last_order_date, average_payment_days')
                        .ilike('name', `%${name}%`)
                        .limit(5);
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return `No vendors found matching "${name}".`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `Vendor query failed: ${err.message}`;
                }
            },
        }),

        query_invoices: tool({
            description: "Query invoices from our database. Use when Will asks about invoice status, unmatched invoices, overdue invoices, or invoice amounts. Filter by status: 'pending', 'matched', 'unmatched', 'paid', 'overdue'.",
            inputSchema: z.object({
                vendor_name: z.string().optional().describe('Filter by vendor name (partial match)'),
                status: z.string().optional().describe('Filter by status: pending, matched, unmatched, paid, overdue'),
                limit: z.number().optional().describe('Max results (default 10)'),
            }),
            execute: async ({ vendor_name, status, limit }) => {
                try {
                    const { createClient } = await import('../lib/supabase');
                    const db = createClient();
                    if (!db) return 'Supabase not configured.';
                    let q = db.from('invoices')
                        .select('invoice_number, po_number, total_amount, due_date, status, discrepancies, created_at, vendors(name)')
                        .order('created_at', { ascending: false })
                        .limit(limit || 10);
                    if (status) q = q.eq('status', status);
                    if (vendor_name) {
                        const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${vendor_name}%`).limit(1);
                        if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                    }
                    const { data, error } = await q;
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return `No invoices found${status ? ` with status "${status}"` : ''}.`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `Invoice query failed: ${err.message}`;
                }
            },
        }),

        query_purchase_orders: tool({
            description: "Query purchase orders from our database. Use when Will asks about open POs, PO status, what's on order, expected deliveries, or tracking numbers for a PO. Filter by status: 'open', 'received', 'closed', 'partial'.",
            inputSchema: z.object({
                vendor_name: z.string().optional().describe('Filter by vendor name (partial match)'),
                status: z.string().optional().describe('Filter by status: open, received, closed, partial'),
                po_number: z.string().optional().describe('Filter by specific PO number'),
                limit: z.number().optional().describe('Max results (default 10)'),
            }),
            execute: async ({ vendor_name, status, po_number, limit }) => {
                try {
                    const { createClient } = await import('../lib/supabase');
                    const db = createClient();
                    if (!db) return 'Supabase not configured.';
                    let q = db.from('purchase_orders')
                        .select('po_number, issue_date, required_date, status, total_amount, line_items, tracking_numbers, vendors(name)')
                        .order('issue_date', { ascending: false })
                        .limit(limit || 10);
                    if (status) q = q.eq('status', status);
                    if (po_number) q = q.eq('po_number', po_number);
                    if (vendor_name) {
                        const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${vendor_name}%`).limit(1);
                        if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                    }
                    const { data, error } = await q;
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return `No purchase orders found${status ? ` with status "${status}"` : ''}.`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `PO query failed: ${err.message}`;
                }
            },
        }),

        query_action_items: tool({
            description: "Get documents that require action — unprocessed uploads, pending approvals, documents flagged for follow-up. Use when Will asks 'what needs attention', 'pending items', 'action required', or 'what did you flag'.",
            inputSchema: z.object({
                limit: z.number().optional().describe('Max results (default 10)'),
            }),
            execute: async ({ limit }) => {
                try {
                    const { createClient } = await import('../lib/supabase');
                    const db = createClient();
                    if (!db) return 'Supabase not configured.';
                    const { data, error } = await db.from('documents')
                        .select('type, vendor_ref, action_summary, confidence, source, created_at')
                        .eq('action_required', true)
                        .order('created_at', { ascending: false })
                        .limit(limit || 10);
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return 'No pending action items found.';
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `Action items query failed: ${err.message}`;
                }
            },
        }),

        reorder_assessment: tool({
            description: "Scan all active Finale products and return external-vendor reorder recommendations grouped by vendor with urgency. Use when Will asks about reorders, low stock, what to order, purchasing needs, or 'what do we need to buy'.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const finaleClient = new FinaleClient();
                    const groups = await finaleClient.getExternalReorderItems();
                    if (groups.length === 0) {
                        return '✅ All stocking items are within safe levels — nothing to reorder.';
                    }
                    const crit = groups.filter((g: any) => g.urgency === 'critical');
                    const warn = groups.filter((g: any) => g.urgency === 'warning');
                    const flag = groups.filter((g: any) => g.urgency === 'reorder_flagged');
                    const lines: string[] = [`📦 *Reorder Assessment* — ${groups.length} vendor${groups.length !== 1 ? 's' : ''} flagged\n`];
                    if (crit.length) lines.push(`🔴 *Critical (<14d):* ${crit.map((g: any) => `${g.vendorName} (${g.items.length})`).join(', ')}`);
                    if (warn.length) lines.push(`🟡 *Warning (14–44d):* ${warn.map((g: any) => `${g.vendorName} (${g.items.length})`).join(', ')}`);
                    if (flag.length) lines.push(`📦 *Flagged:* ${flag.map((g: any) => g.vendorName).join(', ')}`);
                    const allItems = groups.flatMap((g: any) => g.items.map((i: any) => ({ ...i, vendor: g.vendorName })));
                    const topItems = allItems
                        .filter((i: any) => i.stockoutDays !== null)
                        .sort((a: any, b: any) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999))
                        .slice(0, 5);
                    if (topItems.length) {
                        lines.push('\n*Most urgent SKUs:*');
                        for (const i of topItems) {
                            lines.push(`  • ${i.productId} — ${i.stockoutDays}d out · ${i.vendor}${i.reorderQty ? ` · qty:${i.reorderQty}` : ''}`);
                        }
                    }
                    lines.push('\nSay "create draft POs" to generate Finale drafts for all vendors.');
                    return lines.join('\n');
                } catch (err: any) {
                    return `Reorder assessment failed: ${err.message}`;
                }
            },
        }),

        create_draft_pos: tool({
            description: 'Create draft purchase orders in Finale for human review and commit. Creates one PO per vendor for all flagged reorder items, or filtered to a specific vendor. Draft POs appear in Finale as ORDER_CREATED for Will to review and commit.',
            inputSchema: z.object({
                vendor_filter: z.string().optional().describe('Optional vendor name to create PO for only that vendor. Omit to create all flagged POs.'),
            }),
            execute: async ({ vendor_filter }) => {
                try {
                    const { buildVendorDraftPlans } = await import('../lib/purchasing/vendor-draft-plans');
                    const groups = await finale.getPurchasingIntelligence();
                    const plans = buildVendorDraftPlans(groups, {}, vendor_filter);
                    if (plans.length === 0) {
                        return vendor_filter
                            ? `No reorder items found for vendor matching "${vendor_filter}".`
                            : 'No purchasing groups found.';
                    }
                    const actionablePlans = plans.filter(plan => plan.actionableItems.length > 0);
                    if (actionablePlans.length === 0) {
                        const blockedSummary = plans
                            .flatMap(plan => plan.blockedLines.slice(0, 2).map(line => `${line.item.productId}: ${line.assessment.explanation}`))
                            .slice(0, 4);
                        return vendor_filter
                            ? `No actionable draft lines found for vendor matching "${vendor_filter}".${blockedSummary.length ? ` Blocked: ${blockedSummary.join(' | ')}` : ''}`
                            : `No actionable draft lines found.${blockedSummary.length ? ` Blocked: ${blockedSummary.join(' | ')}` : ''}`;
                    }
                    const created: string[] = [];
                    const tgChatId = String(chatId);
                    for (const plan of actionablePlans) {
                        try {
                            const po = await finale.createDraftPurchaseOrder(
                                plan.vendorPartyId, plan.actionableItems,
                                'Auto-generated draft — review and commit in Finale'
                            );
                            let poLine = `✅ PO #${po.orderId} — ${plan.vendorName} (${plan.actionableItems.length} SKU${plan.actionableItems.length !== 1 ? 's' : ''}) → ${po.facilityName}`;
                            if (po.duplicateWarnings.length > 0) poLine += `\n${po.duplicateWarnings.join('\n')}`;
                            if (po.priceAlerts.length > 0) poLine += `\n${po.priceAlerts.join('\n')}`;
                            if (plan.blockedLines.length > 0) {
                                const blocked = plan.blockedLines
                                    .slice(0, 3)
                                    .map(line => `${line.item.productId}: ${line.assessment.explanation}`)
                                    .join(' | ');
                                poLine += `\nBlocked: ${blocked}`;
                            }
                            created.push(poLine);
                            // Send inline Review & Send keyboard for this PO
                            bot.telegram.sendMessage(tgChatId, poLine, {
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '📋 Review & Send', callback_data: `po_review_${po.orderId}` },
                                        { text: 'Skip', callback_data: `po_skip_${po.orderId}` },
                                    ]],
                                },
                            }).catch(() => { });
                        } catch (e: any) {
                            created.push(`❌ ${plan.vendorName}: ${e.message}`);
                        }
                    }
                    return `*Draft POs Created:*\n${created.join('\n')}\n\nTap "Review & Send" on any PO above to commit and email the vendor.`;
                } catch (err: any) {
                    return `Draft PO creation failed: ${err.message}`;
                }
            },
        }),
    };
}
