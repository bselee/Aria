/**
 * @file    runner.ts
 * @purpose Single iteration of the self-healer. Query queued playbook
 *          tasks, dispatch each to its registered playbook, write the
 *          outcome back to the hub via setPlaybook + complete/fail/escalate.
 *
 *          Cap-per-cycle (5) prevents a buggy run from opening 50 PRs.
 *          Single-flight mutex prevents overlapping iterations from the
 *          same process.
 */

import { createClient } from "@/lib/supabase";
import {
    setPlaybook,
    complete,
    fail,
    appendEvent,
    type AgentTask,
} from "@/lib/intelligence/agent-task";
import { PLAYBOOK_BY_KIND } from "./registry";
import type { PlaybookContext } from "./types";

const PER_CYCLE_CAP = 5;
const QUEUE_FETCH_MULTIPLIER = 4; // pull oversized window for JS-side filter

let inFlight = false;

export type RunSummary = {
    attempted: number;
    succeeded: number;
    failed: number;
    escalated: number;
    skipped: number;
};

export async function runOnce(opts: { allow: PlaybookContext["allow"] }): Promise<RunSummary> {
    if (inFlight) {
        return { attempted: 0, succeeded: 0, failed: 0, escalated: 0, skipped: 1 };
    }
    inFlight = true;
    try {
        return await runIteration(opts);
    } finally {
        inFlight = false;
    }
}

async function runIteration(opts: { allow: PlaybookContext["allow"] }): Promise<RunSummary> {
    const supabase = createClient();
    if (!supabase) return { attempted: 0, succeeded: 0, failed: 0, escalated: 0, skipped: 1 };

    // Supabase doesn't support column-to-column comparison in chained filters,
    // so pull a window and apply retry_count < max_retries in JS. Cheaper than
    // a stored proc for cap-of-5 workload.
    const { data: rows } = await supabase
        .from("agent_task")
        .select("*")
        .in("playbook_state", ["queued", "failed"])
        .limit(PER_CYCLE_CAP * QUEUE_FETCH_MULTIPLIER);

    const tasks = ((rows as AgentTask[] | null) ?? [])
        .filter(t => (t.retry_count ?? 0) < (t.max_retries ?? 3))
        .filter(t => t.playbook_kind && PLAYBOOK_BY_KIND.has(t.playbook_kind))
        .slice(0, PER_CYCLE_CAP);

    let succeeded = 0;
    let failed = 0;
    let escalated = 0;

    for (const task of tasks) {
        const playbook = PLAYBOOK_BY_KIND.get(task.playbook_kind!)!;
        const params = playbook.match(task);
        if (!params) {
            await setPlaybook(task.id, task.playbook_kind!, "failed");
            await appendEvent(task.id, "playbook_match_failed", { playbook_kind: task.playbook_kind });
            failed++;
            continue;
        }

        await setPlaybook(task.id, task.playbook_kind!, "running");
        await appendEvent(task.id, "playbook_attempted", {
            playbook_kind: task.playbook_kind,
            retry: task.retry_count,
        });

        const ctx: PlaybookContext = {
            log: (msg, extra) => console.log(
                `[playbook=${task.playbook_kind} task=${task.id}] ${msg}`,
                extra ?? "",
            ),
            allow: opts.allow,
        };

        try {
            const result = await playbook.attempt(params, ctx);
            if (result.ok) {
                await setPlaybook(task.id, task.playbook_kind!, "succeeded");
                await complete(task.id, {
                    auto_handled_by: task.playbook_kind,
                    summary: result.summary,
                    pr_url: result.prUrl ?? null,
                    ...(result.detail ?? {}),
                });
                succeeded++;
            } else {
                await setPlaybook(task.id, task.playbook_kind!, "failed");
                const newRetry = (task.retry_count ?? 0) + 1;
                await supabase
                    .from("agent_task")
                    .update({ retry_count: newRetry })
                    .eq("id", task.id);
                if (!result.retryable || newRetry >= (task.max_retries ?? 3)) {
                    await supabase
                        .from("agent_task")
                        .update({ status: "NEEDS_APPROVAL", owner: "will" })
                        .eq("id", task.id);
                    await appendEvent(task.id, "playbook_escalated", { reason: result.error });
                    escalated++;
                } else {
                    failed++;
                }
            }
        } catch (err) {
            // Programmer error — don't retry, escalate immediately.
            await setPlaybook(task.id, task.playbook_kind!, "failed");
            await fail(task.id, err instanceof Error ? err.message : String(err));
            escalated++;
        }
    }

    return { attempted: tasks.length, succeeded, failed, escalated, skipped: 0 };
}
