/**
 * @file    service.ts
 * @purpose Backend aggregation layer for the Aria Command Board. Reads fresh
 *          on every call from `agent_task`, `task_history`, `cron_runs`,
 *          `agent_heartbeats`, `ops_control_requests`, and the on-disk catalog.
 *          NO caching at this layer — routes set Cache-Control: no-store and
 *          rely on this for freshness.
 *
 *          Public entry points used by the /api/command-board/* routes:
 *            getCommandBoardSummary()
 *            getCommandBoardTaskList(filters)
 *            getCommandBoardTaskDetail(id)
 *            getCommandBoardCrons()
 *            getCommandBoardCronRuns(name, limit)
 *            getCommandBoardHeartbeats()
 *            getCommandBoardRuns(filters)
 *            getCommandBoardControlRequests()
 *            createCommandBoardControlRequest(args)
 *            deriveLane(task) — exported for unit-testing
 */

import { createClient } from "@/lib/supabase";
import { CRON_JOBS } from "@/lib/scheduler/cron-registry";
import { listTasks, getById, type AgentTask, type AgentTaskStatus } from "@/lib/intelligence/agent-task";
import { COMMAND_BOARD_HIERARCHY } from "./catalog";
import { createOpsControlRequest } from "@/lib/ops/control-plane-db";
import type {
    CommandBoardCron,
    CommandBoardCronRun,
    CommandBoardLane,
    CommandBoardTaskCard,
    CommandBoardTaskDetail,
    CommandBoardTaskFilters,
    CommandBoardTaskList,
    CommandBoardHeartbeat,
    CommandBoardRun,
    CommandBoardRunFilters,
    CommandBoardControlRequest,
    CommandBoardSummary,
} from "./types";

// ── Lane derivation ─────────────────────────────────────────────────────────

const RECENTLY_CLOSED_WINDOW_MS = 24 * 60 * 60 * 1000;

export function deriveLane(t: AgentTask): CommandBoardLane {
    const status = t.status;
    const owner = (t.owner ?? "").toLowerCase();

    if (status === "NEEDS_APPROVAL") return "needs-will";
    if (status === "FAILED" && owner.includes("will")) return "needs-will";
    if (status === "FAILED") return "blocked-failed";
    if (status === "RUNNING" || status === "CLAIMED") return "running";

    if ((status === "SUCCEEDED" || status === "CANCELLED") && t.completed_at) {
        const completedMs = new Date(t.completed_at).getTime();
        if (Number.isFinite(completedMs) && Date.now() - completedMs <= RECENTLY_CLOSED_WINDOW_MS) {
            return "recently-closed";
        }
    }

    // PENDING + everything else (incl. APPROVED/REJECTED/EXPIRED + SUCCEEDED
    // without a completed_at) folds into "autonomous" — Aria is handling it
    // unattended unless it bubbles up via a different lane.
    return "autonomous";
}

