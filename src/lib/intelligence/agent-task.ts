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
import { inputHash } from "./agent-task-hash";
import { closesWhenFor, type ClosurePredicate } from "./agent-task-closure";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentTaskType =
    | "cron_failure"
    | "approval"
    | "dropship_forward"
    | "po_send_confirm"
    | "agent_exception"
    | "control_command"
    | "manual"
    | "code_change"
    | "stuck_source";

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

/**
 * Master kill-switch for all hub writes. Default ON. Set
 * HUB_TASKS_ENABLED=false (or 0/off) to short-circuit every public function in
 * this module — useful as a one-line rollback if phase 2 misbehaves in prod.
 *
 * Reads are NOT gated; the dashboard /tasks page keeps working with whatever
 * rows already exist.
 */
function hubEnabled(): boolean {
    const v = (process.env.HUB_TASKS_ENABLED ?? "true").toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
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
    if (!hubEnabled()) return null;
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

// ── incrementOrCreate (phase 2.5 hygiene) ────────────────────────────────────

export type IncrementOrCreateArgs = UpsertFromSourceArgs;

/**
 * Dedup-aware sibling of `upsertFromSource`. Phase-2 spoke writers should call
 * this. If an OPEN row with the same `(source_table, source_id, input_hash)`
 * already exists, increment its `dedup_count` instead of inserting. Otherwise
 * insert a fresh row with `closes_when` populated from `closesWhenFor()`.
 *
 * If the bumped row reaches `dedup_count > 5` AND is older than 1h, also emits
 * a `stuck_source` meta-task so Will sees one investigation prompt instead of
 * N duplicates.
 *
 * Throws if Supabase is unavailable (caller must guard with try/catch where
 * appropriate). The throw is intentional: spoke writers that previously called
 * `upsertFromSource` (which returned null on failure) wrap their hub writes in
 * try/catch already, so this is API-compatible.
 */
export async function incrementOrCreate(args: IncrementOrCreateArgs): Promise<AgentTask> {
    if (!hubEnabled()) {
        throw new Error("incrementOrCreate: HUB_TASKS_ENABLED is off");
    }
    const supabase = createClient();
    if (!supabase) throw new Error("incrementOrCreate: supabase client unavailable");

    const inputs = args.inputs ?? {};
    const hash = inputHash(inputs);

    const { data: existing } = await supabase
        .from("agent_task")
        .select("id, dedup_count, created_at")
        .eq("source_table", args.sourceTable)
        .eq("source_id", args.sourceId)
        .eq("input_hash", hash)
        .in("status", ["PENDING", "NEEDS_APPROVAL", "RUNNING", "CLAIMED"])
        .maybeSingle();

    if (existing) {
        const newDedupCount = (existing.dedup_count ?? 1) + 1;
        const { data: updated, error: updErr } = await supabase
            .from("agent_task")
            .update({
                dedup_count: newDedupCount,
                updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id)
            .select()
            .single();
        if (updErr) throw updErr;

        // Ledger: dedup increment is its own event_type so the pattern miner
        // can distinguish "same thing fired again" from "new thing happened".
        await appendEvent(existing.id, "dedup_increment", {
            agent_name: "agent-task",
            task_type: args.type,
            output_summary: `dedup_count: ${newDedupCount}`,
        }).catch(() => { /* best-effort ledger */ });

        // Stuck-source guard: 6th+ duplicate AND original >1h old → meta-task.
        const ageMs = Date.now() - new Date(existing.created_at).getTime();
        if (newDedupCount > 5 && ageMs > 3600_000) {
            await emitStuckSourceMetaTask(supabase, args, existing.id, newDedupCount);
        }
        return updated as AgentTask;
    }

    const closesWhen: ClosurePredicate = closesWhenFor({
        type: args.type,
        sourceTable: args.sourceTable,
        inputs,
    });

    const { data: created, error: insErr } = await supabase
        .from("agent_task")
        .insert({
            type: args.type,
            source_table: args.sourceTable,
            source_id: args.sourceId,
            goal: args.goal,
            status: args.status ?? "PENDING",
            owner: args.owner ?? "aria",
            priority: args.priority ?? 2,
            requires_approval: args.requiresApproval ?? false,
            inputs,
            input_hash: hash,
            closes_when: closesWhen,
            parent_task_id: args.parentTaskId ?? null,
            deadline_at: isoOrNull(args.deadlineAt ?? null),
            max_retries: args.maxRetries ?? 0,
            dedup_count: 1,
        })
        .select()
        .single();
    if (insErr) throw insErr;

    // Ledger: every new hub row gets a 'created' event_type entry.
    await appendEvent((created as AgentTask).id, "created", {
        agent_name: "agent-task",
        task_type: args.type,
        input_summary: args.goal.slice(0, 200),
    }).catch(() => { /* best-effort ledger */ });

    return created as AgentTask;
}

async function emitStuckSourceMetaTask(
    supabase: NonNullable<ReturnType<typeof createClient>>,
    originalArgs: IncrementOrCreateArgs,
    originalTaskId: string,
    dedupCount: number,
): Promise<void> {
    const metaInputs = {
        stuck_source_table: originalArgs.sourceTable,
        stuck_source_id: originalArgs.sourceId,
        observed_dedup_count: dedupCount,
    };
    const metaHash = inputHash({
        stuck_source_table: metaInputs.stuck_source_table,
        stuck_source_id: metaInputs.stuck_source_id,
    });

    const { data: existingMeta } = await supabase
        .from("agent_task")
        .select("id, dedup_count")
        .eq("type", "stuck_source")
        .eq("input_hash", metaHash)
        .in("status", ["PENDING", "NEEDS_APPROVAL", "RUNNING", "CLAIMED"])
        .maybeSingle();

    if (existingMeta) {
        await supabase
            .from("agent_task")
            .update({
                dedup_count: dedupCount,
                inputs: metaInputs,
                updated_at: new Date().toISOString(),
            })
            .eq("id", existingMeta.id);
        return;
    }

    await supabase.from("agent_task").insert({
        type: "stuck_source",
        source_table: null,
        source_id: null,
        parent_task_id: originalTaskId,
        goal: `Investigate: ${originalArgs.sourceTable}/${originalArgs.sourceId} keeps firing without closure (${dedupCount}× and counting)`,
        status: "PENDING",
        owner: "will",
        priority: 0,
        requires_approval: false,
        inputs: metaInputs,
        input_hash: metaHash,
        closes_when: { kind: "deadline", max_age_hours: 168 },
        dedup_count: 1,
    });
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
    if (!hubEnabled()) return;
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
        return;
    }

    await appendEvent(taskId, decision === "approve" ? "approved" : "rejected", {
        agent_name: decidedBy,
        task_type: "approval",
    }).catch(() => { /* best-effort ledger */ });
}

/** Mark a task SUCCEEDED with optional outputs. */
export async function complete(
    taskId: string,
    outputs: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
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
        return;
    }

    await appendEvent(taskId, "succeeded", {
        agent_name: typeof outputs.completed_by === "string" ? (outputs.completed_by as string) : "agent-task",
        output_summary: typeof outputs.summary === "string" ? (outputs.summary as string) : "",
    }).catch(() => { /* best-effort ledger */ });
}

