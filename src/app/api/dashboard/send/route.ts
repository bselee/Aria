/**
 * @file    route.ts
 * @purpose Dashboard chat API — Gemini primary, OpenRouter fallback, with full tool calling
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-03-09
 * @deps    ai, @ai-sdk/google, @ai-sdk/openai, zod, @/config/persona
 * @env     GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, PERPLEXITY_API_KEY
 *
 * DECISION(2026-03-09): Migrated from OpenAI (gpt-4o) to Gemini (primary) + OpenRouter (fallback).
 * Removes OpenAI dependency entirely from the dashboard chat. The Vercel AI SDK's `generateText`
 * with `tool()` handles automatic tool calling loops via `stopWhen: stepCountIs()`,
 * so we no longer need the manual tool loop.
 *
 * Provider chain: Gemini 2.5 Flash → OpenRouter (Claude 3.5 Haiku) → error
 */

import { NextResponse } from 'next/server';
import { generateText, tool, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SYSTEM_PROMPT } from '@/config/persona';

const RUNTIME_RULES = `

## CRITICAL: BIAS TO ACTION
You MUST use your tools to answer questions. NEVER ask clarifying questions when a tool can attempt the task.

### Tool selection rules:
- "search the web" / "find" / "look up online" → use perplexity_search immediately
- "give me X skus" / "list X products" / "find items with X" / "search for X" → use search_products
- Product lookup by exact SKU (e.g. "S-12527") → use lookup_product
- Sales history / units sold / volume for a product → use get_sales_history
- Vendor info → use query_vendors
- PO status → use query_purchase_orders
- Invoice status → use query_invoices

### LIVE DATA RULE:
For ANYTHING that can change — prices, stock, PO status, invoices — CALL THE TOOL. Never answer from memory alone.

### HOLLOW FILLER:
Never say "Let me know if you need anything else", "Hope that helps!", or ask what to do next unless you have a specific suggestion.

### Persona:
Aria is warm, sharp, and witty. Get to the answer first, then add color.`;

// ── Tool definitions using Vercel AI SDK `tool()` ─────────────────────
// DECISION(2026-03-09): Using AI SDK `tool()` with Zod schemas + `execute`
// functions. The SDK handles the entire tool call → execute → re-prompt loop
// automatically via `stopWhen: stepCountIs()`. This is provider-agnostic —
// works with Gemini, OpenRouter, OpenAI, or Anthropic identically.

