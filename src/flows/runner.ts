/**
 * @file    src/flows/runner.ts
 * @purpose The flow runner. One entry point, `tick()`, called from a cron job
 *          every minute. Responsibilities:
 *            1. Drain unprocessed events from flow_events.
 *            2. For each event, find every matching FlowDef in the registry
 *               and spawn a new flow_run.
 *            3. Synchronously run the new run's first step.
 *            4. Resume RUNNING runs whose current step is 'retry'-ready.
 *
 *          A step has four possible outcomes (see types.ts):
 *            - succeeded → advance to `next` or SUCCEED the run.
 *            - retry    → bump attempts; auto-escalate if past maxAttempts.
 *            - waiting  → leave RUNNING, do nothing; an inbound event later
 *                         must advance via resumeRun(eventToRun) (phase 2).
 *            - escalate → BREACH the run; surface to agent_task.
 *
 *          The escalation principle: silent stalls are not possible.
 *          Steps either resolve, wait on a known external event, or
 *          deliberately surface to Will.
 */

import { createClient } from "@/lib/supabase";
import { flowsForEvent, getFlow } from "./registry";
import * as agentTask from "@/lib/intelligence/agent-task";
import type {
    FlowEventRow,
    FlowRunRow,
    StepResult,
} from "./types";

const EVENT_BATCH = 50;
const RETRY_BATCH = 25;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface TickStats {
    eventsProcessed: number;
    spawned: number;
    advanced: number;
    failed: number;
    escalated: number;
    retried: number;
}

export async function tick(): Promise<TickStats> {
    const stats: TickStats = {
        eventsProcessed: 0,
        spawned: 0,
        advanced: 0,
        failed: 0,
        escalated: 0,
        retried: 0,
    };
    const sb = createClient();
    if (!sb) return stats;

    // ── 1. drain new events ──────────────────────────────────────
    const { data: eventRows, error: evErr } = await sb
        .from("flow_events")
        .select("*")
        .is("processed_at", null)
        .order("emitted_at", { ascending: true })
        .limit(EVENT_BATCH);
    if (evErr) {
        console.warn(`[flows] tick: fetch events failed: ${evErr.message}`);
        return stats;
    }

    for (const event of (eventRows ?? []) as FlowEventRow[]) {
        const flows = flowsForEvent(event.type);
        for (const def of flows) {
            const init = def.init(event);
            const insert = {
                flow_name: def.name,
                status: "RUNNING" as const,
                current_step: def.firstStep,
                triggered_by_event: event.id,
                correlation_id: init.correlationId ?? event.correlation_id ?? null,
                inputs: init.inputs,
                deadline_at: init.deadlineMs
                    ? new Date(Date.now() + init.deadlineMs).toISOString()
                    : null,
            };
            const { data: runData, error: insErr } = await sb
                .from("flow_runs")
                .insert(insert)
                .select("*")
                .single();
            if (insErr) {
                console.warn(`[flows] spawn ${def.name} failed: ${insErr.message}`);
                continue;
            }
            stats.spawned++;
            const advanced = await advance(runData as FlowRunRow, event);
            tallyOutcome(stats, advanced);
        }
        await sb
            .from("flow_events")
            .update({ processed_at: new Date().toISOString() })
            .eq("id", event.id);
        stats.eventsProcessed++;
    }

    // ── 2. resume retry-eligible runs ────────────────────────────
    // A run is retry-eligible if it's RUNNING and its state.retry_at <= now.
    const nowIso = new Date().toISOString();
    const { data: retryRows } = await sb
        .from("flow_runs")
        .select("*")
        .eq("status", "RUNNING")
        .lte("state->>retry_at", nowIso)
        .limit(RETRY_BATCH);
    for (const run of (retryRows ?? []) as FlowRunRow[]) {
        const outcome = await advance(run, null);
        tallyOutcome(stats, outcome);
        if (outcome === "retried") stats.retried++;
    }

    return stats;
}

type Outcome = "succeeded" | "failed" | "waiting" | "escalated" | "retried";

function tallyOutcome(stats: TickStats, outcome: Outcome): void {
    if (outcome === "succeeded") stats.advanced++;
    else if (outcome === "failed") stats.failed++;
    else if (outcome === "escalated") stats.escalated++;
    else if (outcome === "retried") stats.retried++;
}