function ageSeconds(iso: string | null | undefined): number {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function priorityToLabel(p: number | null | undefined): string | null {
    if (p === null || p === undefined) return null;
    if (p <= 0) return "P0";
    if (p === 1) return "P1";
    if (p === 2) return "P2";
    if (p === 3) return "P3";
    return `P${p}`;
}

function toCard(t: AgentTask, hasChildren: boolean): CommandBoardTaskCard {
    return {
        id: t.id,
        title: t.goal,
        lane: deriveLane(t),
        status: t.status,
        owner: t.owner ?? null,
        priority: priorityToLabel(t.priority),
        source_table: t.source_table,
        source_id: t.source_id,
        dedup_count: t.dedup_count ?? 1,
        age_seconds: ageSeconds(t.created_at),
        parent_task_id: t.parent_task_id,
        has_children: hasChildren,
        auto_handled_by: t.auto_handled_by ?? null,
        playbook_kind: t.playbook_kind ?? null,
        playbook_state: (t.playbook_state ?? null) as
            | "queued"
            | "running"
            | "succeeded"
            | "failed"
            | "manual_only"
            | null,
    };
}

// ── Summary ─────────────────────────────────────────────────────────────────

export async function getCommandBoardSummary(): Promise<CommandBoardSummary> {
    const supabase = createClient();
    const lanes: Record<CommandBoardLane, number> = {
        "needs-will": 0,
        "running": 0,
        "blocked-failed": 0,
        "autonomous": 0,
        "recently-closed": 0,
    };
    let healthy = 0;
    let stale = 0;
    const total = COMMAND_BOARD_HIERARCHY.length;

    let recentSuccess24h = 0;
    let recentError24h = 0;
    let cronHealthy = 0;
    let cronError = 0;
    let cronNeverRun = 0;

    if (supabase) {
        try {
            const tasks = await listTasks({ limit: 500 });
            for (const t of tasks) {
                lanes[deriveLane(t)] += 1;
            }
        } catch {
            /* best-effort */
        }

        try {
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const { data: recentRows } = await supabase
                .from("cron_runs")
                .select("status, started_at")
                .gte("started_at", since)
                .limit(1000);
            for (const row of recentRows ?? []) {
                if (row?.status === "success") recentSuccess24h++;
                else if (row?.status === "error") recentError24h++;
            }
        } catch {
            /* best-effort */
        }

        // Latest status per cron definition. Joins `CRON_JOBS` (the definition
        // list) against `cron_runs` (the audit table). Each definition is
        // categorized as healthy (latest run succeeded), error (latest run
        // failed), or never-run (no row in cron_runs). Count always sums to
        // CRON_JOBS.length so the dashboard chip is "X / Y healthy".
        try {
            const { data: latestRows } = await supabase
                .from("cron_runs")
                .select("task_name, status, started_at")
                .order("started_at", { ascending: false })
                .limit(2000);
            const latestByName = new Map<string, "success" | "error">();
            for (const row of latestRows ?? []) {
                const name = (row as { task_name?: string }).task_name;
                if (!name || latestByName.has(name)) continue;
                const status = (row as { status?: string }).status;
                if (status === "success" || status === "error") {
                    latestByName.set(name, status);
                }
            }
            for (const job of CRON_JOBS) {
                const latest = latestByName.get(job.name);
                if (latest === "success") cronHealthy++;
                else if (latest === "error") cronError++;
                else cronNeverRun++;
            }
        } catch {
            // On query failure, default to never-run so the chip reads "0/N"
            // (truthful: we don't know).
            cronNeverRun = CRON_JOBS.length;
        }

        try {
            const heartbeats = await getCommandBoardHeartbeats();
            for (const h of heartbeats) {
                if (h.staleness === "fresh") healthy++;
                else stale++;
            }
        } catch {
            /* best-effort */
        }
    } else {
        cronNeverRun = CRON_JOBS.length;
    }

    return {
        lanes,
        agents: { total, healthy, stale },
        crons: {
            total: CRON_JOBS.length,
            healthy: cronHealthy,
            error: cronError,
            neverRun: cronNeverRun,
            recentSuccess24h,
            recentError24h,
        },
    };
}

// ── Dashboard tasks compatibility wrapper ───────────────────────────────────
//
// The legacy /api/dashboard/tasks route was reading agent_task directly with
// its own listTasks call + cache + counts. That made /dashboard/tasks and
// /dashboard read independent data sources — they could disagree if one
// query short-circuited or filtered differently.
//
// This helper centralises the filter logic so both routes share the same
// task source. Returns the raw AgentTask shape the legacy /dashboard/tasks
// page already expects (rows, not lane cards).

export type DashboardTasksFilters = {
    status?: string[];
    type?: string[];
    owner?: string;
    limit?: number;
    /** Whether to include FAILED tasks from the last 24h when no explicit status filter is given. */
    includeRecentFailed?: boolean;
};

export type DashboardTasksResult = {
    tasks: AgentTask[];
    counts: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        byOwner: Record<string, number>;
    };
    cachedAt: string;
};

