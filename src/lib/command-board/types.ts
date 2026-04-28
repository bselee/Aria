/**
 * @file    types.ts
 * @purpose Shared types for the Aria Command Board backend. Consumed by
 *          `service.ts`, the `/api/command-board/*` routes, and the frontend
 *          via JSON. Catalog uses `references` (not `soul`) by design.
 */

// ── Catalog ─────────────────────────────────────────────────────────────────

export type CommandBoardAgent = {
    id: string;
    label: string;
    reportsTo: string | null;
    filePath?: string;
    process: string[];
    skills: string[];
    workflows: string[];
};

export type CommandBoardCatalogFile = {
    id: string;
    name: string;
    path: string;
    summary: string;
};

export type CommandBoardSkill = {
    id: string;
    name: string;
    path: string;
    description: string;
};

export type CommandBoardWorkflow = {
    id: string;
    name: string;
    path: string;
    description: string;
};

export type CommandBoardReference = {
    id: string;
    name: string;
    path: string;
    summary: string;
};

export type CommandBoardCatalog = {
    generatedAt: string;
    agents: CommandBoardAgent[];
    agentFiles: CommandBoardCatalogFile[];
    skills: CommandBoardSkill[];
    workflows: CommandBoardWorkflow[];
    references: CommandBoardReference[];
};

// ── Tasks / lanes ───────────────────────────────────────────────────────────

export type CommandBoardLane =
    | "needs-will"
    | "running"
    | "blocked-failed"
    | "autonomous"
    | "recently-closed";

export type CommandBoardTaskCard = {
    id: string;
    title: string;
    lane: CommandBoardLane;
    status: string;
    owner: string | null;
    priority: string | null;
    source_table: string | null;
    source_id: string | null;
    dedup_count: number;
    age_seconds: number;
    parent_task_id: string | null;
    has_children: boolean;
    auto_handled_by: string | null;
};

export type CommandBoardTaskEvent = {
    event_type: string;
    created_at: string;
    payload: any;
};

export type CommandBoardTaskDetail = CommandBoardTaskCard & {
    body: any;
    events: CommandBoardTaskEvent[];
    closes_when: any;
    input_hash: string | null;
    completed_at: string | null;
};

export type CommandBoardTaskFilters = {
    lane?: CommandBoardLane;
    owner?: string;
    sourceTable?: string;
    limit?: number;
};

export type CommandBoardTaskList = {
    tasks: CommandBoardTaskCard[];
    total: number;
};

// ── Crons ───────────────────────────────────────────────────────────────────

export type CommandBoardCron = {
    name: string;
    description: string;
    schedule: string;
    scheduleHuman: string;
    category: string;
    weekdaysOnly: boolean;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    lastStatus: "success" | "error" | null;
};

export type CommandBoardCronRun = {
    id: string;
    task_name: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    error_message: string | null;
};

// ── Heartbeats ──────────────────────────────────────────────────────────────

export type CommandBoardHeartbeat = {
    agent_name: string;
    status: string;
    heartbeat_at: string;
    payload: any;
    staleness: "fresh" | "stale" | "degraded";
};

// ── Run feed ────────────────────────────────────────────────────────────────

export type CommandBoardRun = {
    source: "task_history" | "cron_runs";
    id: string;
    name: string;
    status: string;
    created_at: string;
    payload: any;
};

export type CommandBoardRunFilters = {
    source?: "task_history" | "cron_runs";
    limit?: number;
};

// ── Control requests ────────────────────────────────────────────────────────

export type CommandBoardControlRequest = {
    id: string;
    command: string;
    target: string;
    status: string;
    reason: string | null;
    created_at: string;
    claimed_at: string | null;
    completed_at: string | null;
    requested_by: string | null;
};

// ── Summary ─────────────────────────────────────────────────────────────────

export type CommandBoardSummary = {
    lanes: Record<CommandBoardLane, number>;
    agents: { total: number; healthy: number; stale: number };
    crons: { total: number; recentSuccess: number; recentError: number };
};
