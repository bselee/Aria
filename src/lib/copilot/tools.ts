/**
 * @file    src/lib/copilot/tools.ts
 * @purpose Shared read tool definitions for the copilot layer.
 *
 *          Read tools are used for: consumption, purchase history, stock,
 *          PO status, invoice status, vendor info, build risk, artifact inspection.
 *
 *          These definitions are channel-agnostic — Telegram and dashboard
 *          adapters both reference this registry.  Write operations are in
 *          actions.ts, not here.
 *
 *          Tool implementations live in src/cli/aria-tools.ts (Telegram) and
 *          src/app/api/dashboard/send/route.ts (dashboard) until they are fully
 *          migrated to this shared module.
 */

export interface CopilotTool {
    name:        string;
    description: string;
    /** JSON Schema for the tool's parameters */
    parameters:  Record<string, unknown>;
}

/**
 * Shared read tool registry.
 * Each entry here should match the tool definition in aria-tools.ts / dashboard route.
 * As tools are migrated to the shared core, implementations move here too.
 */
export const READ_TOOLS: CopilotTool[] = [
    {
        name: "lookup_product",
        description: "Look up a product by SKU in Finale — returns stock, price, consumption, and open POs.",
        parameters: {
            type: "object",
            properties: {
                sku: { type: "string", description: "Finale product ID / SKU" },
            },
            required: ["sku"],
        },
    },
    {
        name: "search_purchase_orders",
        description: "Search Finale purchase orders by vendor, status, or date range.",
        parameters: {
            type: "object",
            properties: {
                vendor:    { type: "string" },
                status:    { type: "string", enum: ["open", "closed", "all"] },
                limit:     { type: "number" },
            },
        },
    },
    {
        name: "lookup_vendor",
        description: "Look up a vendor by name — returns contact info, spend history, and open PO summary.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Vendor name (fuzzy matched)" },
            },
            required: ["name"],
        },
    },
    {
        name: "get_build_risk",
        description: "Get the current build risk for all active builds — returns CRITICAL/WARNING/WATCH/OK per component.",
        parameters: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "inspect_artifact",
        description: "Retrieve the full summary and structured data for a known artifact.",
        parameters: {
            type: "object",
            properties: {
                artifactId: { type: "string" },
            },
            required: ["artifactId"],
        },
    },
];

/** Look up a tool definition by name */
export function getTool(name: string): CopilotTool | undefined {
    return READ_TOOLS.find(t => t.name === name);
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
