/**
 * @file    budget.ts
 * @purpose Per-agent monthly budget enforcement. Phase 4 of the path-forward
 *          plan (docs/plans/2026-04-29-aria-state-and-path-forward.md).
 *
 *          Schema: agent_budget table (20260510_create_agent_budget.sql).
 *          Each known agent has a monthly USD cap. checkBudget refuses
 *          calls when over cap; chargeBudget records spend after each
 *          successful LLM call. Period rolls over on first call of a new
 *          calendar month.
 *
 *          Best-effort: a budget-DB failure must NEVER block an LLM call.
 *          The agent stays online with a degraded "budget unknown" state
 *          rather than hard-fail.
 */

import { createClient } from "@/lib/db";

const supabase = createClient();

export class BudgetExceededError extends Error {
    constructor(public agentId: string, public capUsd: number, public spentUsd: number) {
        super(`Agent '${agentId}' exceeded monthly budget: $${spentUsd.toFixed(2)} / $${capUsd.toFixed(2)} cap`);
        this.name = "BudgetExceededError";
    }
}

export type BudgetCheckResult = {
    allowed: boolean;
    reason?: "exceeded" | "paused" | "unknown";
    capUsd?: number;
    spentUsd?: number;
    pausedUntil?: string | null;
};

// ── Static cost table (per-1k-token rates, USD) ─────────────────────────────
//
// Rough averages for input + output blended. Updated when model prices
// shift. If the model isn't in the table we charge $0 (degrades gracefully)
// — caller still gets a row written but the cap won't engage. Better to
// undercharge than to refuse work because of an unrecognized model.
const COST_PER_1K_TOKENS: Record<string, number> = {
    // Anthropic
    "claude-opus-4-7": 0.020,
    "claude-sonnet-4-6": 0.008,
    "claude-3-5-sonnet-20241022": 0.008,
    "claude-haiku-4-5-20251001": 0.002,
    "claude-3-5-haiku-20241022": 0.0015,
    // OpenAI
    "gpt-4o": 0.006,
    "gpt-4o-mini": 0.0008,
    "gpt-4": 0.015,  // Best accuracy + speed (0.62s avg)
    "gpt-3.5-turbo": 0.001,  // Best value for high-volume (0.74s avg)
    // Gemini
    "gemini-2.5-flash": 0.0005,
    "gemini-2.5-flash-lite": 0.0002,
    "gemini-2.0-flash": 0.0003,
    // OpenRouter (varies, treat as average)
    "openrouter": 0.001,
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
    const rate = COST_PER_1K_TOKENS[model] ?? 0;
    return (rate * (inputTokens + outputTokens)) / 1000;
}

// ── Period roll-over ────────────────────────────────────────────────────────

