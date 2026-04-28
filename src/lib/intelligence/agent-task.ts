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
    | "stuck_source"
    | "ci_failure"
    | "tripwire_violation";

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

export type PlaybookState =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "manual_only";

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
    dedup_count?: number;
    input_hash?: string | null;
    closes_when?: ClosurePredicate | null;
    auto_handled_by?: string | null;
    playbook_kind?: string | null;
    playbook_state?: PlaybookState | null;
};

export type ListTasksFilters = {
    status?: string[];
    type?: string[];
    owner?: string;
    limit?: number;
    includeRecentFailed?: boolean;
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
    /** Layer B: declare which autonomous playbook (if any) handles this task. */
    playbookKind?: string | null;
    /** Layer B: initial state of the playbook attempt — omit for null/manual triage. */
    playbookState?: PlaybookState | null;
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

function eventTypeForStatus(status: AgentTaskStatus): string | null {
    switch (status) {
        case "PENDING":
            return "created";
        case "CLAIMED":
            return "claimed";
        case "RUNNING":
            return "running";
        case "NEEDS_APPROVAL":
            return "needs_approval";
        case "APPROVED":
            return "approved";
        case "REJECTED":
            return "rejected";
        case "SUCCEEDED":
            return "succeeded";
        case "FAILED":
            return "failed";
        case "EXPIRED":
            return "expired";
        case "CANCELLED":
            return "cancelled";
        default:
            return null;
    }
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

    let previousStatus: AgentTaskStatus | null = null;
    try {
        const { data: existing } = await supabase
            .from("agent_task")
            .select("id, status")
            .eq("source_table", args.sourceTable)
            .eq("source_id", args.sourceId)
            .maybeSingle();
        previousStatus = (existing?.status as AgentTaskStatus | undefined) ?? null;
    } catch {
        previousStatus = null;
    }

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
        playbook_kind: args.playbookKind ?? null,
        playbook_state: args.playbookState ?? null,
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
    const taskId = data?.id ?? null;
    if (taskId) {
        const nextStatus = row.status as AgentTaskStatus;
        const eventType = previousStatus === null
            ? "created"
            : previousStatus !== nextStatus
            ? eventTypeForStatus(nextStatus)
            : null;
        if (eventType) {
            await appendEvent(taskId, eventType, {
                task_type: args.type,
                input_summary: args.goal,
                output_summary: `${args.sourceTable}:${args.sourceId}`,
                status: nextStatus,
            });
        }
    }
    return taskId;
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

        // Stuck-source guard: 6th+ duplicate AND original >1h old → meta-task.
        const ageMs = Date.now() - new Date(existing.created_at).getTime();
        if (newDedupCount > 5 && ageMs > 3600_000) {
            await emitStuckSourceMetaTask(supabase, args, existing.id, newDedupCount);
        }
        await appendEvent(existing.id, "dedup_increment", {
            task_type: args.type,
            input_summary: args.goal,
            output_summary: `dedup_count=${newDedupCount}`,
            dedup_count: newDedupCount,
        });
        return updated as AgentTask;
    }

    const closesWhen: ClosurePredicate | null = closesWhenFor({
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
            playbook_kind: args.playbookKind ?? null,
            playbook_state: args.playbookState ?? null,
        })
        .select()
        .single();
    if (insErr) throw insErr;
    if (created?.id) {
        await appendEvent(created.id, "created", {
            task_type: args.type,
            input_summary: args.goal,
            output_summary: `${args.sourceTable}:${args.sourceId}`,
            status: args.status ?? "PENDING",
        });
    }
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
        await appendEvent(existingMeta.id, "dedup_increment", {
            task_type: "stuck_source",
            output_summary: `dedup_count=${dedupCount}`,
            dedup_count: dedupCount,
        });
        return;
    }

    const { data: createdMeta, error: metaErr } = await supabase.from("agent_task").insert({
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
    }).select("id").single();
    if (metaErr) throw metaErr;
    if (createdMeta?.id) {
        await appendEvent(createdMeta.id, "created", {
            task_type: "stuck_source",
            input_summary: `Investigate stuck source ${originalArgs.sourceTable}/${originalArgs.sourceId}`,
            output_summary: `dedup_count=${dedupCount}`,
            dedup_count: dedupCount,
        });
    }
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
        task_type: "approval",
        output_summary: `${decision} by ${decidedBy}`,
        decided_by: decidedBy,
    });
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
        task_type: "resolution",
        output_summary: typeof outputs.summary === "string"
            ? outputs.summary
            : outputs.error
            ? String(outputs.error)
            : "completed",
        ...outputs,
    });
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
        task_type: "resolution",
        output_summary: errorMessage,
        error: errorMessage,
    });
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

export async function listTasks(filters: ListTasksFilters = {}): Promise<AgentTask[]> {
    const supabase = createClient();
    if (!supabase) {
        throw new Error("Supabase not configured");
    }

    let query = supabase
        .from("agent_task")
        .select("*")
        .order("priority", { ascending: true })
        .order("created_at", { ascending: false });

    if (filters.status?.length) {
        query = query.in("status", filters.status);
    } else {
        const open = ["PENDING", "CLAIMED", "RUNNING", "NEEDS_APPROVAL"];
        if (filters.includeRecentFailed !== false) {
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            query = query.or(
                `status.in.(${open.join(",")}),and(status.eq.FAILED,created_at.gte.${since})`,
            );
        } else {
            query = query.in("status", open);
        }
    }

    if (filters.type?.length) {
        query = query.in("type", filters.type);
    }

    if (filters.owner) {
        query = query.eq("owner", filters.owner);
    }

    query = query.limit(Math.min(filters.limit ?? 200, 500));

    const { data, error } = await query;
    if (error) {
        throw new Error(error.message);
    }
    return (data ?? []) as AgentTask[];
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

    if (patch.status) {
        const row = await getBySource(sourceTable, sourceId);
        if (row?.id) {
            const eventType = eventTypeForStatus(patch.status);
            if (eventType) {
                await appendEvent(row.id, eventType, {
                    task_type: row.type,
                    output_summary: typeof patch.outputs === "object" && patch.outputs && "remedy" in patch.outputs
                        ? String((patch.outputs as { remedy: unknown }).remedy)
                        : `${sourceTable}:${sourceId}`,
                    status: patch.status,
                });
            }
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

    const row = await getBySource(sourceTable, sourceId);
    if (row?.id) {
        await appendEvent(row.id, decision === "approve" ? "approved" : "rejected", {
            task_type: row.type,
            output_summary: `${decision} by ${decidedBy}`,
            decided_by: decidedBy,
        });
    }
}

/**
 * Layer B helper: set/update the playbook fields on an existing task.
 * The Layer C runner uses this to mark transitions:
 *   queued → running → succeeded | failed
 *
 * Manual triage uses it once with state="manual_only" to flag rows that
 * have no autonomous attempt path (e.g. reconciler approvals).
 *
 * Best-effort. Always appends a `playbook_state_changed` ledger event.
 */
export async function setPlaybook(
    taskId: string,
    kind: string,
    state: PlaybookState,
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_task")
        .update({
            playbook_kind: kind,
            playbook_state: state,
            updated_at: new Date().toISOString(),
        })
        .eq("id", taskId);

    if (error) {
        console.warn("[agent-task] setPlaybook failed:", error.message);
        return;
    }
    await appendEvent(taskId, "playbook_state_changed", {
        task_type: "playbook",
        output_summary: `${kind}=${state}`,
        playbook_kind: kind,
        playbook_state: state,
    });
}
