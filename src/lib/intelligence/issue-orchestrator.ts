/**
 * @file    issue-orchestrator.ts
 * @purpose Production controller that evaluates open agent_issue rows
 *          and chooses the next bounded action per issue's control mode.
 *          Plan task 4 (docs/plans/2026-04-30-agentic-issue-orchestrator-control.md).
 *
 *          Boring decision logic on purpose: the first win is control +
 *          auditability, not smart planning. Smarter ranking lands later.
 *
 *          ENV GATE: `ISSUE_ORCHESTRATOR_ENABLED` (default false). The
 *          OpsManager only registers the cron when set to "true".
 *
 *          Control modes (from issue-control.ts):
 *            observe_only      → propose only (event), no patches
 *            suggest           → patch next_action, no task
 *            act_with_approval → create task with requiresApproval
 *            autonomous        → enqueue safe registered steps within budget
 */

import * as agentIssue from "./agent-issue";
import { listIssues } from "./agent-issue";
import { incrementOrCreate } from "./agent-task";
import { getIssueControlProfile, patchIssueControlProfile } from "./issue-control";
import type { AgentIssue } from "./agent-issue";

// ── Types ────────────────────────────────────────────────────────────────────

export type IssueNextAction =
    | { kind: "none"; reason: string }
    | { kind: "ask_will"; reason: string }
    | { kind: "wait_external"; reason: string }
    | { kind: "run_playbook"; playbookKind: string; reason: string }
    | { kind: "create_task"; taskType: string; goal: string; requiresApproval: boolean; reason: string }
    | { kind: "handoff"; handler: string; reason: string };

export type IssueEvaluation = {
    issueId: string;
    action: IssueNextAction;
    skipped: boolean;
    enqueuedTaskId: string | null;
};

export type IssueOrchestratorSummary = {
    evaluated: number;
    skipped: number;
    proposed: number;       // observe_only — event-only
    suggested: number;      // suggest — next_action patched
    tasksCreated: number;   // act_with_approval / autonomous
    errors: number;
    alreadyRunning?: boolean;
};

// ── Single-flight mutex ─────────────────────────────────────────────────────
let _running = false;

// ── Pure evaluator ──────────────────────────────────────────────────────────

/**
 * Decide the next-action for an issue based on its lifecycle/blocker/source.
 * Mode-gating (observe_only / suggest / act_with_approval / autonomous)
 * happens in `runIssueOrchestratorOnce` — this function is pure and only
 * looks at the issue's intrinsic state.
 *
 * Rules in order:
 *   1. complete → action=none, skipped=true
 *   2. paused (control.paused=true) → skipped=true
 *   3. blocked + human_approval_required → ask_will
 *   4. waiting_external → wait_external
 *   5. inputs.playbook_kind set → run_playbook
 *   6. AP-source issue with no open task → create_task w/ approval
 *   7. else → ask_will (safe default)
 */
export async function evaluateIssue(issue: AgentIssue): Promise<IssueEvaluation> {
    const profile = getIssueControlProfile(issue);

    // 1. Terminal — no work to do.
    if (issue.lifecycle_state === "complete") {
        return { issueId: issue.id, action: { kind: "none", reason: "issue is complete" }, skipped: true, enqueuedTaskId: null };
    }

    // 2. Paused — skip entirely.
    if (profile.paused === true) {
        return { issueId: issue.id, action: { kind: "none", reason: "issue is paused" }, skipped: true, enqueuedTaskId: null };
    }

    // 3. Blocked + human approval — surface to Will.
    if (issue.lifecycle_state === "blocked" && issue.blocker_reason === "human_approval_required") {
        return {
            issueId: issue.id,
            action: { kind: "ask_will", reason: "human_approval_required" },
            skipped: false,
            enqueuedTaskId: null,
        };
    }

    // 4. Waiting on external dep — no action.
    if (issue.lifecycle_state === "waiting_external") {
        return {
            issueId: issue.id,
            action: { kind: "wait_external", reason: "issue waiting_external" },
            skipped: false,
            enqueuedTaskId: null,
        };
    }

    // 5. Playbook hint in inputs → run that playbook.
    const playbookKind = (issue.inputs as Record<string, unknown> | null)?.playbook_kind;
    if (typeof playbookKind === "string" && playbookKind.length > 0) {
        return {
            issueId: issue.id,
            action: { kind: "run_playbook", playbookKind, reason: `playbook_kind=${playbookKind} on issue inputs` },
            skipped: false,
            enqueuedTaskId: null,
        };
    }

    // 6. AP-source issue without an open task → propose creating one.
    if (issue.source_table?.startsWith("ap_") && issue.source_id) {
        const linked = await agentIssue.findLinkedOpenTask(issue.id);
        if (!linked) {
            return {
                issueId: issue.id,
                action: {
                    kind: "create_task",
                    taskType: "ap_review",
                    goal: `Review AP issue: ${issue.title}`,
                    requiresApproval: true,
                    reason: "AP-source issue has no open task",
                },
                skipped: false,
                enqueuedTaskId: null,
            };
        }
    }

    // 7. Default — ask Will.
    return {
        issueId: issue.id,
        action: { kind: "ask_will", reason: "no rule matched; default to ask_will" },
        skipped: false,
        enqueuedTaskId: null,
    };
}

// ── Executor ────────────────────────────────────────────────────────────────

export type RunOptions = {
    /** Max issues to evaluate per cycle. Default 10. */
    limit?: number;
};