export async function getDashboardTasks(
    filters: DashboardTasksFilters = {},
): Promise<DashboardTasksResult> {
    const tasks = await listTasks({
        status: filters.status,
        type: filters.type,
        owner: filters.owner,
        limit: filters.limit,
        includeRecentFailed: filters.includeRecentFailed,
    });

    const counts = {
        total: tasks.length,
        byStatus: {} as Record<string, number>,
        byType: {} as Record<string, number>,
        byOwner: {} as Record<string, number>,
    };
    for (const t of tasks) {
        counts.byStatus[t.status] = (counts.byStatus[t.status] ?? 0) + 1;
        counts.byType[t.type] = (counts.byType[t.type] ?? 0) + 1;
        counts.byOwner[t.owner] = (counts.byOwner[t.owner] ?? 0) + 1;
    }

    return {
        tasks,
        counts,
        cachedAt: new Date().toISOString(),
    };
}

// ── Task list / detail ──────────────────────────────────────────────────────

export async function getCommandBoardTaskList(
    filters: CommandBoardTaskFilters,
): Promise<CommandBoardTaskList> {
    const supabase = createClient();
    if (!supabase) return { tasks: [], total: 0 };

    const lane = filters.lane;
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

    // Fetch a wide candidate set, filter to the requested lane in JS. The lane
    // categorization mixes status + owner + completed_at windows that aren't
    // expressible as a single SQL filter.
    let rows: AgentTask[] = [];
    try {
        // Pull open tasks plus recent terminal tasks so "recently-closed" is
        // populated.
        const baseLimit = Math.min(limit * 4, 500);
        const since = new Date(Date.now() - RECENTLY_CLOSED_WINDOW_MS).toISOString();

        const open = await listTasks({ limit: baseLimit, owner: filters.owner });
        rows = open;

        // Add recently-closed terminal tasks so the lane has rows to show.
        const { data: closedRows } = await supabase
            .from("agent_task")
            .select("*")
            .in("status", ["SUCCEEDED", "CANCELLED"])
            .gte("completed_at", since)
            .order("completed_at", { ascending: false })
            .limit(baseLimit);
        if (closedRows) rows.push(...(closedRows as AgentTask[]));
    } catch {
        rows = [];
    }

    if (filters.sourceTable) {
        rows = rows.filter((t) => t.source_table === filters.sourceTable);
    }
    if (filters.owner) {
        rows = rows.filter((t) => (t.owner ?? "") === filters.owner);
    }

    // Lookup which rows have children (best-effort, single query).
    const ids = rows.map((r) => r.id);
    const childParents = new Set<string>();
    if (ids.length > 0) {
        try {
            const { data: children } = await supabase
                .from("agent_task")
                .select("parent_task_id")
                .in("parent_task_id", ids);
            for (const c of children ?? []) {
                if (c?.parent_task_id) childParents.add(c.parent_task_id);
            }
        } catch {
            /* best-effort */
        }
    }

    let cards: CommandBoardTaskCard[] = rows.map((t) => toCard(t, childParents.has(t.id)));

    if (lane) {
        cards = cards.filter((c) => c.lane === lane);
    }

    // Sort: needs-will → running → blocked-failed → autonomous → recently-closed.
    const laneOrder: Record<CommandBoardLane, number> = {
        "needs-will": 0,
        "running": 1,
        "blocked-failed": 2,
        "autonomous": 3,
        "recently-closed": 4,
    };
    cards.sort((a, b) => {
        const la = laneOrder[a.lane];
        const lb = laneOrder[b.lane];
        if (la !== lb) return la - lb;
        return a.age_seconds - b.age_seconds;
    });

    const total = cards.length;
    if (cards.length > limit) cards = cards.slice(0, limit);
    return { tasks: cards, total };
}