const dashboardTools = {
    lookup_product: tool({
        description: 'Look up a product in Finale Inventory by exact SKU. Returns stock, cost, lead time, supplier.',
        inputSchema: z.object({ sku: z.string().describe('The exact SKU code to look up, e.g. "S-12527" or "CHC101"') }),
        execute: async ({ sku }) => {
            const { FinaleClient } = await import('@/lib/finale/client');
            const finale = new FinaleClient();
            const report = await finale.productReport(sku);
            return report.telegramMessage;
        },
    }),

    search_products: tool({
        description: 'Search Finale Inventory for products by keyword in name or description.',
        inputSchema: z.object({
            keyword: z.string().describe('Search keyword to match against product name or description'),
            limit: z.number().optional().default(20).describe('Max results to return'),
        }),
        execute: async ({ keyword, limit }) => {
            const { FinaleClient } = await import('@/lib/finale/client');
            const finale = new FinaleClient();
            const r = await finale.searchProducts(keyword, limit);
            return r.telegramMessage;
        },
    }),

    get_consumption: tool({
        description: 'Get BOM consumption and stock info for a SKU over N days.',
        inputSchema: z.object({
            sku: z.string().describe('The exact SKU code'),
            days: z.number().optional().default(90).describe('Number of days to look back'),
        }),
        execute: async ({ sku, days }) => {
            const { FinaleClient } = await import('@/lib/finale/client');
            const finale = new FinaleClient();
            const report = await finale.getBOMConsumption(sku, days);
            return report.telegramMessage;
        },
    }),

    get_purchase_history: tool({
        description: 'Get total quantity purchased for a SKU over a time period.',
        inputSchema: z.object({
            sku: z.string().describe('The exact SKU code'),
            days: z.number().optional().default(365).describe('Number of days to look back'),
        }),
        execute: async ({ sku, days }) => {
            const { FinaleClient } = await import('@/lib/finale/client');
            const finale = new FinaleClient();
            const purchased = await finale.getPurchasedQty(sku, days);
            return purchased.totalQty > 0
                ? `${sku}: Purchased ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s) in the last ${days} days.`
                : `${sku}: No purchase/receiving records found in the last ${days} days.`;
        },
    }),

    get_sales_history: tool({
        description: 'Get total quantity sold (shipped) for a SKU over a time period.',
        inputSchema: z.object({
            sku: z.string().describe('The exact SKU code'),
            days: z.number().optional().default(365).describe('Number of days to look back'),
        }),
        execute: async ({ sku, days }) => {
            const { FinaleClient } = await import('@/lib/finale/client');
            const finale = new FinaleClient();
            const sales = await finale.getSalesQty(sku, days);

            let msg = `${sku} Sales & Demand (Last ${days} days):\n`;
            msg += `- Sold (Shipped/Completed): ${sales.totalSoldQty.toFixed(1)} units across ${sales.soldOrderCount} order(s)\n`;
            msg += `- Open Demand (Committed): ${sales.openDemandQty.toFixed(1)} units across ${sales.openDemandCount} order(s)\n`;

            if (sales.stockOnHand !== null || sales.stockAvailable !== null) {
                msg += `- Current Stock: ${sales.stockOnHand ?? '--'} on hand, ${sales.stockAvailable ?? '--'} available`;
            }

            return msg;
        },
    }),

    query_vendors: tool({
        description: 'Look up vendor info by name: payment terms, contact, AR email, total spend.',
        inputSchema: z.object({ name: z.string().describe('Vendor company name to search for') }),
        execute: async ({ name }) => {
            const { createClient } = await import('@/lib/supabase');
            const db = createClient();
            if (!db) return 'Supabase not configured.';

            const { data, error } = await db.from('vendors')
                .select('name, aliases, payment_terms, contact_name, contact_email, ar_email, category, total_spend, last_order_date, average_payment_days')
                .ilike('name', `%${name}%`)
                .limit(5);

            if (error) return `DB error: ${error.message}`;
            if (!data?.length) return `No vendors found matching "${name}".`;
            return JSON.stringify(data, null, 2);
        },
    }),

    query_invoices: tool({
        description: 'Query invoices by status or vendor name.',
        inputSchema: z.object({
            vendor_name: z.string().optional().describe('Vendor name to filter by'),
            status: z.string().optional().describe('Invoice status to filter by (e.g. "pending", "paid", "overdue")'),
            limit: z.number().optional().default(10).describe('Max results to return'),
        }),
        execute: async ({ vendor_name, status, limit }) => {
            const { createClient } = await import('@/lib/supabase');
            const db = createClient();
            if (!db) return 'Supabase not configured.';

            let q = db.from('invoices')
                .select('invoice_number, po_number, total_amount, due_date, status, discrepancies, created_at, vendors(name)')
                .order('created_at', { ascending: false })
                .limit(limit);
            if (status) q = q.eq('status', status);
            if (vendor_name) {
                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${vendor_name}%`).limit(1);
                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
            }
            const { data, error } = await q;
            if (error) return `DB error: ${error.message}`;
            if (!data?.length) return 'No invoices found.';
            return JSON.stringify(data, null, 2);
        },
    }),

    query_purchase_orders: tool({
        description: 'Query purchase orders by status or vendor name.',
        inputSchema: z.object({
            vendor_name: z.string().optional().describe('Vendor name to filter by'),
            status: z.string().optional().describe('PO status to filter by (e.g. "submitted", "received", "pending")'),
            limit: z.number().optional().default(10).describe('Max results to return'),
        }),
        execute: async ({ vendor_name, status, limit }) => {
            const { createClient } = await import('@/lib/supabase');
            const db = createClient();
            if (!db) return 'Supabase not configured.';

            let q = db.from('purchase_orders')
                .select('po_number, issue_date, required_date, status, total_amount, line_items, vendors(name)')
                .order('issue_date', { ascending: false })
                .limit(limit);
            if (status) q = q.eq('status', status);
            if (vendor_name) {
                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${vendor_name}%`).limit(1);
                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
            }
            const { data, error } = await q;
            if (error) return `DB error: ${error.message}`;
            if (!data?.length) return 'No purchase orders found.';
            return JSON.stringify(data, null, 2);
        },
    }),

    perplexity_search: tool({
        description: 'Search the internet for real-time information.',
        inputSchema: z.object({ query: z.string().describe('The search query to look up on the web') }),
        execute: async ({ query }) => {
            const perplexityKey = process.env.PERPLEXITY_API_KEY;
            if (!perplexityKey) return 'Perplexity not configured.';

            // Using direct fetch to remove OpenAI SDK dependency
            const res = await fetch('https://api.perplexity.ai/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${perplexityKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'sonar-reasoning',
                    messages: [{ role: 'user', content: query }],
                }),
            });

            if (!res.ok) return `Perplexity error: ${res.status} ${res.statusText}`;
            const data = await res.json();
            return data.choices?.[0]?.message?.content || 'No results.';
        },
    }),

    build_risk_analysis: tool({
        description: "Run 30-day build risk analysis: stockouts vs upcoming production. Use for 'build risk', 'what are we short on', 'stockouts'.",
        inputSchema: z.object({}),
        execute: async () => {
            const { runBuildRiskAnalysis } = await import('@/lib/builds/build-risk');
            const report = await runBuildRiskAnalysis(30, () => { });
            return report.slackMessage;
        },
    }),
};

