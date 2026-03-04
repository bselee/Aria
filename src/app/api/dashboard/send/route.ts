import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { SYSTEM_PROMPT } from '@/config/persona';

// Remove in-memory dashHistory. We fetch from DB for true portability.

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

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "lookup_product",
            description: "Look up a product in Finale Inventory by exact SKU. Returns stock, cost, lead time, supplier.",
            parameters: {
                type: "object",
                properties: { sku: { type: "string" } },
                required: ["sku"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_products",
            description: "Search Finale Inventory for products by keyword in name or description.",
            parameters: {
                type: "object",
                properties: {
                    keyword: { type: "string" },
                    limit: { type: "number" }
                },
                required: ["keyword"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_consumption",
            description: "Get BOM consumption and stock info for a SKU over N days.",
            parameters: {
                type: "object",
                properties: {
                    sku: { type: "string" },
                    days: { type: "number" }
                },
                required: ["sku"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_purchase_history",
            description: "Get total quantity purchased for a SKU over a time period.",
            parameters: {
                type: "object",
                properties: {
                    sku: { type: "string" },
                    days: { type: "number" }
                },
                required: ["sku"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_sales_history",
            description: "Get total quantity sold (shipped) for a SKU over a time period.",
            parameters: {
                type: "object",
                properties: {
                    sku: { type: "string" },
                    days: { type: "number" }
                },
                required: ["sku"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_vendors",
            description: "Look up vendor info by name: payment terms, contact, AR email, total spend.",
            parameters: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_invoices",
            description: "Query invoices by status or vendor name.",
            parameters: {
                type: "object",
                properties: {
                    vendor_name: { type: "string" },
                    status: { type: "string" },
                    limit: { type: "number" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_purchase_orders",
            description: "Query purchase orders by status or vendor name.",
            parameters: {
                type: "object",
                properties: {
                    vendor_name: { type: "string" },
                    status: { type: "string" },
                    limit: { type: "number" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "perplexity_search",
            description: "Search the internet for real-time information.",
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "build_risk_analysis",
            description: "Run 30-day build risk analysis: stockouts vs upcoming production. Use for 'build risk', 'what are we short on', 'stockouts'.",
            parameters: { type: "object", properties: {} }
        }
    }
];

export async function POST(req: Request) {
    try {
        const { message } = await req.json();
        if (!message?.trim()) {
            return NextResponse.json({ error: 'message required' }, { status: 400 });
        }

        const openai = process.env.OPENAI_API_KEY
            ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            : null;

        if (!openai) {
            return NextResponse.json({ error: 'OpenAI not configured' }, { status: 500 });
        }

        let dbHistory: any[] = [];
        let dbClient: any = null;
        try {
            const { createClient } = await import('@/lib/supabase');
            dbClient = createClient();
            if (dbClient) {
                // Fetch last 20 messages for context
                const { data } = await dbClient.from('sys_chat_logs')
                    .select('role, content')
                    .order('created_at', { ascending: false })
                    .limit(20);
                if (data) {
                    dbHistory = data.reverse().map((r: any) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
                }

                // Log user message
                await dbClient.from('sys_chat_logs').insert({
                    source: 'telegram',
                    role: 'user',
                    content: message,
                    metadata: { from: 'dashboard' }
                });
            }
        } catch { /* non-blocking */ }

        // Actually insert the incoming message into this context run
        dbHistory.push({ role: 'user', content: message });

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT + RUNTIME_RULES },
                ...dbHistory
            ],
            tools,
            tool_choice: 'auto',
        });

        const msg = response.choices[0].message;
        let reply = '';

        if (msg.tool_calls) {
            const toolResults: any[] = [];

            for (const toolCall of msg.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                let result = '';

                try {
                    if (toolCall.function.name === 'lookup_product') {
                        const { FinaleClient } = await import('@/lib/finale/client');
                        const finale = new FinaleClient();
                        const report = await finale.productReport(args.sku);
                        result = report.telegramMessage;
                    } else if (toolCall.function.name === 'search_products') {
                        const { FinaleClient } = await import('@/lib/finale/client');
                        const finale = new FinaleClient();
                        const r = await finale.searchProducts(args.keyword, args.limit || 20);
                        result = r.telegramMessage;
                    } else if (toolCall.function.name === 'get_consumption') {
                        const { FinaleClient } = await import('@/lib/finale/client');
                        const finale = new FinaleClient();
                        const report = await finale.getBOMConsumption(args.sku, args.days || 90);
                        result = report.telegramMessage;
                    } else if (toolCall.function.name === 'get_purchase_history') {
                        const { FinaleClient } = await import('@/lib/finale/client');
                        const finale = new FinaleClient();
                        const purchased = await finale.getPurchasedQty(args.sku, args.days || 365);
                        result = purchased.totalQty > 0
                            ? `${args.sku}: Purchased ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s) in the last ${args.days || 365} days.`
                            : `${args.sku}: No purchase/receiving records found in the last ${args.days || 365} days.`;
                    } else if (toolCall.function.name === 'get_sales_history') {
                        const { FinaleClient } = await import('@/lib/finale/client');
                        const finale = new FinaleClient();
                        const sales = await finale.getSalesQty(args.sku, args.days || 365);

                        let msg = `${args.sku} Sales & Demand (Last ${args.days || 365} days):\n`;
                        msg += `- Sold (Shipped/Completed): ${sales.totalSoldQty.toFixed(1)} units across ${sales.soldOrderCount} order(s)\n`;
                        msg += `- Open Demand (Committed): ${sales.openDemandQty.toFixed(1)} units across ${sales.openDemandCount} order(s)\n`;

                        if (sales.stockOnHand !== null || sales.stockAvailable !== null) {
                            msg += `- Current Stock: ${sales.stockOnHand ?? '--'} on hand, ${sales.stockAvailable ?? '--'} available`;
                        }

                        result = msg;
                    } else if (toolCall.function.name === 'query_vendors') {
                        const { createClient } = await import('@/lib/supabase');
                        const db = createClient();
                        if (!db) { result = 'Supabase not configured.'; }
                        else {
                            const { data, error } = await db.from('vendors')
                                .select('name, aliases, payment_terms, contact_name, contact_email, ar_email, category, total_spend, last_order_date, average_payment_days')
                                .ilike('name', `%${args.name}%`)
                                .limit(5);
                            result = error ? `DB error: ${error.message}` :
                                !data?.length ? `No vendors found matching "${args.name}".` :
                                    JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === 'query_invoices') {
                        const { createClient } = await import('@/lib/supabase');
                        const db = createClient();
                        if (!db) { result = 'Supabase not configured.'; }
                        else {
                            let q = db.from('invoices')
                                .select('invoice_number, po_number, total_amount, due_date, status, discrepancies, created_at, vendors(name)')
                                .order('created_at', { ascending: false })
                                .limit(args.limit || 10);
                            if (args.status) q = q.eq('status', args.status);
                            if (args.vendor_name) {
                                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${args.vendor_name}%`).limit(1);
                                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                            }
                            const { data, error } = await q;
                            result = error ? `DB error: ${error.message}` :
                                !data?.length ? `No invoices found.` :
                                    JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === 'query_purchase_orders') {
                        const { createClient } = await import('@/lib/supabase');
                        const db = createClient();
                        if (!db) { result = 'Supabase not configured.'; }
                        else {
                            let q = db.from('purchase_orders')
                                .select('po_number, issue_date, required_date, status, total_amount, line_items, vendors(name)')
                                .order('issue_date', { ascending: false })
                                .limit(args.limit || 10);
                            if (args.status) q = q.eq('status', args.status);
                            if (args.vendor_name) {
                                const { data: vd } = await db.from('vendors').select('id').ilike('name', `%${args.vendor_name}%`).limit(1);
                                if (vd?.length) q = q.eq('vendor_id', vd[0].id);
                            }
                            const { data, error } = await q;
                            result = error ? `DB error: ${error.message}` :
                                !data?.length ? `No purchase orders found.` :
                                    JSON.stringify(data, null, 2);
                        }
                    } else if (toolCall.function.name === 'perplexity_search') {
                        const perplexityKey = process.env.PERPLEXITY_API_KEY;
                        if (perplexityKey) {
                            const perplexity = new OpenAI({ apiKey: perplexityKey, baseURL: 'https://api.perplexity.ai' });
                            const res = await perplexity.chat.completions.create({
                                model: 'sonar-reasoning',
                                messages: [{ role: 'user', content: args.query }]
                            });
                            result = res.choices[0].message.content || '';
                        } else {
                            result = 'Perplexity not configured.';
                        }
                    } else if (toolCall.function.name === 'build_risk_analysis') {
                        const { runBuildRiskAnalysis } = await import('@/lib/builds/build-risk');
                        const report = await runBuildRiskAnalysis(30, () => { });
                        result = report.slackMessage;
                    }
                } catch (toolErr: any) {
                    result = `Tool error: ${toolErr.message}`;
                }

                toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
            }

            const msgForFinal = { role: msg.role, content: msg.content || '', tool_calls: msg.tool_calls };

            const finalRes = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...dbHistory,
                    msgForFinal as any,
                    ...toolResults
                ]
            });
            reply = finalRes.choices[0].message.content || '';
        } else {
            reply = msg.content || '';
        }

        // Log assistant reply
        try {
            if (dbClient) {
                await dbClient.from('sys_chat_logs').insert({
                    source: 'telegram',
                    role: 'assistant',
                    content: reply,
                    metadata: { from: 'dashboard' }
                });
            }
        } catch { /* non-blocking */ }

        return NextResponse.json({ reply });
    } catch (err: any) {
        console.error('Dashboard send error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
