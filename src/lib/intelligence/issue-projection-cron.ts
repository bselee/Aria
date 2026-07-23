/**
 * @file    issue-projection-cron.ts
 * @purpose Phase 1 projection: scan recent agent_task rows, group by
 *          business-flow key, ensure an agent_issue row exists for each
 *          group, and link the tasks back via agent_task.issue_id.
 *
 *          Runs every 5 min from OpsManager. Best-effort — a failure
 *          here never blocks the spoke writers.
 *
 *          Backfill window per Will's spec: open agent_task rows at any
 *          age + terminal in last 14 days.
 */

import { createClient } from "@/lib/db";
import { listTasks, type AgentTask } from "./agent-task";
import { createOrAdvance, linkTask } from "./agent-issue";
import { groupTasksByFlow, deriveIssueState } from "./issue-projection";

const supabase = createClient();

const TERMINAL_WINDOW_MS = 14 * 24 * 3600 * 1000;

export type ProjectionSummary = {
    candidate_tasks: number;
    groups: number;
    issues_created_or_advanced: number;
    tasks_linked: number;
    skipped_no_key: number;
};

export async function runIssueProjection(): Promise<ProjectionSummary> {
    const summary: ProjectionSummary = {
        candidate_tasks: 0,
        groups: 0,
        issues_created_or_advanced: 0,
        tasks_linked: 0,
        skipped_no_key: 0,
    };

    const db = createClient();
    if (!db) return summary;

    // Pull all open tasks (any age) + recent terminal tasks (last 14 days).
    const open = await listTasks({ limit: 500, includeRecentFailed: true });
    const since = new Date(Date.now() - TERMINAL_WINDOW_MS).toISOString();
    const { data: closed } = await db
        .from("agent_task")
        .select("*")
        .in("status", ["SUCCEEDED", "APPROVED", "CANCELLED", "REJECTED", "FAILED", "EXPIRED"])
        .gte("completed_at", since)
        .limit(500);
    const candidates: AgentTask[] = [...open, ...((closed ?? []) as AgentTask[])];
    summary.candidate_tasks = candidates.length;

    const groups = groupTasksByFlow(candidates);
    summary.groups = groups.size;
    summary.skipped_no_key = candidates.length - Array.from(groups.values()).reduce((n, arr) => n + arr.length, 0);

    for (const [key, tasks] of groups) {
        const derived = deriveIssueState(tasks);
        const first = tasks[0];
        try {
            const issue = await createOrAdvance({
                businessFlowKey: key,
                title: derived.title,
                sourceTable: first.source_table ?? null,
                sourceId: first.source_id ?? null,
                lifecycleState: derived.lifecycle_state,
                autonomyState: derived.autonomy_state,
                owner: derived.owner,
                inputs: derived.digest,
            });
            if (issue) {
                summary.issues_created_or_advanced += 1;
                for (const t of tasks) {
                    if (!t.issue_id || t.issue_id !== issue.id) {
                        await linkTask(t.id, issue.id);
                        summary.tasks_linked += 1;
                    }
                }
            }
        } catch (err) {
            console.warn(`[issue-projection] group ${key} failed:`, err instanceof Error ? err.message : err);
        }
    }

    return summary;
}
