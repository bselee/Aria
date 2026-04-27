/**
 * @file    agent-task.ts
 * @purpose Aria control-plane hub: thin TypeScript surface over the `agent_task`
 *          table. Spoke writers (reconciler, dropship-store, copilot, safeRun
 *          failure path, oversight escalate) call upsertFromSource() to create
 *          or update the matching hub row. The dashboard /tasks page reads
 *          from this table.
 *
 *          Phase 1: hub schema + this module + dashboard read. No spoke
 *          writers are wired yet — they land in phase 2.
 *
 *          See .agents/plans/control-plane.md for the full plan.
 */

import { createClient } from "@/lib/supabase";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentTaskType =
    | "cron_failure"
    | "approval"
    | "dropship_forward"
    | "po_send_confirm"
    | "agent_exception"
    | "control_command"
    | "manual"
    | "code_change";

export type AgentTaskStatus =
    | "PENDING"
    | "CLAIMED"
    | "RUNNING"
    | "NEEDS_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | "SUCCEEDED"
    | "FAILED"
    | "EXPIRED"
    | "CANCELLED";

export type AgentTaskOwner = "aria" | "will" | string;

export type AgentTask = {
    id: string;
    type: AgentTaskType;
    source_table: string | null;
    source_id: string | null;
    goal: string;
    status: AgentTaskStatus;
    owner: AgentTaskOwner;
    priority: number;
    parent_task_id: string | null;
    requires_approval: boolean;
    approval_decision: "approve" | "reject" | null;
    approval_decided_by: string | null;
    approval_decided_at: string | null;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    cost_cents: number;
    retry_count: number;
    max_retries: number;
    deadline_at: string | null;
    created_at: string;
    updated_at: string;
    claimed_at: string | null;
    claimed_by: string | null;
    completed_at: string | null;
};

export type UpsertFromSourceArgs = {
    sourceTable: string;
    sourceId: string;
    type: AgentTaskType;
    goal: string;
    status?: AgentTaskStatus;
    owner?: AgentTaskOwner;
    priority?: number;
    requiresApproval?: boolean;
    inputs?: Record<string, unknown>;
    parentTaskId?: string | null;
    deadlineAt?: string | Date | null;
    maxRetries?: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoOrNull(d: string | Date | null | undefined): string | null {
    if (!d) return null;
    if (typeof d === "string") return d;
    return d.toISOString();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create or update the hub row for a given spoke source.
 *
 * Idempotent: the (source_table, source_id) partial unique index ensures the
 * same spoke row only ever has one hub row. Re-calling with the same source
 * updates `goal`, `status`, `priority`, `inputs`, etc. without duplicating.
 *
 * Returns the hub row id, or null if Supabase is unavailable (does not throw).
 */
export async function upsertFromSource(args: UpsertFromSourceArgs): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const row = {
        type: args.type,
        source_table: args.sourceTable,
        source_id: args.sourceId,
        goal: args.goal,
        status: args.status ?? "PENDING",
        owner: args.owner ?? "aria",
        priority: args.priority ?? 2,
        requires_approval: args.requiresApproval ?? false,
        inputs: args.inputs ?? {},
        parent_task_id: args.parentTaskId ?? null,
        deadline_at: isoOrNull(args.deadlineAt ?? null),
        max_retries: args.maxRetries ?? 0,
    };

    const { data, error } = await supabase
        .from("agent_task")
        .upsert(row, { onConflict: "source_table,source_id" })
        .select("id")
        .single();

    if (error) {
        console.warn("[agent-task] upsertFromSource failed:", error.message);
        return null;
    }
    return data?.id ?? null;
}

/**
 * Record a human's approval decision on a hub row. Phase 2 will call this
 * from the Telegram approve/reject callback handlers; phase 1 dashboard is
 * read-only.
 */
export async function decideApproval(
    taskId: string,
    decision: "approve" | "reject",
    decidedBy: string,
): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const status: AgentTaskStatus = decision === "approve" ? "APPROVED" : "REJECTED";

    const { error } = await supabase
        .from("agent_task")
        .update({
            approval_decision: decision,
            approval_decided_by: decidedBy,
            approval_decided_at: new Date().toISOString(),
            status,
        })
        .eq("id", taskId);

    if (error) {
        console.warn("[agent-task] decideApproval failed:", error.message);
    }
}

/** Mark a task SUCCEEDED with optional outputs. */
export async function complete(
    taskId: string,
    outputs: Record<string, unknown> = {},
): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_task")
        .update({
            status: "SUCCEEDED",
            outputs,
            completed_at: new Date().toISOString(),
        })
        .eq("id", taskId);

    if (error) {
        console.warn("[agent-task] complete failed:", error.message);
    }
}

/** Mark a task FAILED with an error message in outputs.error. */
export async function fail(taskId: string, errorMessage: string): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_task")
        .update({
            status: "FAILED",
            outputs: { error: errorMessage },
            completed_at: new Date().toISOString(),
        })
        .eq("id", taskId);

    if (error) {
        console.warn("[agent-task] fail failed:", error.message);
    }
}

/**
 * Append a structured event to the task's `inputs.events` array. This is a
 * placeholder for phase 3, which will move events into a repurposed
 * task_history table. For now, the in-row events array gives us a quick way
 * to display a timeline in the dashboard without another schema change.
 */
export async function appendEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const { data: existing, error: readErr } = await supabase
        .from("agent_task")
        .select("inputs")
        .eq("id", taskId)
        .single();

    if (readErr || !existing) {
        console.warn("[agent-task] appendEvent read failed:", readErr?.message);
        return;
    }

    const events: Array<Record<string, unknown>> = Array.isArray(
        (existing.inputs as Record<string, unknown>)?.events,
    )
        ? ((existing.inputs as Record<string, unknown>).events as Array<Record<string, unknown>>)
        : [];

    events.push({
        event_type: eventType,
        at: new Date().toISOString(),
        ...payload,
    });

    const { error: updErr } = await supabase
        .from("agent_task")
        .update({ inputs: { ...(existing.inputs as object), events } })
        .eq("id", taskId);

    if (updErr) {
        console.warn("[agent-task] appendEvent write failed:", updErr.message);
    }
}

/** Read a single hub row by id. */
export async function getById(taskId: string): Promise<AgentTask | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const { data, error } = await supabase
        .from("agent_task")
        .select("*")
        .eq("id", taskId)
        .single();

    if (error) {
        console.warn("[agent-task] getById failed:", error.message);
        return null;
    }
    return data as AgentTask | null;
}

/** Look up the hub row for a given spoke source, if one exists. */
export async function getBySource(
    sourceTable: string,
    sourceId: string,
): Promise<AgentTask | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const { data, error } = await supabase
        .from("agent_task")
        .select("*")
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId)
        .maybeSingle();

    if (error) {
        console.warn("[agent-task] getBySource failed:", error.message);
        return null;
    }
    return (data as AgentTask | null) ?? null;
}
