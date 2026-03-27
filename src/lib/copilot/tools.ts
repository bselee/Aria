/**
 * @file    src/lib/copilot/tools.ts
 * @purpose Shared read tool definitions + execute handlers for the live copilot core.
 *
 *          These are the channel-agnostic read tools that Telegram and dashboard
 *          Q&A can safely call. Write actions stay in actions.ts and are gated
 *          before any tool-capable turn runs.
 */

import { tool } from "ai";
import { z } from "zod";
import { finaleClient } from "../finale/client";
import { createClient } from "../supabase";

export const READ_TOOL_NAMES = [
    "lookup_product",
    "get_consumption",
    "query_vendors",
    "query_invoices",
    "query_purchase_orders",
    "build_risk_analysis",
    "inspect_artifact",
] as const;

export type ReadToolName = typeof READ_TOOL_NAMES[number];

export function getSharedReadTools(opts?: { threadId?: string }) {
    return {
        lookup_product: tool({
            description: "Look up a specific Finale SKU and return stock, supplier, cost, and open PO context.",
            inputSchema: z.object({
                sku: z.string().describe("Exact Finale SKU / product ID"),
            }),
            execute: async ({ sku }) => {
                try {
                    const report = await finaleClient.productReport(sku);
                    return report.telegramMessage;
                } catch (err: any) {
                    return `Product lookup failed for ${sku}: ${err.message}`;
                }
            },
        }),

        get_consumption: tool({
            description: "Get BOM consumption and stock context for a specific SKU over a time period.",
            inputSchema: z.object({
                sku: z.string().describe("Exact Finale SKU / product ID"),
                days: z.number().optional().describe("Days to analyze, default 90"),
            }),
            execute: async ({ sku, days }) => {
                try {
                    const report = await finaleClient.getBOMConsumption(sku, days || 90);
                    return report.telegramMessage;
                } catch (err: any) {
                    return `Consumption lookup failed for ${sku}: ${err.message}`;
                }
            },
        }),

        query_vendors: tool({
            description: "Look up vendor info from the database by name, including contacts and spend history.",
            inputSchema: z.object({
                name: z.string().describe("Partial or full vendor name"),
            }),
            execute: async ({ name }) => {
                try {
                    const db = createClient();
                    if (!db) return "Supabase not configured.";

                    const { data, error } = await db
                        .from("vendors")
                        .select("name, aliases, payment_terms, contact_name, contact_email, ar_email, category, total_spend, last_order_date, average_payment_days")
                        .ilike("name", `%${name}%`)
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
            description: "Query invoice records by vendor or status.",
            inputSchema: z.object({
                vendor_name: z.string().optional().describe("Partial vendor name"),
                status: z.string().optional().describe("Invoice status: pending, matched, unmatched, paid, overdue"),
                limit: z.number().optional().describe("Max results, default 10"),
            }),
            execute: async ({ vendor_name, status, limit }) => {
                try {
                    const db = createClient();
                    if (!db) return "Supabase not configured.";

                    let q = db
                        .from("invoices")
                        .select("invoice_number, po_number, total_amount, due_date, status, discrepancies, created_at, vendors(name)")
                        .order("created_at", { ascending: false })
                        .limit(limit || 10);

                    if (status) q = q.eq("status", status);
                    if (vendor_name) {
                        const { data: vendors } = await db
                            .from("vendors")
                            .select("id")
                            .ilike("name", `%${vendor_name}%`)
                            .limit(1);
                        if (vendors?.length) q = q.eq("vendor_id", vendors[0].id);
                    }

                    const { data, error } = await q;
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return `No invoices found${status ? ` with status "${status}"` : ""}.`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `Invoice query failed: ${err.message}`;
                }
            },
        }),

        query_purchase_orders: tool({
            description: "Query purchase orders by PO number, vendor, or status.",
            inputSchema: z.object({
                vendor_name: z.string().optional().describe("Partial vendor name"),
                status: z.string().optional().describe("PO status: open, received, closed, partial, draft, committed"),
                po_number: z.string().optional().describe("Specific PO number"),
                limit: z.number().optional().describe("Max results, default 10"),
            }),
            execute: async ({ vendor_name, status, po_number, limit }) => {
                try {
                    const db = createClient();
                    if (!db) return "Supabase not configured.";

                    let q = db
                        .from("purchase_orders")
                        .select("po_number, issue_date, required_date, status, total_amount, line_items, tracking_numbers, vendors(name)")
                        .order("issue_date", { ascending: false })
                        .limit(limit || 10);

                    if (status) q = q.eq("status", status);
                    if (po_number) q = q.eq("po_number", po_number);
                    if (vendor_name) {
                        const { data: vendors } = await db
                            .from("vendors")
                            .select("id")
                            .ilike("name", `%${vendor_name}%`)
                            .limit(1);
                        if (vendors?.length) q = q.eq("vendor_id", vendors[0].id);
                    }

                    const { data, error } = await q;
                    if (error) return `DB error: ${error.message}`;
                    if (!data?.length) return `No purchase orders found${status ? ` with status "${status}"` : ""}.`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `PO query failed: ${err.message}`;
                }
            },
        }),

        build_risk_analysis: tool({
            description: "Run the current 30-day build risk analysis.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const { runBuildRiskAnalysis } = await import("../builds/build-risk");
                    const report = await runBuildRiskAnalysis(30, () => {});
                    return report.telegramMessage;
                } catch (err: any) {
                    return `Build risk analysis failed: ${err.message}`;
                }
            },
        }),

        inspect_artifact: tool({
            description: "Retrieve the saved summary and structured data for a known copilot artifact.",
            inputSchema: z.object({
                artifactId: z.string().describe("Artifact ID from the current thread"),
            }),
            execute: async ({ artifactId }) => {
                try {
                    const db = createClient();
                    if (!db) return "Supabase not configured.";

                    let q = db
                        .from("copilot_artifacts")
                        .select("artifact_id, filename, summary, structured_data, tags, created_at")
                        .eq("artifact_id", artifactId)
                        .limit(1);

                    if (opts?.threadId) {
                        q = q.eq("thread_id", opts.threadId);
                    }

                    const { data, error } = await q.maybeSingle();
                    if (error) return `DB error: ${error.message}`;
                    if (!data) return `No artifact found for ${artifactId}.`;
                    return JSON.stringify(data, null, 2);
                } catch (err: any) {
                    return `Artifact lookup failed: ${err.message}`;
                }
            },
        }),
    };
}

