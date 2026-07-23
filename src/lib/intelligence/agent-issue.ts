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

import { createClient } from "@/lib/db";

const supabase = createClient();

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
    const db = createClient();
    if (!db) return;

    const statusBucket =
        eventType === "issue_complete" ? "success"
            : eventType === "issue_blocked" ? "failure"
                : "shadow";

    const { error } = await db.from("task_history").insert({
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

/** Open lifecycle states covered by uq_agent_issue_business_flow_open. */
const OPEN_LIFECYCLES = [
    "detected",
    "triaging",
    "working",
    "waiting_external",
    "blocked",
] as const;

function isUniqueConflict(err: { message?: string; code?: string } | null | undefined): boolean {
    const msg = (err?.message || "").toLowerCase();
    const code = String(err?.code || "");
    return (
        code === "23505" ||
        msg.includes("23505") ||
        msg.includes("already exists") ||
        msg.includes("duplicate key") ||
        msg.includes("conflict")
    );
}

/**
 * Find the newest open issue for a business-flow key.
 * Uses limit(1)+order instead of bare maybeSingle so multi-row races
 * never blow up with PGRST116 (which previously fell through to insert → 409).
 */
async function findOpenIssue(
    supabase: NonNullable<ReturnType<typeof createClient>>,
    businessFlowKey: string,
): Promise<AgentIssue | null> {
    const { data, error } = await supabase
        .from("agent_issue")
        .select("*")
        .eq("business_flow_key", businessFlowKey)
        .in("lifecycle_state", [...OPEN_LIFECYCLES])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        // Soft: treat lookup failure as "none" so caller can still try create
        // (create will race-recover on 23505).
        console.warn("[agent-issue] open lookup failed:", error.message);
        return null;
    }
    return (data as AgentIssue | null) ?? null;
}

/**
 * Apply an advance patch to an existing open issue (blocker-safe).
 */
async function advanceExisting(
    supabase: NonNullable<ReturnType<typeof createClient>>,
    existing: AgentIssue,
    args: CreateOrAdvanceArgs,
): Promise<AgentIssue | null> {
    const isBlocked = existing.lifecycle_state === "blocked";

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (!isBlocked) {
        if (args.lifecycleState !== undefined) patch.lifecycle_state = args.lifecycleState;
        if (args.autonomyState !== undefined) patch.autonomy_state = args.autonomyState;
        if (args.currentHandler !== undefined) patch.current_handler = args.currentHandler;
        if (args.nextAction !== undefined) patch.next_action = args.nextAction;
        // Stamp completed_at when projection moves us into complete and
        // the existing row hasn't already been stamped — otherwise
        // listIssues' "complete in last 14d" filter excludes them.
        if (args.lifecycleState === "complete" && !existing.completed_at) {
            patch.completed_at = new Date().toISOString();
        }
        // Owner is intentionally also gated on !isBlocked (Will, 2026-04-29):
        // a blocked issue assigned to Will (e.g. via human_approval_required)
        // must NOT have its owner flipped back to aria by the next projection
        // cycle. That would weaken the "only clearBlocker() exits the human
        // decision path" invariant.
        if (args.owner !== undefined) patch.owner = args.owner;
    }
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.inputs !== undefined) patch.inputs = args.inputs;

    const { data: updated, error } = await supabase
        .from("agent_issue")
        .update(patch)
        .eq("id", existing.id)
        .select()
        .single();
    if (error) {
        // Unique conflicts on advance are almost always concurrent writers —
        // re-read and return the current row rather than spamming logs.
        if (isUniqueConflict(error)) {
            const again = await findOpenIssue(supabase, args.businessFlowKey);
            if (again) return again;
        }
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

/**
 * Create a new issue or advance the existing open one for a business-flow key.
 *
 * Blocker preservation guardrail (Will, 2026-04-28): when the existing issue
 * is `lifecycle_state = blocked`, projection-style updates to lifecycle /
 * autonomy / handler / next_action are SILENTLY DROPPED. Only `clearBlocker`
 * can move an issue out of blocked. Safe metadata (priority, inputs) still
 * applies so the projection can keep digest counts fresh.
 *
 * HERMIA(2026-07-13): race-safe against concurrent issue-projection ticks.
 * Open lookup uses limit(1). Insert 23505 falls back to advance of the winner.
 */
export async function createOrAdvance(args: CreateOrAdvanceArgs): Promise<AgentIssue | null> {
    if (!hubEnabled()) return null;
    const db = createClient();
    if (!db) return null;

    const existing = await findOpenIssue(db, args.businessFlowKey);
    if (existing) {
        return advanceExisting(db, existing, args);
    }

    // No existing — create new. Title required.
    if (!args.title) {
        console.warn("[agent-issue] createOrAdvance: title required when no existing row");
        return null;
    }
    const initialLifecycle = args.lifecycleState ?? "detected";
    const { data: created, error: insErr } = await db
        .from("agent_issue")
        .insert({
            title: args.title,
            source_table: args.sourceTable ?? null,
            source_id: args.sourceId ?? null,
            business_flow_key: args.businessFlowKey,
            lifecycle_state: initialLifecycle,
            autonomy_state: args.autonomyState ?? "working",
            current_handler: args.currentHandler ?? null,
            next_action: args.nextAction ?? null,
            priority: args.priority ?? 2,
            owner: args.owner ?? "aria",
            inputs: args.inputs ?? {},
            // Stamp completed_at when first-creating in complete state so
            // listIssues' time-window filter sees the row.
            completed_at: initialLifecycle === "complete" ? new Date().toISOString() : null,
        })
        .select()
        .single();
    if (insErr) {
        // Concurrent projection: another worker won the insert. Advance that row.
        if (isUniqueConflict(insErr)) {
            const raced = await findOpenIssue(db, args.businessFlowKey);
            if (raced) {
                return advanceExisting(db, raced, args);
            }
            // Insert may have completed into a terminal state under race — fetch any row
            const { data: anyRow } = await db
                .from("agent_issue")
                .select("*")
                .eq("business_flow_key", args.businessFlowKey)
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle();
            if (anyRow) return anyRow as AgentIssue;
        }
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

export async function recordHandoff(
    issueId: string,
    fromHandler: string | null,
    toHandler: string,
    reason: string,
): Promise<void> {
    if (!hubEnabled()) return;
    const db = createClient();
    if (!db) return;

    const { error } = await db
        .from("agent_issue")
        .update({ current_handler: toHandler, updated_at: new Date().toISOString() })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] recordHandoff failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_handoff", {
        task_type: "issue_lifecycle",
        output_summary: `${fromHandler ?? "?"} → ${toHandler}: ${reason}`,
        from_handler: fromHandler,
        to_handler: toHandler,
        reason,
    });
}

export async function setBlocker(
    issueId: string,
    reason: IssueBlockerReason,
    nextAction: string,
): Promise<void> {
    if (!hubEnabled()) return;
    const db = createClient();
    if (!db) return;

    const autonomy: IssueAutonomyState =
        reason === "human_approval_required" || reason === "policy_required"
            ? "needs_policy"
            : "waiting";

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: "blocked",
            blocker_reason: reason,
            next_action: nextAction,
            autonomy_state: autonomy,
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] setBlocker failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_blocked", {
        task_type: "issue_lifecycle",
        output_summary: `${reason}: ${nextAction}`,
        blocker_reason: reason,
        next_action: nextAction,
    });
}