export async function getCommandBoardTaskDetail(
    id: string,
): Promise<CommandBoardTaskDetail | null> {
    const supabase = createClient();
    if (!supabase) return null;

    let row: AgentTask | null = null;
    try {
        row = await getById(id);
    } catch {
        row = null;
    }
    if (!row) return null;

    let events: { event_type: string; created_at: string; payload: any }[] = [];
    try {
        const { data } = await supabase
            .from("task_history")
            .select("event_type, created_at, execution_trace")
            .eq("task_id", id)
            .order("created_at", { ascending: true })
            .limit(200);
        events = (data ?? []).map((r: any) => ({
            event_type: r.event_type,
            created_at: r.created_at,
            payload: r.execution_trace ?? {},
        }));
    } catch {
        events = [];
    }

    let hasChildren = false;
    try {
        const { data: kids } = await supabase
            .from("agent_task")
            .select("id")
            .eq("parent_task_id", id)
            .limit(1);
        hasChildren = (kids ?? []).length > 0;
    } catch {
        hasChildren = false;
    }

    const card = toCard(row, hasChildren);

    return {
        ...card,
        body: {
            inputs: row.inputs ?? {},
            outputs: row.outputs ?? {},
            type: row.type,
            requires_approval: row.requires_approval,
            approval_decision: row.approval_decision,
            approval_decided_by: row.approval_decided_by,
            approval_decided_at: row.approval_decided_at,
            deadline_at: row.deadline_at,
            retry_count: row.retry_count,
            max_retries: row.max_retries,
            claimed_at: row.claimed_at,
            claimed_by: row.claimed_by,
            updated_at: row.updated_at,
        },
        events,
        closes_when: row.closes_when ?? null,
        input_hash: row.input_hash ?? null,
        completed_at: row.completed_at,
    };
}

// ── Crons ───────────────────────────────────────────────────────────────────

type CronRunRow = {
    task_name: string;
    started_at: string | null;
    duration_ms: number | null;
    status: "success" | "error" | "running" | string | null;
};

export async function getCommandBoardCrons(): Promise<CommandBoardCron[]> {
    const supabase = createClient();
    const latestByName = new Map<string, CronRunRow>();

    if (supabase) {
        try {
            const { data } = await supabase
                .from("cron_runs")
                .select("task_name, started_at, duration_ms, status")
                .order("started_at", { ascending: false })
                .limit(1000);
            for (const row of (data ?? []) as CronRunRow[]) {
                if (!row?.task_name) continue;
                if (!latestByName.has(row.task_name)) {
                    latestByName.set(row.task_name, row);
                }
            }
        } catch {
            /* best-effort */
        }
    }

    return CRON_JOBS.map((job) => {
        const last = latestByName.get(job.name);
        const lastStatus =
            last?.status === "success" ? "success" : last?.status === "error" ? "error" : null;
        return {
            name: job.name,
            description: job.description,
            schedule: job.schedule,
            scheduleHuman: job.scheduleHuman,
            category: job.category,
            weekdaysOnly: job.weekdaysOnly,
            lastRunAt: last?.started_at ?? null,
            lastDurationMs: last?.duration_ms ?? null,
            lastStatus,
        };
    });
}

export async function getCommandBoardCronRuns(
    name: string,
    limit = 50,
): Promise<CommandBoardCronRun[]> {
    const supabase = createClient();
    if (!supabase) return [];
    try {
        const { data } = await supabase
            .from("cron_runs")
            .select("id, task_name, status, started_at, finished_at, duration_ms, error_message")
            .eq("task_name", name)
            .order("started_at", { ascending: false })
            .limit(Math.min(Math.max(limit, 1), 500));
        return ((data ?? []) as any[]).map((r) => ({
            id: String(r.id),
            task_name: r.task_name,
            status: r.status ?? "unknown",
            started_at: r.started_at ?? null,
            finished_at: r.finished_at ?? null,
            duration_ms: r.duration_ms ?? null,
            error_message: r.error_message ?? null,
        }));
    } catch {
        return [];
    }
}

// ── Heartbeats ──────────────────────────────────────────────────────────────

const HEARTBEAT_FRESH_SECONDS = 5 * 60;
const HEARTBEAT_STALE_SECONDS = 30 * 60;

export async function getCommandBoardHeartbeats(): Promise<CommandBoardHeartbeat[]> {
    const supabase = createClient();
    if (!supabase) return [];
    try {
        const { data } = await supabase
            .from("agent_heartbeats")
            .select("agent_name, status, heartbeat_at, metadata")
            .order("heartbeat_at", { ascending: false });
        const rows = (data ?? []) as Array<{
            agent_name: string;
            status: string;
            heartbeat_at: string;
            metadata: any;
        }>;
        return rows.map((r) => {
            const ageSec = ageSeconds(r.heartbeat_at);
            let staleness: CommandBoardHeartbeat["staleness"] = "fresh";
            if (r.status && r.status !== "healthy") staleness = "degraded";
            else if (ageSec > HEARTBEAT_STALE_SECONDS) staleness = "degraded";
            else if (ageSec > HEARTBEAT_FRESH_SECONDS) staleness = "stale";
            return {
                agent_name: r.agent_name,
                status: r.status ?? "unknown",
                heartbeat_at: r.heartbeat_at,
                payload: r.metadata ?? {},
                staleness,
            };
        });
    } catch {
        return [];
    }
}

