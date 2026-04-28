/**
 * @file    agent-issue.ts
 * @purpose Phase 1 of the agentic issue lifecycle. Issues group related
 *          agent_task rows under a parent ledger with explicit lifecycle /
 *          autonomy / blocker / next_action fields. Spoke writers continue
 *          to write tasks; the issue-projection cron derives + maintains
 *          issue rows for now. Phase 2 will rewire spoke writers to
 *          create+advance issues directly.
 *
 *          Mirrors the surface of agent-task.ts intentionally so callers
 *          have a familiar API.
 *
 *          See docs/plans/2026-04-28-agentic-issue-lifecycle-phase1.md.
 */

import { createClient } from "@/lib/supabase";

// ── Hub kill-switch (mirrors agent-task hubEnabled) ─────────────────────────
function hubEnabled(): boolean {
    const v = (process.env.HUB_TASKS_ENABLED ?? "true").toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

// ── Issue-scoped event ledger (separate from task events) ───────────────────
//
// task_history.task_id is FK'd to agent_task.id, so we can't reuse
// agent-task.appendEvent() for issue lifecycle — it'd silently FK-fail.
// Migration 20260509 adds task_history.issue_id and makes task_id nullable;
// this helper writes rows scoped to an issue.
async function appendIssueEvent(
    issueId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const statusBucket =
        eventType === "issue_complete" ? "success"
            : eventType === "issue_blocked" ? "failure"
                : "shadow";

    const { error } = await supabase.from("task_history").insert({
        task_id: null,
        issue_id: issueId,
        agent_name: typeof payload.agent_name === "string" ? payload.agent_name : "agent-issue",
        task_type: typeof payload.task_type === "string" ? payload.task_type : "issue_lifecycle",
        event_type: eventType,
        status: statusBucket,
        input_summary: typeof payload.input_summary === "string" ? payload.input_summary : "",
        output_summary: typeof payload.output_summary === "string" ? payload.output_summary : "",
        execution_trace: payload,
    });
    if (error) {
        console.warn("[agent-issue] appendIssueEvent failed:", error.message);
    }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type IssueLifecycleState =
    | "detected"
    | "triaging"
    | "working"
    | "waiting_external"
    | "blocked"
    | "complete";

export type IssueAutonomyState =
    | "working"
    | "waiting"
    | "retrying"
    | "resolved"
    | "needs_policy";

export type IssueBlockerReason =
    | "missing_receipt"
    | "po_not_found"
    | "vendor_mismatch"
    | "extraction_failed"
    | "policy_required"
    | "external_pending"
    | "duplicate_or_conflict"
    | "source_unavailable"
    | "auth_required"
    | "data_integrity_error"
    | "retry_exhausted"
    | "human_approval_required"
    | "unknown";

export type AgentIssue = {
    id: string;
    title: string;
    source_table: string | null;
    source_id: string | null;
    business_flow_key: string;
    lifecycle_state: IssueLifecycleState;
    autonomy_state: IssueAutonomyState | null;
    current_handler: string | null;
    blocker_reason: IssueBlockerReason | null;
    next_action: string | null;
    priority: number;
    owner: string;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
};

export type CreateOrAdvanceArgs = {
    /** Required. The grouping key — see issue-projection.ts businessFlowKey(). */
    businessFlowKey: string;
    /** Required on first create; optional on advance (existing title preserved). */
    title?: string;
    sourceTable?: string | null;
    sourceId?: string | null;
    lifecycleState?: IssueLifecycleState;
    autonomyState?: IssueAutonomyState | null;
    currentHandler?: string | null;
    nextAction?: string | null;
    priority?: number;
    owner?: string;
    inputs?: Record<string, unknown>;
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new issue or advance the existing open one for a business-flow key.
 *
 * Blocker preservation guardrail (Will, 2026-04-28): when the existing issue
 * is `lifecycle_state = blocked`, projection-style updates to lifecycle /
 * autonomy / handler / next_action are SILENTLY DROPPED. Only `clearBlocker`
 * can move an issue out of blocked. Safe metadata (priority, inputs) still
 * applies so the projection can keep digest counts fresh.
 */
export async function createOrAdvance(args: CreateOrAdvanceArgs): Promise<AgentIssue | null> {
    if (!hubEnabled()) return null;
    const supabase = createClient();
    if (!supabase) return null;

    // Look up existing OPEN issue for this business-flow key.
    const { data: existing } = await supabase
        .from("agent_issue")
        .select("*")
        .eq("business_flow_key", args.businessFlowKey)
        .in("lifecycle_state", ["detected", "triaging", "working", "waiting_external", "blocked"])
        .maybeSingle();

    if (existing) {
        const isBlocked = existing.lifecycle_state === "blocked";

        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (!isBlocked) {
            if (args.lifecycleState !== undefined) patch.lifecycle_state = args.lifecycleState;
            if (args.autonomyState !== undefined) patch.autonomy_state = args.autonomyState;
            if (args.currentHandler !== undefined) patch.current_handler = args.currentHandler;
            if (args.nextAction !== undefined) patch.next_action = args.nextAction;
        }
        if (args.priority !== undefined) patch.priority = args.priority;
        if (args.owner !== undefined) patch.owner = args.owner;
        if (args.inputs !== undefined) patch.inputs = args.inputs;

        const { data: updated, error } = await supabase
            .from("agent_issue")
            .update(patch)
            .eq("id", existing.id)
            .select()
            .single();
        if (error) {
            console.warn("[agent-issue] advance failed:", error.message);
            return null;
        }
        if (!isBlocked && args.lifecycleState && args.lifecycleState !== existing.lifecycle_state) {
            await appendIssueEvent(existing.id, `issue_${args.lifecycleState}`, {
                task_type: "issue_lifecycle",
                output_summary: `${existing.lifecycle_state} → ${args.lifecycleState}`,
                from: existing.lifecycle_state,
                to: args.lifecycleState,
            });
        }
        return updated as AgentIssue;
    }

    // No existing — create new. Title required.
    if (!args.title) {
        console.warn("[agent-issue] createOrAdvance: title required when no existing row");
        return null;
    }
    const { data: created, error: insErr } = await supabase
        .from("agent_issue")
        .insert({
            title: args.title,
            source_table: args.sourceTable ?? null,
            source_id: args.sourceId ?? null,
            business_flow_key: args.businessFlowKey,
            lifecycle_state: args.lifecycleState ?? "detected",
            autonomy_state: args.autonomyState ?? "working",
            current_handler: args.currentHandler ?? null,
            next_action: args.nextAction ?? null,
            priority: args.priority ?? 2,
            owner: args.owner ?? "aria",
            inputs: args.inputs ?? {},
        })
        .select()
        .single();
    if (insErr) {
        console.warn("[agent-issue] create failed:", insErr.message);
        return null;
    }
    if (created?.id) {
        await appendIssueEvent(created.id, "issue_detected", {
            task_type: "issue_lifecycle",
            input_summary: args.title,
            output_summary: args.businessFlowKey,
            business_flow_key: args.businessFlowKey,
        });
    }
    return created as AgentIssue;
}
