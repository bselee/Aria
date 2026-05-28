/**
 * @file    src/lib/intelligence/cognitive-round.ts
 * @purpose Unified cognition layer — the "soul" of Aria. Surveys all operational
 *          state every 15 minutes and makes priority decisions. Replaces flat
 *          cron scheduling with adaptive, context-aware orchestration.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase, @/lib/storage/local-db
 *
 * ARCHITECTURE:
 *   Every 15 min, runCognitiveRound() gathers state from Supabase + SQLite,
 *   applies deterministic rules (NO LLM), and produces CognitiveDecisions.
 *   The scheduler reads these to suppress/boost cron jobs for that cycle.
 *
 *   This is where Hermia's cognition lives inside Aria's runtime.
 */

import { createClient } from "@/lib/supabase";
import { getLocalDb } from "@/lib/storage/local-db";

// ── State ───────────────────────────────────────────────────────────────────

export interface CognitiveState {
    inboxDepth: { default: number; ap: number };
    pendingApprovals: number;
    cronFailures: Array<{ job: string; count: number; lastFailed: string }>;
    agentHeartbeats: Array<{ agent: string; status: string; lastBeat: string }>;
    poPipeline: Array<{ stage: string; count: number }>;
    timeContext: { hour: number; dayOfWeek: number; isBusinessHours: boolean; isWeekend: boolean };
}

// ── Decision ────────────────────────────────────────────────────────────────

export interface CognitiveDecision {
    priority: "critical" | "high" | "medium" | "low";
    action: string;
    suppress: string[];
    boost: string[];
    summary: string;
}

// ── State Gathering ─────────────────────────────────────────────────────────

function getTimeContext(): CognitiveState["timeContext"] {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
    return {
        hour,
        dayOfWeek,
        isBusinessHours: hour >= 7 && hour < 22,
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    };
}

async function gatherState(): Promise<CognitiveState> {
    const timeContext = getTimeContext();
    const state: CognitiveState = {
        inboxDepth: { default: 0, ap: 0 },
        pendingApprovals: 0,
        cronFailures: [],
        agentHeartbeats: [],
        poPipeline: [],
        timeContext,
    };

    // Supabase queries (best-effort — failures degrade gracefully to empty state)
    const supabase = createClient();
    if (supabase) {
        try {
            // Agent heartbeats
            const { data: heartbeats } = await supabase
                .from("agent_heartbeats")
                .select("agent_name, status, heartbeat_at")
                .order("heartbeat_at", { ascending: false });
            if (heartbeats) {
                state.agentHeartbeats = (heartbeats as any[]).map(h => ({
                    agent: h.agent_name,
                    status: h.status,
                    lastBeat: h.heartbeat_at,
                }));
            }

            // Recent cron failures (last 1 hour)
            const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
            const { data: failures } = await supabase
                .from("cron_runs")
                .select("job_name, status, started_at")
                .eq("status", "failed")
                .gte("started_at", oneHourAgo);
            if (failures && failures.length > 0) {
                const byJob = new Map<string, { count: number; lastFailed: string }>();
                for (const f of failures as any[]) {
                    const existing = byJob.get(f.job_name);
                    if (existing) {
                        existing.count++;
                        if (f.started_at > existing.lastFailed) existing.lastFailed = f.started_at;
                    } else {
                        byJob.set(f.job_name, { count: 1, lastFailed: f.started_at });
                    }
                }
                state.cronFailures = Array.from(byJob.entries()).map(([job, v]) => ({
                    job,
                    count: v.count,
                    lastFailed: v.lastFailed,
                }));
            }

            // Pending approvals
            const { count: approvalCount } = await supabase
                .from("ap_pending_approvals")
                .select("*", { count: "exact", head: true })
                .is("applied_at", null);
            if (typeof approvalCount === "number") {
                state.pendingApprovals = approvalCount;
            }
        } catch (err: any) {
            console.warn(`[CognitiveRound] Supabase gather failed (non-fatal): ${err.message}`);
        }
    }

    // Local SQLite: purchasing calendar events (PO pipeline)
    try {
        const db = getLocalDb();
        const stages = db.prepare(
            `SELECT status, COUNT(*) as count FROM purchasing_calendar_events GROUP BY status`
        ).all() as Array<{ status: string; count: number }>;
        state.poPipeline = stages.map(s => ({ stage: s.status, count: s.count }));
    } catch {
        // Non-fatal — PO pipeline starts empty
    }

    return state;
}

// ── Decision Engine ─────────────────────────────────────────────────────────