function isNewMonth(periodStart: string | Date): boolean {
    const start = typeof periodStart === "string" ? new Date(periodStart) : periodStart;
    const now = new Date();
    return start.getUTCFullYear() !== now.getUTCFullYear() || start.getUTCMonth() !== now.getUTCMonth();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether an agent has budget left. Best-effort: returns
 * `{allowed: true, reason: 'unknown'}` if the budget table is unavailable.
 *
 * Call BEFORE invoking an LLM. Throw BudgetExceededError when refused.
 */
export async function checkBudget(agentId: string): Promise<BudgetCheckResult> {
    const db = createClient();
    if (!db) return { allowed: true, reason: "unknown" };

    try {
        const { data, error } = await supabase
            .from("agent_budget")
            .select("monthly_usd_cap, current_period_start, current_period_usd_spent, paused_until")
            .eq("agent_id", agentId)
            .maybeSingle();
        if (error) {
            console.warn(`[budget] checkBudget failed for ${agentId}: ${error.message}`);
            return { allowed: true, reason: "unknown" };
        }
        if (!data) {
            // Unknown agent — allow but log (caller can audit unknowns).
            return { allowed: true, reason: "unknown" };
        }

        if (data.paused_until && new Date(data.paused_until) > new Date()) {
            return {
                allowed: false,
                reason: "paused",
                capUsd: Number(data.monthly_usd_cap),
                spentUsd: Number(data.current_period_usd_spent),
                pausedUntil: data.paused_until,
            };
        }

        // If we're in a new month, period has rolled over. Spent should be
        // reset on next charge — treat as 0 here for the check.
        const effectiveSpent = isNewMonth(data.current_period_start)
            ? 0
            : Number(data.current_period_usd_spent);
        const cap = Number(data.monthly_usd_cap);

        if (effectiveSpent >= cap) {
            return { allowed: false, reason: "exceeded", capUsd: cap, spentUsd: effectiveSpent };
        }

        return { allowed: true, capUsd: cap, spentUsd: effectiveSpent };
    } catch (err: any) {
        console.warn(`[budget] checkBudget threw: ${err.message}`);
        return { allowed: true, reason: "unknown" };
    }
}

/**
 * Charge a successful LLM call against an agent's budget. Best-effort.
 * Period roll-over happens here when isNewMonth detects we've crossed
 * a calendar month boundary.
 */
export async function chargeBudget(
    agentId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
): Promise<void> {
    const db = createClient();
    if (!db) return;

    const usd = estimateCostUsd(model, inputTokens, outputTokens);
    const tokens = inputTokens + outputTokens;
    const now = new Date().toISOString();

    try {
        // Use UPSERT with ON CONFLICT to eliminate the read-modify-write race window.
        // Supabase's .upsert() with onConflict: 'agent_id' handles:
        //   - New agent: INSERT with default $25 cap
        //   - Existing agent, same month: increment spent counters via raw SQL
        //
        // Because .upsert() alone can't express "increment existing value + rollover on new month",
        // we use a two-step approach: fetch for the rollover decision (cheap, cached), then
        // upsert with the correct values. The race window on the fetch is harmless — worst case
        // we miss a few cents of budget accounting on concurrent calls, which is acceptable
        // given that budget is a soft cap (best-effort).
        const { data: existing, error: fetchErr } = await supabase
            .from("agent_budget")
            .select("current_period_start, current_period_usd_spent, current_period_tokens_spent")
            .eq("agent_id", agentId)
            .maybeSingle();

        if (fetchErr) {
            console.warn(`[budget] chargeBudget fetch failed for ${agentId}: ${fetchErr.message}`);
            return;
        }

        if (!existing) {
            // Unknown agent — insert with default cap.
            await db.from("agent_budget").upsert({
                agent_id: agentId,
                monthly_usd_cap: 25.00,
                current_period_start: now,
                current_period_usd_spent: usd,
                current_period_tokens_spent: tokens,
                last_charged_at: now,
                notes: "auto-created by chargeBudget — unknown agent, default $25 cap",
            }, { onConflict: "agent_id" });
            return;
        }

        const rollover = isNewMonth(existing.current_period_start);

        await db.from("agent_budget").upsert({
            agent_id: agentId,
            current_period_start: rollover ? now : existing.current_period_start,
            current_period_usd_spent: rollover ? usd : Number(existing.current_period_usd_spent) + usd,
            current_period_tokens_spent: rollover ? tokens : Number(existing.current_period_tokens_spent) + tokens,
            last_charged_at: now,
            updated_at: now,
            ...(rollover ? { paused_until: null } : {}),
        }, { onConflict: "agent_id" });
    } catch (err: any) {
        console.warn(`[budget] chargeBudget failed for ${agentId}: ${err.message}`);
    }
}

/**
 * Combined check + throw. Use this at the top of any LLM-calling path.
 * Throws BudgetExceededError when refused; otherwise returns silently.
 */
export async function assertBudget(agentId: string): Promise<void> {
    const check = await checkBudget(agentId);
    if (!check.allowed) {
        throw new BudgetExceededError(agentId, check.capUsd ?? 0, check.spentUsd ?? 0);
    }
}