/**
 * Run a single orchestrator cycle. Single-flight: a concurrent invocation
 * returns `{alreadyRunning: true}` instead of running twice.
 */
export async function runIssueOrchestratorOnce(opts: RunOptions = {}): Promise<IssueOrchestratorSummary> {
    if (_running) {
        return { evaluated: 0, skipped: 0, proposed: 0, suggested: 0, tasksCreated: 0, errors: 0, alreadyRunning: true };
    }
    _running = true;
    const limit = opts.limit ?? 10;
    const summary: IssueOrchestratorSummary = {
        evaluated: 0,
        skipped: 0,
        proposed: 0,
        suggested: 0,
        tasksCreated: 0,
        errors: 0,
    };

    try {
        const issues = await listIssues({ limit });
        const slice = issues.slice(0, limit);

        for (const issue of slice) {
            summary.evaluated += 1;
            try {
                const evalResult = await evaluateIssue(issue);
                if (evalResult.skipped) {
                    summary.skipped += 1;
                    continue;
                }

                const profile = getIssueControlProfile(issue);

                // observe_only: write a proposal event only.
                if (profile.mode === "observe_only") {
                    await appendOrchestratorEvent(issue.id, "issue_orchestrator_proposed", evalResult.action);
                    summary.proposed += 1;
                    continue;
                }

                // suggest: patch next_action, no task creation.
                if (profile.mode === "suggest") {
                    const summaryText = describeAction(evalResult.action);
                    await patchIssueControlProfile(issue, { /* no-op patch keeps timestamp */ });
                    await updateNextActionOnly(issue.id, summaryText);
                    await appendOrchestratorEvent(issue.id, "issue_orchestrator_suggested", evalResult.action);
                    summary.suggested += 1;
                    continue;
                }

                // act_with_approval / autonomous: handle action by kind.
                if (evalResult.action.kind === "create_task") {
                    const requiresApproval =
                        evalResult.action.requiresApproval || profile.mode === "act_with_approval";
                    const task = await incrementOrCreate({
                        sourceTable: "agent_issue",
                        sourceId: issue.id,
                        type: evalResult.action.taskType,
                        goal: evalResult.action.goal,
                        status: requiresApproval ? "NEEDS_APPROVAL" : "PENDING",
                        owner: requiresApproval ? "will" : "aria",
                        priority: issue.priority,
                        requiresApproval,
                        inputs: { issue_id: issue.id, action: evalResult.action },
                    });
                    if (task?.id) {
                        evalResult.enqueuedTaskId = task.id;
                        summary.tasksCreated += 1;
                        await appendOrchestratorEvent(issue.id, "issue_orchestrator_task_created", {
                            ...evalResult.action,
                            task_id: task.id,
                        });
                    }
                } else {
                    // ask_will / wait_external / run_playbook / handoff at this mode:
                    // log the proposal and let humans / playbooks pick it up.
                    await appendOrchestratorEvent(issue.id, "issue_orchestrator_proposed", evalResult.action);
                    summary.proposed += 1;
                }
            } catch (err: any) {
                summary.errors += 1;
                console.warn(`[issue-orchestrator] eval failed for ${issue.id}: ${err.message}`);
                try {
                    await appendOrchestratorEvent(issue.id, "issue_orchestrator_error", { error: String(err.message ?? err) });
                } catch { /* swallow */ }
            }
        }
    } finally {
        _running = false;
    }

    return summary;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function describeAction(action: IssueNextAction): string {
    switch (action.kind) {
        case "none":           return "no action";
        case "ask_will":       return `ask Will: ${action.reason}`;
        case "wait_external":  return `waiting on external: ${action.reason}`;
        case "run_playbook":   return `run playbook ${action.playbookKind}`;
        case "create_task":    return action.goal;
        case "handoff":        return `handoff to ${action.handler}: ${action.reason}`;
    }
}

/**
 * Append an issue-scoped event tagged as orchestrator output. Best-effort —
 * logging failure must not interrupt the cycle.
 */
async function appendOrchestratorEvent(
    issueId: string,
    eventType: string,
    payload: unknown,
): Promise<void> {
    try {
        const { createClient } = await import("@/lib/supabase");
        const sb = createClient();
        if (!sb) return;
        await sb.from("task_history").insert({
            task_id: null,
            issue_id: issueId,
            agent_name: "issue-orchestrator",
            task_type: "issue_orchestrator",
            event_type: eventType,
            status: eventType.endsWith("_error") ? "failure" : "shadow",
            input_summary: typeof payload === "string" ? payload : "",
            output_summary: payload && typeof payload === "object" ? JSON.stringify(payload).slice(0, 500) : "",
            execution_trace: typeof payload === "object" && payload !== null ? payload : { value: payload },
        });
    } catch (err: any) {
        console.warn(`[issue-orchestrator] event log failed: ${err.message}`);
    }
}

/**
 * Update only the next_action field on an issue (suggest mode). Goes
 * directly to Supabase rather than through agent-issue helpers because
 * those force lifecycle-state transitions which we don't want here.
 */
async function updateNextActionOnly(issueId: string, nextAction: string): Promise<void> {
    try {
        const { createClient } = await import("@/lib/supabase");
        const sb = createClient();
        if (!sb) return;
        await sb.from("agent_issue").update({ next_action: nextAction, updated_at: new Date().toISOString() }).eq("id", issueId);
    } catch (err: any) {
        console.warn(`[issue-orchestrator] next_action patch failed: ${err.message}`);
    }
}
