/**
 * @file    issue-control-actions.ts
 * @purpose Shared service that maps a typed action input to the right
 *          underlying call: agent-issue helpers (setBlocker, clearBlocker,
 *          recordHandoff, complete), issue-control profile patches, or
 *          orchestrator invocation. Telegram + dashboard route through
 *          this so behavior never diverges.
 *
 *          Plan task 5 (docs/plans/2026-04-30-agentic-issue-orchestrator-control.md).
 */

import * as agentIssue from "./agent-issue";
import { patchIssueControlProfile } from "./issue-control";
import type { IssueControlMode } from "./issue-control";
import type { AgentIssue, IssueBlockerReason, IssueLifecycleState } from "./agent-issue";

export type IssueControlActionInput =
    | { action: "set_control_mode"; mode: IssueControlMode; actor: string; reason?: string }
    | { action: "assign_handler"; handler: string; actor: string; reason: string }
    | { action: "pause"; actor: string; reason?: string }
    | { action: "resume"; actor: string; reason?: string }
    | { action: "set_blocker"; reason: IssueBlockerReason; nextAction: string; actor: string }
    | { action: "clear_blocker"; actor: string; resumeState?: IssueLifecycleState }
    | { action: "run_next_step"; actor: string }
    | { action: "complete"; actor: string; resolution: string };

export type IssueControlActionResult = {
    ok: boolean;
    message: string;
    issue?: AgentIssue | null;
    detail?: unknown;
};

/**
 * Apply a typed control action to an issue. Best-effort across the board:
 * a missing issue or a downstream helper failure returns
 * `{ok: false, message}` rather than throwing.
 */
export async function applyIssueControlAction(
    issueId: string,
    input: IssueControlActionInput,
): Promise<IssueControlActionResult> {
    const issue = await agentIssue.getById(issueId);
    if (!issue) {
        return { ok: false, message: "Issue not found." };
    }

    try {
        switch (input.action) {
            case "set_control_mode": {
                const updated = await patchIssueControlProfile(issue, {
                    mode: input.mode,
                    assignedBy: input.actor,
                    reason: input.reason,
                });
                return {
                    ok: true,
                    message: `Control mode set to ${input.mode}.`,
                    issue: updated,
                };
            }

            case "assign_handler": {
                await agentIssue.recordHandoff(
                    issueId,
                    issue.current_handler ?? null,
                    input.handler,
                    input.reason,
                );
                return { ok: true, message: `Handler assigned: ${input.handler}.` };
            }

            case "pause": {
                const updated = await patchIssueControlProfile(issue, {
                    paused: true,
                    assignedBy: input.actor,
                    reason: input.reason,
                });
                return { ok: true, message: "Issue paused.", issue: updated };
            }

            case "resume": {
                const updated = await patchIssueControlProfile(issue, {
                    paused: false,
                    assignedBy: input.actor,
                    reason: input.reason,
                });
                return { ok: true, message: "Issue resumed.", issue: updated };
            }

            case "set_blocker": {
                await agentIssue.setBlocker(issueId, input.reason, input.nextAction);
                return { ok: true, message: `Blocker set: ${input.reason}.` };
            }

            case "clear_blocker": {
                await agentIssue.clearBlocker(issueId, input.resumeState ?? "working");
                return { ok: true, message: "Blocker cleared." };
            }

            case "run_next_step": {
                // On-demand orchestrator invocation. Doesn't override the
                // cron — same logic, just runs now. Currently runs the full
                // cycle (cap 10) since per-issue evaluation isn't a public
                // helper; future refinement can scope to a single issue.
                const { runIssueOrchestratorOnce } = await import("./issue-orchestrator");
                const summary = await runIssueOrchestratorOnce({ limit: 10 });
                return {
                    ok: true,
                    message: `Orchestrator ran: ${summary.evaluated} evaluated, ${summary.tasksCreated} task(s) created, ${summary.proposed} proposed.`,
                    detail: summary,
                };
            }

            case "complete": {
                await agentIssue.complete(issueId, {
                    resolution: input.resolution,
                    resolved_by: input.actor,
                    via: "issue_control_action",
                });
                return { ok: true, message: `Issue completed: ${input.resolution}.` };
            }

            default: {
                const exhaustiveCheck: never = input;
                return { ok: false, message: `Unsupported action shape: ${JSON.stringify(exhaustiveCheck)}` };
            }
        }
    } catch (err: any) {
        console.warn(`[issue-control-actions] ${input.action} failed for ${issueId}: ${err.message}`);
        return { ok: false, message: `${input.action} failed: ${err.message}` };
    }
}
