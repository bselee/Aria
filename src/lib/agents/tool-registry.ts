/**
 * @file    tool-registry.ts
 * @purpose Aria-wide tool registry — borrows AIOS's "Tool Manager" idea
 *          (typed tool descriptors + handler dispatch + audit) and adapts
 *          it to Aria's existing surfaces (copilot core, /tasks bot,
 *          dashboard, future agents).
 *
 *          Three things this module owns that the existing copilot tools
 *          file doesn't:
 *
 *            1. METADATA — every tool declares category, scopes (read/write
 *               kinds), and an `agentScope` list of which agents may call
 *               it. This is the foundation for runtime permission gating
 *               and for the dashboard "what can this agent do" view.
 *
 *            2. AUDIT — each invocation can be wrapped in
 *               `withToolAudit()` to emit a structured event to
 *               task_history (`event_type='tool_call'`) so the issue
 *               ledger can show "AP-Reconciler called lookup_product 3
 *               times during issue X".
 *
 *            3. CATALOG — `listTools()` returns a stable JSON shape that
 *               `/api/command-board/tools` exposes to the dashboard so
 *               Will can see the live capability surface in one place
 *               alongside skills and workflows.
 *
 *          Day 3 scope: scaffold the registry + register the 8 existing
 *          copilot read tools by reference (no behavior change). Migrating
 *          additional tool sources (bot inline tools, finale helpers,
 *          gmail helpers, slack helpers) lands incrementally.
 *
 *          See docs on the AIOS Tool Manager:
 *          https://github.com/agiresearch/AIOS — borrowed pattern, NOT
 *          a runtime dependency.
 */

import type { Tool } from "ai";
import { createClient } from "@/lib/supabase";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Top-level grouping for the dashboard catalog. Pick the closest match;
 * if none fits, add a new category here rather than overloading existing
 * ones — the dashboard groups by this field.
 */
export type ToolCategory =
    | "finale"        // PO / inventory / supplier reads + writes
    | "supabase"      // database reads on local tables
    | "ap"            // AP-pipeline-specific (invoices, reconciliation)
    | "purchasing"    // velocity / urgency / draft PO creation
    | "scraping"      // browser-driven data fetches
    | "memory"        // Pinecone / vector recall
    | "telegram"      // bot-side comms
    | "slack"         // Slack reads / 👀 reactions
    | "gmail"         // Gmail reads / forwards
    | "build"         // calendar / build-risk
    | "tracking"      // shipment / carrier APIs
    | "system";       // health checks, diagnostics

/**
 * Effect class. Read tools may be invoked freely from chat surfaces;
 * write tools require explicit user authorization in the calling flow.
 */
export type ToolScope = "read" | "write" | "side-effect";

/**
 * Which agent identities may invoke the tool. Empty array = no
 * restriction (any agent). Use this to gate destructive tools to
 * specific operators. Phase 2 enforcement is advisory only — the
 * registry logs the agent on each call, but does not yet refuse.
 */
export type AgentScope = readonly string[];

export type RegisteredTool = {
    name: string;
    description: string;
    category: ToolCategory;
    scope: ToolScope;
    /** Empty = unrestricted. Otherwise list of HANDLER ids. */
    agentScope: AgentScope;
    /**
     * The actual tool descriptor. Today this is the AI SDK `Tool` shape
     * (description + inputSchema + execute). Keep it loose so we can
     * register tools authored in different shapes without rewriting them.
     */
    tool: Tool;
};

export type ToolListItem = Omit<RegisteredTool, "tool"> & {
    /** True if the tool is callable from chat surfaces (read scope). */
    safeForChat: boolean;
};

// ── Registry storage ─────────────────────────────────────────────────────────

const registry = new Map<string, RegisteredTool>();

/**
 * Register a tool. Idempotent: re-registering the same name overwrites
 * the previous entry (useful for hot-reload during dev). Tests must
 * reset the registry via `__resetRegistryForTests()` to avoid leakage.
 */
export function registerTool(tool: RegisteredTool): void {
    if (!tool.name) throw new Error("tool-registry: name is required");
    registry.set(tool.name, tool);
}