export async function clearBlocker(
    issueId: string,
    resumeState: IssueLifecycleState = "working",
): Promise<void> {
    if (!hubEnabled()) return;
    const db = createClient();
    if (!db) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: resumeState,
            blocker_reason: null,
            autonomy_state: "working",
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] clearBlocker failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_blocker_cleared", {
        task_type: "issue_lifecycle",
        output_summary: `resumed to ${resumeState}`,
    });
}

export async function complete(
    issueId: string,
    outputs: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
    const db = createClient();
    if (!db) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: "complete",
            autonomy_state: "resolved",
            completed_at: new Date().toISOString(),
            outputs,
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] complete failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_complete", {
        task_type: "issue_lifecycle",
        output_summary: typeof outputs.resolution === "string"
            ? outputs.resolution
            : "completed",
        ...outputs,
    });
}

export async function linkTask(taskId: string, issueId: string): Promise<void> {
    if (!hubEnabled()) return;
    const db = createClient();
    if (!db) return;
    const { error } = await supabase
        .from("agent_task")
        .update({ issue_id: issueId })
        .eq("id", taskId);
    if (error) {
        console.warn("[agent-issue] linkTask failed:", error.message);
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type ListIssuesFilters = {
    lifecycleState?: IssueLifecycleState[];
    owner?: string;
    /** Window for terminal lifecycle states. Defaults 14 days. */
    terminalWindowMs?: number;
    limit?: number;
};

const DEFAULT_TERMINAL_WINDOW_MS = 14 * 24 * 3600 * 1000;
const OPEN_LIFECYCLE: IssueLifecycleState[] = [
    "detected", "triaging", "working", "waiting_external", "blocked",
];

export async function listIssues(filters: ListIssuesFilters = {}): Promise<AgentIssue[]> {
    const db = createClient();
    if (!db) return [];

    const limit = Math.min(filters.limit ?? 200, 500);
    const since = new Date(Date.now() - (filters.terminalWindowMs ?? DEFAULT_TERMINAL_WINDOW_MS)).toISOString();

    let query = supabase
        .from("agent_issue")
        .select("*")
        .order("priority", { ascending: true })
        .order("updated_at", { ascending: false });

    if (filters.lifecycleState?.length) {
        query = query.in("lifecycle_state", filters.lifecycleState);
    } else {
        // Default: open at any age + complete in window. Per Will's spec.
        query = query.or(
            `lifecycle_state.in.(${OPEN_LIFECYCLE.join(",")}),and(lifecycle_state.eq.complete,completed_at.gte.${since})`,
        );
    }
    if (filters.owner) query = query.eq("owner", filters.owner);
    query = query.limit(limit);

    const { data, error } = await query;
    if (error) {
        console.warn("[agent-issue] listIssues failed:", error.message);
        return [];
    }
    return (data ?? []) as AgentIssue[];
}

export async function getById(id: string): Promise<AgentIssue | null> {
    const db = createClient();
    if (!db) return null;
    const { data, error } = await db.from("agent_issue").select("*").eq("id", id).maybeSingle();
    if (error) {
        console.warn("[agent-issue] getById failed:", error.message);
        return null;
    }
    return (data ?? null) as AgentIssue | null;
}

export async function getBySource(sourceTable: string, sourceId: string): Promise<AgentIssue | null> {
    const db = createClient();
    if (!db) return null;
    const { data, error } = await supabase
        .from("agent_issue")
        .select("*")
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId)
        .maybeSingle();
    if (error) {
        console.warn("[agent-issue] getBySource failed:", error.message);
        return null;
    }
    return (data ?? null) as AgentIssue | null;
}

/**
 * Indexed lookup by business_flow_key. Backed by
 * `idx_agent_issue_business_flow_key` (and the unique partial index
 * `uq_agent_issue_business_flow_open` for OPEN states).
 *
 * Phase 2 producers (ap-issue.ts) call this to find the issue for a
 * vendor/invoice/po flow without paging the whole listIssues window —
 * O(1) instead of O(n).
 *
 * @param onlyOpen When true (default), restricts to lifecycle states that
 *   are still in-flight. Approve/reject paths should pass `false` so a
 *   completed-then-reopened flow can still be found.
 */
/**
 * Per-handler issue counts grouped by lifecycle state. Used by
 * `/api/command-board/agents` to render the "currently handling" overlay
 * on the dashboard agent tree — each agent shows live working/blocked
 * counts so Will can see what Aria is actively doing without opening
 * the issue list.
 *
 * Returns a flat map keyed by `current_handler` (string). Issues with
 * `current_handler IS NULL` are silently dropped — they have no agent to
 * attribute to. Best-effort: a query failure returns an empty map so the
 * dashboard renders without the overlay rather than blowing up.
 */
export type IssueHandlerCounts = {
    working: number;       // detected | triaging | working
    waitingExternal: number;
    blocked: number;
    total: number;         // sum of the above
};

export async function getCurrentlyHandlingCounts(): Promise<Record<string, IssueHandlerCounts>> {
    const db = createClient();
    if (!db) return {};

    const OPEN: IssueLifecycleState[] = [
        "detected", "triaging", "working", "waiting_external", "blocked",
    ];
    const { data, error } = await supabase
        .from("agent_issue")
        .select("current_handler, lifecycle_state")
        .in("lifecycle_state", OPEN);
    if (error) {
        console.warn("[agent-issue] getCurrentlyHandlingCounts failed:", error.message);
        return {};
    }

    const out: Record<string, IssueHandlerCounts> = {};
    for (const row of (data ?? []) as Array<{ current_handler: string | null; lifecycle_state: string }>) {
        const h = row.current_handler;
        if (!h) continue;
        const bucket = (out[h] ??= { working: 0, waitingExternal: 0, blocked: 0, total: 0 });
        if (row.lifecycle_state === "blocked") bucket.blocked += 1;
        else if (row.lifecycle_state === "waiting_external") bucket.waitingExternal += 1;
        else bucket.working += 1;
        bucket.total += 1;
    }
    return out;
}

/**
 * Find the most actionable open task linked to this issue, for routing
 * Telegram inline-button taps. Preference order:
 *   1. NEEDS_APPROVAL (Will needs to decide)
 *   2. PENDING / CLAIMED / RUNNING (in-flight, can be dismissed/cancelled)
 *
 * Returns null when nothing is linked or all linked tasks are terminal —
 * callers should fall back to issue-level resolution (clearBlocker +
 * complete) in that case.
 *
 * Best-effort: a query failure returns null (not throw). The caller
 * surfaces that to Will as "no actionable task — resolve at the issue
 * level".
 */
export async function findLinkedOpenTask(
    issueId: string,
): Promise<{ id: string; status: string; source_table: string | null; source_id: string | null } | null> {
    const db = createClient();
    if (!db) return null;
    const ACTIONABLE = ["NEEDS_APPROVAL", "PENDING", "CLAIMED", "RUNNING"];
    const { data, error } = await supabase
        .from("agent_task")
        .select("id, status, source_table, source_id")
        .eq("issue_id", issueId)
        .in("status", ACTIONABLE);
    if (error) {
        console.warn("[agent-issue] findLinkedOpenTask failed:", error.message);
        return null;
    }
    if (!data || data.length === 0) return null;
    // Prefer NEEDS_APPROVAL over in-flight states.
    data.sort((a: any, b: any) => {
        const rank = (s: string) => (s === "NEEDS_APPROVAL" ? 0 : 1);
        return rank(a.status) - rank(b.status);
    });
    return data[0] as any;
}

export async function getByBusinessFlowKey(
    businessFlowKey: string,
    onlyOpen = true,
): Promise<AgentIssue | null> {
    const db = createClient();
    if (!db) return null;
    let q = supabase
        .from("agent_issue")
        .select("*")
        .eq("business_flow_key", businessFlowKey);
    if (onlyOpen) {
        q = q.in("lifecycle_state", ["detected", "triaging", "working", "waiting_external", "blocked"]);
    } else {
        // No partial-unique guarantee outside open states — pick the most
        // recently-updated row so callers get the canonical instance.
        q = q.order("updated_at", { ascending: false }).limit(1);
    }
    const { data, error } = await q.maybeSingle();
    if (error) {
        console.warn("[agent-issue] getByBusinessFlowKey failed:", error.message);
        return null;
    }
    return (data ?? null) as AgentIssue | null;
}