/** Mark a task FAILED with an error message in outputs.error. */
export async function fail(taskId: string, errorMessage: string): Promise<void> {
    if (!hubEnabled()) return;
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
        return;
    }

    await appendEvent(taskId, "failed", {
        agent_name: "agent-task",
        output_summary: errorMessage.slice(0, 200),
    }).catch(() => { /* best-effort ledger */ });
}

/**
 * Append a structured event to the task ledger (`task_history`). Phase 3 of
 * the control plane: every state transition writes one row. The pattern miner
 * (phase A1) and the dashboard timeline view read from here.
 *
 * `event_type` should be one of: created | claimed | running | needs_approval |
 * approved | rejected | succeeded | failed | cancelled | expired |
 * dedup_increment | skill_invoked | skill_succeeded | skill_failed.
 *
 * Best-effort: a ledger write failure must never block the spoke flow.
 */
export async function appendEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    // Status maps to the task_history.status CHECK constraint
    // ('success'|'failure'|'shadow'). Map ledger event_type → bucket.
    const statusBucket =
        eventType === "succeeded" || eventType === "approved"
            ? "success"
            : eventType === "failed" || eventType === "rejected" || eventType === "cancelled" || eventType === "expired"
            ? "failure"
            : "shadow";

    const inputSummary =
        typeof payload.input_summary === "string"
            ? (payload.input_summary as string)
            : "";
    const outputSummary =
        typeof payload.output_summary === "string"
            ? (payload.output_summary as string)
            : "";

    const { error } = await supabase.from("task_history").insert({
        task_id: taskId,
        agent_name: typeof payload.agent_name === "string" ? payload.agent_name : "agent-task",
        task_type: typeof payload.task_type === "string" ? payload.task_type : "resolution",
        event_type: eventType,
        status: statusBucket,
        input_summary: inputSummary,
        output_summary: outputSummary,
        execution_trace: payload,
    });

    if (error) {
        console.warn("[agent-task] appendEvent failed:", error.message);
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

/**
 * Patch the hub row for a given spoke source. Used by SupervisorAgent and other
 * spoke writers that already have (sourceTable, sourceId) and want to update
 * the hub without doing a separate getBySource → update.
 *
 * No-op if no hub row exists for the source (i.e. the spoke row was created
 * before HUB_TASKS_ENABLED was on).
 */
export async function updateBySource(
    sourceTable: string,
    sourceId: string,
    patch: Partial<Pick<AgentTask, "status" | "owner" | "priority" | "outputs" | "approval_decision">>,
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_task")
        .update(patch)
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId);

    if (error) {
        console.warn("[agent-task] updateBySource failed:", error.message);
        return;
    }

    // Only emit a ledger row when the patch carried a status (state transition).
    // Pure metadata updates (owner / priority / outputs) don't deserve a ledger.
    if (patch.status) {
        const { data: row } = await supabase
            .from("agent_task")
            .select("id")
            .eq("source_table", sourceTable)
            .eq("source_id", sourceId)
            .maybeSingle();
        if (row?.id) {
            const eventType = patch.status.toLowerCase();
            await appendEvent(row.id, eventType, {
                agent_name: "agent-task",
                task_type: "transition",
                output_summary: typeof patch.outputs === "object" && patch.outputs && "remedy" in patch.outputs
                    ? String((patch.outputs as { remedy: unknown }).remedy)
                    : "",
            }).catch(() => { /* best-effort ledger */ });
        }
    }
}

/**
 * Convenience wrapper: record an approve/reject decision against the hub row
 * identified by spoke (sourceTable, sourceId). Used by reconciler approve and
 * reject paths so they don't have to look up the task_id first.
 *
 * No-op if no hub row exists for the source.
 */
export async function decideApprovalBySource(
    sourceTable: string,
    sourceId: string,
    decision: "approve" | "reject",
    decidedBy: string,
): Promise<void> {
    if (!hubEnabled()) return;
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
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId);

    if (error) {
        console.warn("[agent-task] decideApprovalBySource failed:", error.message);
        return;
    }

    // Lookup the task id so the ledger row carries it. Best-effort.
    const { data: row } = await supabase
        .from("agent_task")
        .select("id")
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId)
        .maybeSingle();
    if (row?.id) {
        await appendEvent(row.id, decision === "approve" ? "approved" : "rejected", {
            agent_name: decidedBy,
            task_type: "approval",
        }).catch(() => { /* best-effort ledger */ });
    }
}