export function getReadToolNames(): ReadToolName[] {
    return [...READ_TOOL_NAMES];
}

// ── Read tool routing with one-retry fallback ─────────────────────────────────

export interface ReadToolRouteInput {
    text:     string;
    /** Ordered list of tool names to attempt (first = preferred, rest = fallbacks) */
    attempts: string[];
}

export interface ReadToolRouteResult {
    resolvedTool?:   string;
    attemptCount:    number;
    failed:          boolean;
    /** Never set — read failures must not produce write action refs */
    writeActionRef?: never;
}

/**
 * Resolve the best read tool from an ordered attempt list.
 *
 * Rules (per design doc):
 *   - First attempt returns a known tool → success (attemptCount = 1)
 *   - First attempt unknown/no_result → try second (attemptCount = 2)
 *   - Second attempt also fails → stop, return failed (no third attempt)
 *   - Failures never produce writeActionRef (type-enforced as `never`)
 */
export async function resolveReadToolRoute(input: ReadToolRouteInput): Promise<ReadToolRouteResult> {
    const { attempts } = input;
    const MAX_ATTEMPTS = 2;

    for (let i = 0; i < Math.min(attempts.length, MAX_ATTEMPTS); i++) {
        const toolName = attempts[i];
        const known    = getTool(toolName);

        if (known) {
            return { resolvedTool: toolName, attemptCount: i + 1, failed: false };
        }
    }

    return {
        resolvedTool: undefined,
        attemptCount: Math.min(attempts.length, MAX_ATTEMPTS),
        failed:       true,
    };
}