// ── Unified runs feed ───────────────────────────────────────────────────────

export async function getCommandBoardRuns(
    filters: CommandBoardRunFilters,
): Promise<CommandBoardRun[]> {
    const supabase = createClient();
    if (!supabase) return [];

    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const want = filters.source;

    const out: CommandBoardRun[] = [];

    if (!want || want === "task_history") {
        try {
            const { data } = await supabase
                .from("task_history")
                .select("id, agent_name, task_type, event_type, status, created_at, execution_trace")
                .order("created_at", { ascending: false })
                .limit(limit);
            for (const r of (data ?? []) as any[]) {
                out.push({
                    source: "task_history",
                    id: String(r.id),
                    name: r.agent_name ?? r.task_type ?? r.event_type ?? "unknown",
                    status: r.status ?? r.event_type ?? "unknown",
                    created_at: r.created_at,
                    payload: {
                        event_type: r.event_type,
                        task_type: r.task_type,
                        execution_trace: r.execution_trace ?? {},
                    },
                });
            }
        } catch {
            /* best-effort */
        }
    }

    if (!want || want === "cron_runs") {
        try {
            const { data } = await supabase
                .from("cron_runs")
                .select("id, task_name, status, started_at, finished_at, duration_ms, error_message")
                .order("started_at", { ascending: false })
                .limit(limit);
            for (const r of (data ?? []) as any[]) {
                out.push({
                    source: "cron_runs",
                    id: String(r.id),
                    name: r.task_name,
                    status: r.status ?? "unknown",
                    created_at: r.started_at ?? new Date(0).toISOString(),
                    payload: {
                        finished_at: r.finished_at,
                        duration_ms: r.duration_ms,
                        error_message: r.error_message,
                    },
                });
            }
        } catch {
            /* best-effort */
        }
    }

    out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return out.slice(0, limit);
}

// ── Control requests ────────────────────────────────────────────────────────

export async function getCommandBoardControlRequests(
    limit = 100,
): Promise<CommandBoardControlRequest[]> {
    const supabase = createClient();
    if (!supabase) return [];
    try {
        const { data } = await supabase
            .from("ops_control_requests")
            .select(
                "id, command, target, status, reason, requested_by, created_at, claimed_at, completed_at",
            )
            .order("created_at", { ascending: false })
            .limit(Math.min(Math.max(limit, 1), 500));
        return ((data ?? []) as any[]).map((r) => ({
            id: String(r.id),
            command: r.command,
            target: r.target,
            status: r.status,
            reason: r.reason ?? null,
            requested_by: r.requested_by ?? null,
            created_at: r.created_at,
            claimed_at: r.claimed_at ?? null,
            completed_at: r.completed_at ?? null,
        }));
    } catch {
        return [];
    }
}

export type CreateControlRequestArgs = {
    command: string;
    target?: string;
    reason?: string;
    payload?: Record<string, unknown>;
    requestedBy?: string;
};

export async function createCommandBoardControlRequest(
    args: CreateControlRequestArgs,
): Promise<CommandBoardControlRequest | null> {
    const supabase = createClient();
    if (!supabase) return null;
    const row = await createOpsControlRequest(supabase, {
        command: args.command as any,
        target: args.target as any,
        reason: args.reason,
        payload: args.payload,
        requestedBy: args.requestedBy ?? "command-board",
    });
    return {
        id: String(row.id),
        command: row.command,
        target: row.target,
        status: row.status,
        reason: row.reason ?? null,
        requested_by: (row as any).requested_by ?? null,
        created_at: row.created_at,
        claimed_at: (row as any).claimed_at ?? null,
        completed_at: (row as any).completed_at ?? null,
    };
}

// Re-export so tests can reference status types.
export type { AgentTaskStatus };