export function getTool(name: string): RegisteredTool | undefined {
    return registry.get(name);
}

export type ListToolsFilter = {
    category?: ToolCategory;
    scope?: ToolScope;
    agentScope?: string;
};

export function listTools(filter: ListToolsFilter = {}): ToolListItem[] {
    const out: ToolListItem[] = [];
    for (const t of registry.values()) {
        if (filter.category && t.category !== filter.category) continue;
        if (filter.scope && t.scope !== filter.scope) continue;
        if (filter.agentScope && t.agentScope.length > 0 && !t.agentScope.includes(filter.agentScope)) continue;
        out.push({
            name: t.name,
            description: t.description,
            category: t.category,
            scope: t.scope,
            agentScope: t.agentScope,
            safeForChat: t.scope === "read",
        });
    }
    out.sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.name.localeCompare(b.name);
    });
    return out;
}

/** TEST ONLY — clear the registry between tests to avoid order-dependence. */
export function __resetRegistryForTests(): void {
    registry.clear();
}

// ── Audit ────────────────────────────────────────────────────────────────────

/**
 * Audit-wrap a tool invocation. Writes a `tool_call` event to
 * task_history with the agent, tool name, duration, and a one-line
 * argument summary. Best-effort: a logging failure does not break the
 * tool call itself.
 *
 * Use at call sites that have a known agent identity. Anonymous
 * surfaces (raw test scripts, REPL) can call the tool's `execute`
 * directly without the wrapper.
 */
export type ToolAuditContext = {
    agent: string;            // HANDLER.AP_AGENT, HANDLER.WILL, etc.
    issueId?: string | null;  // optional issue scope
    taskId?: string | null;   // optional task scope
    threadId?: string | null;
};

export async function withToolAudit<T>(
    toolName: string,
    ctx: ToolAuditContext,
    args: unknown,
    fn: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now();
    let succeeded = false;
    let errorMessage: string | undefined;
    try {
        const result = await fn();
        succeeded = true;
        return result;
    } catch (err: any) {
        errorMessage = err?.message ?? String(err);
        throw err;
    } finally {
        const durationMs = Date.now() - startedAt;
        emitAuditEvent({
            toolName,
            ctx,
            args,
            durationMs,
            succeeded,
            errorMessage,
        }).catch(() => {
            /* swallow — audit must never break the call */
        });
    }
}

async function emitAuditEvent(input: {
    toolName: string;
    ctx: ToolAuditContext;
    args: unknown;
    durationMs: number;
    succeeded: boolean;
    errorMessage?: string;
}): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;
    try {
        const argsSummary = summarizeArgs(input.args);
        await supabase.from("task_history").insert({
            task_id: input.ctx.taskId ?? null,
            issue_id: input.ctx.issueId ?? null,
            agent_name: input.ctx.agent,
            task_type: "tool_call",
            event_type: "tool_call",
            status: input.succeeded ? "success" : "failure",
            input_summary: `${input.toolName}(${argsSummary})`,
            output_summary: input.errorMessage ? `error: ${input.errorMessage}` : `ok in ${input.durationMs}ms`,
            execution_trace: {
                tool: input.toolName,
                args_summary: argsSummary,
                duration_ms: input.durationMs,
                ok: input.succeeded,
                error: input.errorMessage ?? null,
                thread_id: input.ctx.threadId ?? null,
            },
        });
    } catch {
        /* swallow */
    }
}

function summarizeArgs(args: unknown): string {
    if (args == null) return "";
    if (typeof args === "string") return args.slice(0, 80);
    if (typeof args !== "object") return String(args).slice(0, 80);
    try {
        const entries = Object.entries(args as Record<string, unknown>)
            .slice(0, 4)
            .map(([k, v]) => {
                const s = typeof v === "string" ? `"${v.slice(0, 32)}"`
                    : typeof v === "object" ? "[obj]"
                    : String(v).slice(0, 32);
                return `${k}=${s}`;
            });
        return entries.join(", ");
    } catch {
        return "[unserializable]";
    }
}