// ── Provider chain: Gemini → OpenRouter → error ────────────────────────
// DECISION(2026-03-09): Build the model lazily so env vars are read at request time.
// Each entry returns a model compatible with AI SDK's generateText.
function getModelChain(): Array<{ name: string; model: () => ReturnType<typeof google> }> {
    const chain: Array<{ name: string; model: () => any }> = [];

    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        chain.push({
            name: 'Gemini 2.5 Flash',
            model: () => google('gemini-2.5-flash'),
        });
    }

    if (process.env.OPENROUTER_API_KEY) {
        // DECISION(2026-03-09): Using createOpenAI with OpenRouter base URL instead of
        // @openrouter/ai-sdk-provider. The dedicated provider had issues parsing tool-calling
        // responses ("No object generated"). The OpenAI-compatible approach is proven in llm.ts.
        const openrouter = createOpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: process.env.OPENROUTER_API_KEY,
        });
        chain.push({
            name: 'OpenRouter Claude 3.5 Haiku',
            model: () => openrouter('anthropic/claude-3.5-haiku'),
        });
        chain.push({
            name: 'OpenRouter Llama 3.3 70B',
            model: () => openrouter('meta-llama/llama-3.3-70b-instruct'),
        });
    }

    return chain;
}

export async function POST(req: Request) {
    let message = '';
    try {
        const body = await req.json();
        message = body.message || '';
        if (!message?.trim()) {
            return NextResponse.json({ error: 'message required' }, { status: 400 });
        }

        // ── Load chat history from Supabase ─────────────────────────
        let dbHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        let dbClient: any = null;
        try {
            const { createClient } = await import('@/lib/supabase');
            dbClient = createClient();
            if (dbClient) {
                const { data } = await dbClient.from('sys_chat_logs')
                    .select('role, content')
                    .order('created_at', { ascending: false })
                    .limit(20);
                if (data) {
                    dbHistory = data.reverse().map((r: any) => ({
                        role: r.role as 'user' | 'assistant',
                        content: r.content,
                    }));
                }

                // Log user message
                await dbClient.from('sys_chat_logs').insert({
                    source: 'telegram',
                    role: 'user',
                    content: message,
                    metadata: { from: 'dashboard' },
                });
            }
        } catch { /* non-blocking */ }

        // Add current message to context
        dbHistory.push({ role: 'user', content: message });

        // ── Try each provider in chain ──────────────────────────────
        const chain = getModelChain();
        if (chain.length === 0) {
            return NextResponse.json(
                { error: 'No LLM providers configured. Set GOOGLE_GENERATIVE_AI_API_KEY or OPENROUTER_API_KEY.' },
                { status: 500 }
            );
        }

        let reply = '';
        let lastError: Error | null = null;
        let providerUsed = '';

        for (const provider of chain) {
            try {
                // DECISION(2026-03-09): Using stopWhen: stepCountIs(5) — maxSteps was
                // completely removed in AI SDK v6 and silently ignored.
                const result = await generateText({
                    model: provider.model(),
                    system: SYSTEM_PROMPT + RUNTIME_RULES,
                    messages: dbHistory,
                    tools: dashboardTools,
                    toolChoice: 'auto',
                    stopWhen: stepCountIs(5),
                    maxRetries: 0,
                });

                // Extract reply: prefer top-level text, fall back to last step with text
                reply = result.text || '';
                if (!reply && result.steps?.length) {
                    // Walk backwards through steps to find the last non-empty text
                    for (let i = result.steps.length - 1; i >= 0; i--) {
                        const stepText = (result.steps[i] as any).text;
                        if (stepText?.trim()) {
                            reply = stepText;
                            break;
                        }
                    }
                }

                // Last resort: if model only returned tool results, summarize them
                if (!reply && result.toolResults?.length) {
                    reply = result.toolResults.map((tr: any) =>
                        typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result)
                    ).join('\n\n');
                }

                providerUsed = provider.name;
                console.log(`[dashboard/send] ${providerUsed}: ${result.steps?.length || 1} step(s), finishReason=${result.finishReason}, reply=${(reply || '').length} chars`);

                break;
            } catch (err: any) {
                lastError = err;
                console.warn(`⚠️ Dashboard chat: ${provider.name} failed: ${err.message}`);
                // Continue to next provider
            }
        }

        if (!reply && lastError) {
            throw lastError;
        }

        // ── Log assistant reply ─────────────────────────────────────
        try {
            if (dbClient) {
                await dbClient.from('sys_chat_logs').insert({
                    source: 'telegram',
                    role: 'assistant',
                    content: reply,
                    metadata: { from: 'dashboard', provider: providerUsed },
                });
            }
        } catch { /* non-blocking */ }

        return NextResponse.json({ reply });
    } catch (err: any) {
        console.error('Dashboard send error (all providers failed):', err.message);
        return NextResponse.json(
            { error: `All chat providers failed. ${err.message}` },
            { status: 500 }
        );
    }
}