function evaluateState(state: CognitiveState): CognitiveDecision[] {
    const decisions: CognitiveDecision[] = [];

    // Rule 1: AP inbox overload
    if (state.inboxDepth.ap > 10) {
        decisions.push({
            priority: "critical",
            action: "AP inbox overload — prioritize email pipeline",
            suppress: ["stat-indexing", "housekeeping"],
            boost: ["ap-polling"],
            summary: `${state.inboxDepth.ap} unprocessed AP emails`,
        });
    }

    // Rule 2: Stale approvals
    if (state.pendingApprovals > 5) {
        decisions.push({
            priority: "high",
            action: "Stale approval backlog — resend reminders",
            suppress: [],
            boost: [],
            summary: `${state.pendingApprovals} pending approvals`,
        });
    }

    // Rule 3: Cron failure cascade
    const failedJobs = state.cronFailures.reduce((sum, f) => sum + f.count, 0);
    if (failedJobs >= 3) {
        decisions.push({
            priority: "high",
            action: "Multiple cron failures — escalate to supervisor",
            suppress: ["stat-indexing", "migration-tripwire"],
            boost: [],
            summary: `${failedJobs} cron failures in last hour: ${state.cronFailures.map(f => f.job).join(", ")}`,
        });
    }

    // Rule 4: Off-hours quiet mode
    if (!state.timeContext.isBusinessHours) {
        decisions.push({
            priority: "low",
            action: "Off-hours quiet mode",
            suppress: ["daily-summary", "build-risk", "weekly-summary", "missing-reconciliation-watchdog"],
            boost: [],
            summary: `Hour ${state.timeContext.hour} — business hours only jobs suppressed`,
        });
    }

    // Rule 5: Weekend suppression
    if (state.timeContext.isWeekend) {
        decisions.push({
            priority: "low",
            action: "Weekend — suppress weekday-only jobs",
            suppress: ["daily-summary", "build-risk", "weekly-summary", "qty-calibration", "missing-reconciliation-watchdog", "po-followup-watcher", "po-stuck-detector"],
            boost: [],
            summary: `Day ${state.timeContext.dayOfWeek} — weekday jobs suppressed`,
        });
    }

    // Rule 6: Agent heartbeat degradation
    const staleAgents = state.agentHeartbeats.filter(h => {
        const elapsed = Date.now() - new Date(h.lastBeat).getTime();
        return elapsed > 900000; // 15 min stale
    });
    if (staleAgents.length > 0) {
        decisions.push({
            priority: "medium",
            action: `Stale agent heartbeats: ${staleAgents.map(a => a.agent).join(", ")}`,
            suppress: [],
            boost: [],
            summary: `${staleAgents.length} agents haven't reported in 15+ minutes`,
        });
    }

    // Default: normal operations
    if (decisions.length === 0) {
        decisions.push({
            priority: "medium",
            action: "Normal operations — no overrides",
            suppress: [],
            boost: [],
            summary: `All clear. AP:${state.inboxDepth.ap} Approvals:${state.pendingApprovals} CronFailures:${failedJobs}`,
        });
    }

    return decisions;
}

// ── Merge decisions into a single actionable decision ───────────────────────

function mergeDecisions(decisions: CognitiveDecision[]): CognitiveDecision {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...decisions].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    const allSuppress = new Set<string>();
    const allBoost = new Set<string>();
    const summaries: string[] = [];

    for (const d of sorted) {
        d.suppress.forEach(s => allSuppress.add(s));
        d.boost.forEach(b => allBoost.add(b));
        summaries.push(d.summary);
    }

    // Boost overrides suppress (if same job in both, boost wins)
    for (const b of Array.from(allBoost)) allSuppress.delete(b);

    return {
        priority: sorted[0].priority,
        action: sorted[0].action,
        suppress: Array.from(allSuppress),
        boost: Array.from(allBoost),
        summary: summaries.join(" | "),
    };
}

// ── Persist Decision ────────────────────────────────────────────────────────

function logDecision(state: CognitiveState, decision: CognitiveDecision, durationMs: number): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `INSERT INTO cognitive_rounds (ran_at, state_json, decisions_json, duration_ms)
             VALUES (datetime('now'), ?, ?, ?)`
        ).run(
            JSON.stringify({
                inboxDepth: state.inboxDepth,
                pendingApprovals: state.pendingApprovals,
                cronFailureCount: state.cronFailures.reduce((s, f) => s + f.count, 0),
                staleAgentCount: state.agentHeartbeats.filter(h => Date.now() - new Date(h.lastBeat).getTime() > 900000).length,
                timeContext: state.timeContext,
            }),
            JSON.stringify(decision),
            durationMs,
        );
    } catch (err: any) {
        console.warn(`[CognitiveRound] Failed to log decision (non-fatal): ${err.message}`);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a cognitive round. Gathers state, evaluates, decides, logs, returns.
 * Called every 15 minutes by the cron scheduler.
 *
 * @returns The merged CognitiveDecision for this cycle
 */
export async function runCognitiveRound(): Promise<CognitiveDecision> {
    const start = Date.now();

    const state = await gatherState();
    const decisions = evaluateState(state);
    const merged = mergeDecisions(decisions);

    const durationMs = Date.now() - start;
    logDecision(state, merged, durationMs);

    console.log(
        `[CognitiveRound] ${merged.priority.toUpperCase()} | ${merged.summary} | ` +
        `${merged.suppress.length} suppressed, ${merged.boost.length} boosted | ${durationMs}ms`
    );

    return merged;
}

/**
 * Get recent cognitive round decisions from SQLite.
 * Used by the dashboard panel to show the last 24h of decisions.
 */
export function getRecentDecisions(hours = 24): Array<{
    ranAt: string;
    state: Record<string, unknown>;
    decision: CognitiveDecision;
    durationMs: number;
}> {
    try {
        const db = getLocalDb();
        const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
        const rows = db.prepare(
            `SELECT ran_at, state_json, decisions_json, duration_ms
             FROM cognitive_rounds
             WHERE ran_at >= ?
             ORDER BY ran_at DESC
             LIMIT 100`
        ).all(cutoff) as Array<{
            ran_at: string;
            state_json: string;
            decisions_json: string;
            duration_ms: number;
        }>;

        return rows.map(r => ({
            ranAt: r.ran_at,
            state: JSON.parse(r.state_json),
            decision: JSON.parse(r.decisions_json),
            durationMs: r.duration_ms,
        }));
    } catch (err: any) {
        console.warn(`[CognitiveRound] Failed to read decisions (non-fatal): ${err.message}`);
        return [];
    }
}
