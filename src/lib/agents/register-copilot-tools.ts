/**
 * @file    register-copilot-tools.ts
 * @purpose Bridge file: takes the 8 existing copilot read tools and
 *          registers them with the Aria-wide tool registry so they show
 *          up in `/api/command-board/tools` and become auditable through
 *          `withToolAudit()`.
 *
 *          IMPORTANT: this file does NOT change copilot/core.ts behavior.
 *          The copilot still calls `getSharedReadTools()` directly via
 *          the AI SDK. Registration here is purely additive — metadata
 *          and surfacing for the dashboard.
 *
 *          Day 4+ can migrate the copilot core to invoke through the
 *          registry (with audit), but Day 3 just establishes the catalog.
 */

import { getSharedReadTools, READ_TOOL_NAMES } from "@/lib/copilot/tools";
import { registerTool, type ToolCategory } from "./tool-registry";

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
    lookup_product: "finale",
    get_consumption: "finale",
    query_vendors: "supabase",
    query_invoices: "supabase",
    query_purchase_orders: "supabase",
    build_risk_analysis: "build",
    inspect_artifact: "supabase",
    scrape_purchasing_dashboard: "scraping",
};

let registered = false;

/**
 * Register all known copilot read tools with the Aria-wide registry.
 * Idempotent: safe to call multiple times. The first call wins; later
 * calls no-op so tests + module-evaluation order stay deterministic.
 *
 * Call this from server-side entry points (API routes that need the
 * catalog populated). Calling from a chat tool path is unnecessary
 * because the copilot still uses its own `getSharedReadTools()` directly.
 */
export function ensureCopilotToolsRegistered(): void {
    if (registered) return;
    const tools = getSharedReadTools();
    for (const name of READ_TOOL_NAMES) {
        const tool = tools[name];
        if (!tool) continue;
        registerTool({
            name,
            description: typeof tool.description === "string" ? tool.description : `Copilot read tool: ${name}`,
            category: CATEGORY_BY_NAME[name] ?? "system",
            scope: "read",
            agentScope: [], // unrestricted — read tools are safe for any chat surface
            tool,
        });
    }
    registered = true;
}

/** TEST ONLY — reset the idempotency latch. */
export function __resetRegistrationLatchForTests(): void {
    registered = false;
}