async function advance(
    run: FlowRunRow,
    event: FlowEventRow | null,
): Promise<Outcome> {
    const sb = createClient();
    if (!sb) return "failed";
    const def = getFlow(run.flow_name);
    if (!def) {
        await markFailed(run.id, `flow "${run.flow_name}" not registered`);
        return "failed";
    }
    const stepName = run.current_step ?? def.firstStep;
    const step = def.steps[stepName];
    if (!step) {
        await markFailed(run.id, `step "${stepName}" missing from "${run.flow_name}"`);
        return "failed";
    }

    let result: StepResult;
    try {
        result = await step.run({
            runId: run.id,
            flowName: run.flow_name,
            inputs: run.inputs ?? {},
            state: run.state ?? {},
            event,
            attempts: run.attempts ?? 0,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await markFailed(run.id, `step "${stepName}" threw: ${msg}`);
        return "failed";
    }

    const nowIso = new Date().toISOString();
    const stateBase = run.state ?? {};
    const stateNext = { ...stateBase, ...(result.stateUpdate ?? {}) };
    delete (stateNext as Record<string, unknown>).retry_at; // clear stale retry marker

    if (result.kind === "succeeded") {
        if (result.next && def.steps[result.next]) {
            await sb.from("flow_runs").update({
                current_step: result.next,
                state: stateNext,
                attempts: 0, // reset for new step
                updated_at: nowIso,
            }).eq("id", run.id);
            return "succeeded";
        }
        await sb.from("flow_runs").update({
            status: "SUCCEEDED",
            state: stateNext,
            updated_at: nowIso,
            completed_at: nowIso,
        }).eq("id", run.id);
        return "succeeded";
    }

    if (result.kind === "waiting") {
        await sb.from("flow_runs").update({
            state: stateNext,
            updated_at: nowIso,
        }).eq("id", run.id);
        return "waiting";
    }

    if (result.kind === "retry") {
        const nextAttempts = (run.attempts ?? 0) + 1;
        const maxAttempts = step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        if (nextAttempts >= maxAttempts) {
            await escalate(
                run.id,
                run.flow_name,
                stepName,
                run.inputs ?? {},
                `step "${stepName}" exhausted ${maxAttempts} attempts: ${result.reason}`,
                stateNext,
            );
            return "escalated";
        }
        // backoff: 30s * 2^(attempt-1), capped at 30m
        const backoffMs = Math.min(30_000 * 2 ** (nextAttempts - 1), 30 * 60_000);
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await sb.from("flow_runs").update({
            state: { ...stateNext, retry_at: retryAt, last_retry_reason: result.reason },
            attempts: nextAttempts,
            updated_at: nowIso,
        }).eq("id", run.id);
        return "retried";
    }

    // result.kind === 'escalate'
    await escalate(
        run.id,
        run.flow_name,
        stepName,
        run.inputs ?? {},
        result.reason,
        stateNext,
    );
    return "escalated";
}

async function markFailed(runId: string, reason: string): Promise<void> {
    const sb = createClient();
    if (!sb) return;
    const nowIso = new Date().toISOString();
    await sb.from("flow_runs").update({
        status: "FAILED",
        failure_reason: reason,
        updated_at: nowIso,
        completed_at: nowIso,
    }).eq("id", runId);
}

async function escalate(
    runId: string,
    flowName: string,
    stepName: string,
    inputs: Record<string, unknown>,
    reason: string,
    state: Record<string, unknown>,
): Promise<void> {
    const sb = createClient();
    if (!sb) return;
    const nowIso = new Date().toISOString();

    let taskId: string | null = null;
    try {
        const task = await agentTask.incrementOrCreate({
            sourceTable: "flow_runs",
            sourceId: runId,
            type: "agent_exception",
            goal: `Flow ${flowName}/${stepName} needs human review`,
            status: "NEEDS_APPROVAL",
            owner: "will",
            priority: 2,
            requiresApproval: true,
            inputs: {
                flow_name: flowName,
                step: stepName,
                reason,
                flow_inputs: inputs,
            },
        });
        taskId = task?.id ?? null;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[flows] escalate ${flowName}: hub write failed: ${msg}`);
    }

    await sb.from("flow_runs").update({
        status: "BREACHED",
        failure_reason: reason,
        escalated_task_id: taskId,
        state,
        updated_at: nowIso,
        completed_at: nowIso,
    }).eq("id", runId);
}
