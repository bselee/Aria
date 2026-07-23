/**
 * @file    issue-control.ts
 * @purpose Typed helpers for reading + writing issue control metadata.
 *          Phase 2 of the agentic-issue-orchestrator plan
 *          (docs/plans/2026-04-30-agentic-issue-orchestrator-control.md).
 *
 *          Control metadata lives in `agent_issue.inputs.control` for v1
 *          — no schema migration. Promote to its own column only after
 *          the shape proves stable over a few weeks of production use.
 *
 *          Modes:
 *            - observe_only      : read + summarize, no action proposed
 *            - suggest           : propose next_action, no work enqueued
 *            - act_with_approval : prepare work; Will must approve side effects
 *            - autonomous        : enqueue safe registered steps within budget
 *
 *          Default mode is selected by `defaultIssueControlMode()` based
 *          on blocker reason / owner / source. Caller can override at any
 *          time via `patchIssueControlProfile()`.
 */

import { createClient } from "@/lib/db";
import type { AgentIssue } from "./agent-issue";

const supabase = createClient();

export type IssueControlMode =
    | "observe_only"
    | "suggest"
    | "act_with_approval"
    | "autonomous";

export type IssueControlProfile = {
    mode: IssueControlMode;
    paused?: boolean;
    assignedBy?: string;
    updatedAt: string;
    reason?: string;
};

const VALID_MODES = new Set<IssueControlMode>([
    "observe_only",
    "suggest",
    "act_with_approval",
    "autonomous",
]);

/**
 * Compute the default control mode for an issue based on its lifecycle
 * + blocker + owner + source. Used by `getIssueControlProfile()` when the
 * issue has no stored control object yet, and by the orchestrator to
 * decide initial posture for new issues.
 *
 * Rules (in order — first match wins):
 *   1. Blocker is human_approval_required or policy_required → act_with_approval
 *   2. Owner is "will" → suggest
 *   3. Source is an AP-prefixed table → act_with_approval (write-path safety)
 *   4. Lifecycle is blocked (other reasons) → suggest
 *   5. Else → observe_only (safest unknown default)
 */
export function defaultIssueControlMode(
    issue: Pick<AgentIssue, "owner" | "source_table" | "blocker_reason" | "lifecycle_state">,
): IssueControlMode {
    if (issue.blocker_reason === "human_approval_required" || issue.blocker_reason === "policy_required") {
        return "act_with_approval";
    }
    if ((issue.owner ?? "").toLowerCase() === "will") return "suggest";
    if (issue.source_table?.startsWith("ap_")) return "act_with_approval";
    if (issue.lifecycle_state === "blocked") return "suggest";
    return "observe_only";
}

/**
 * Read the control profile from an issue. Falls back to the computed
 * default when the issue has no stored `inputs.control` object, or when
 * the stored mode is malformed.
 */
export function getIssueControlProfile(issue: AgentIssue): IssueControlProfile {
    const raw = (issue.inputs as Record<string, unknown> | null | undefined)?.control as
        | Partial<IssueControlProfile>
        | undefined;
    const mode = typeof raw?.mode === "string" && VALID_MODES.has(raw.mode as IssueControlMode)
        ? (raw.mode as IssueControlMode)
        : defaultIssueControlMode(issue);
    return {
        mode,
        paused: raw?.paused === true,
        assignedBy: typeof raw?.assignedBy === "string" ? raw.assignedBy : undefined,
        updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : issue.updated_at,
        reason: typeof raw?.reason === "string" ? raw.reason : undefined,
    };
}

/**
 * Patch the control profile on an issue. Preserves all other `inputs`
 * fields (vendor_name, invoice_number, etc.) — control nests under
 * `inputs.control` so co-existing data is untouched.
 *
 * Returns the updated issue row, or null if Supabase is unavailable or
 * the write failed. Best-effort — callers should not block their primary
 * flow on this response.
 */
export async function patchIssueControlProfile(
    issue: AgentIssue,
    patch: Partial<Omit<IssueControlProfile, "updatedAt">>,
): Promise<AgentIssue | null> {
    const db = createClient();
    if (!db) return null;

    const current = getIssueControlProfile(issue);
    const control: IssueControlProfile = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    const inputs = { ...((issue.inputs as Record<string, unknown> | null | undefined) ?? {}), control };

    const { data, error } = await supabase
        .from("agent_issue")
        .update({ inputs, updated_at: control.updatedAt })
        .eq("id", issue.id)
        .select()
        .single();
    if (error) {
        console.warn("[issue-control] patch failed:", error.message);
        return null;
    }
    return data as AgentIssue;
}
