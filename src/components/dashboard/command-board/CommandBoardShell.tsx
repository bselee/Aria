/**
 * @file    CommandBoardShell.tsx
 * @purpose Top-level layout for the Aria Command Board. Wires the agent
 *          rail, work-queue board, task detail, cron strip, and ops module
 *          dock together. Polls every 30s; manual refresh appends `?bust=1`.
 *
 *          NO realtime subscriptions live here — existing panels keep their
 *          own. NO mock data — every visible count comes from a live API.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bell, RefreshCw } from "lucide-react";

import AgentCatalogPanel from "./AgentCatalogPanel";
import AgentHierarchyPanel from "./AgentHierarchyPanel";
import CronRunsPanel from "./CronRunsPanel";
import OpsModuleDock from "./OpsModuleDock";
import TaskDetailPanel from "./TaskDetailPanel";
import WorkQueueBoard from "./WorkQueueBoard";
import type {
    CommandBoardAgent,
    CommandBoardCatalog,
    CommandBoardCron,
    CommandBoardHeartbeat,
    CommandBoardSummary,
    CommandBoardTaskCard,
} from "./types";

type CommandBoardShellProps = {
    /** Polling interval in ms. Defaults to 30 000 — matches spec. */
    pollIntervalMs?: number;
    /**
     * Optional `fetch` override. Tests inject `vi.fn` here so we never go
     * through the real network.
     */
    fetchImpl?: typeof fetch;
};

type AgentsResponse = CommandBoardCatalog & {
    agents: CommandBoardAgent[];
};

type TasksResponse = {
    tasks: CommandBoardTaskCard[];
    total?: number;
};

type HeartbeatsResponse = {
    heartbeats: CommandBoardHeartbeat[];
};

type CronsResponse = {
    crons: CommandBoardCron[];
};

async function fetchJson<T>(
    fx: typeof fetch,
    url: string,
): Promise<T> {
    const res = await fx(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

function HealthChip({
    label,
    value,
    accent,
}: {
    label: string;
    value: string | number;
    accent: string;
}) {
    return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900/60 border border-zinc-800/60">
            <span className={`w-1.5 h-1.5 rounded-full ${accent}`} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                {label}
            </span>
            <span className="text-[11px] font-mono text-zinc-200">{value}</span>
        </div>
    );
}

export function CommandBoardShell({
    pollIntervalMs = 30_000,
    fetchImpl,
}: CommandBoardShellProps) {
    const fx = fetchImpl ?? fetch;

    const [summary, setSummary] = useState<CommandBoardSummary | null>(null);
    const [catalog, setCatalog] = useState<CommandBoardCatalog | null>(null);
    const [agents, setAgents] = useState<CommandBoardAgent[]>([]);
    const [tasks, setTasks] = useState<CommandBoardTaskCard[]>([]);
    const [heartbeats, setHeartbeats] = useState<CommandBoardHeartbeat[]>([]);
    const [crons, setCrons] = useState<CommandBoardCron[]>([]);

    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    const [refreshing, setRefreshing] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    const aborterRef = useRef<AbortController | null>(null);

    const fetchAll = useCallback(
        async (bust = false) => {
            aborterRef.current?.abort();
            const aborter = new AbortController();
            aborterRef.current = aborter;
            const suffix = bust ? "?bust=1" : "";
            setRefreshing(true);
            setLastError(null);
            try {
                const [s, a, t, h, c] = await Promise.all([
                    fetchJson<CommandBoardSummary>(
                        fx,
                        `/api/command-board${suffix}`,
                    ).catch(err => {
                        // summary is optional — keep going if it fails
                        console.warn("[command-board] summary failed", err);
                        return null;
                    }),
                    fetchJson<AgentsResponse>(
                        fx,
                        `/api/command-board/agents${suffix}`,
                    ),
                    fetchJson<TasksResponse>(
                        fx,
                        `/api/command-board/tasks${suffix}`,
                    ),
                    fetchJson<HeartbeatsResponse>(
                        fx,
                        `/api/command-board/heartbeats${suffix}`,
                    ),
                    fetchJson<CronsResponse>(
                        fx,
                        `/api/command-board/crons${suffix}`,
                    ),
                ]);
                if (s) setSummary(s);
                setCatalog(a);
                setAgents(a.agents ?? []);
                setTasks(t.tasks ?? []);
                setHeartbeats(h.heartbeats ?? []);
                setCrons(c.crons ?? []);
                setLastUpdated(Date.now());
            } catch (err) {
                if ((err as { name?: string })?.name === "AbortError") return;
                setLastError(err instanceof Error ? err.message : String(err));
            } finally {
                setRefreshing(false);
            }
        },
        [fx],
    );

    useEffect(() => {
        fetchAll(false);
        const id = setInterval(() => fetchAll(false), pollIntervalMs);
        return () => {
            clearInterval(id);
            aborterRef.current?.abort();
        };
    }, [fetchAll, pollIntervalMs]);

    const visibleTasks = useMemo(() => {
        if (!selectedAgentId) return tasks;
        const agent = agents.find(a => a.id === selectedAgentId);
        if (!agent) return tasks;
        return tasks.filter(t => t.owner === agent.label);
    }, [tasks, selectedAgentId, agents]);

    const summaryCounts = useMemo(() => {
        if (summary) return summary;
        // Fallback: derive from tasks/agents/crons in case the summary
        // endpoint isn't available.
        const lanes = {
            "needs-will": 0,
            running: 0,
            "blocked-failed": 0,
            autonomous: 0,
            "recently-closed": 0,
        };
        for (const t of tasks) {
            const lane = (t.lane ?? "running") as keyof typeof lanes;
            if (lanes[lane] != null) lanes[lane]++;
        }
        const healthy = heartbeats.filter(h => h.staleness === "fresh").length;
        const stale = heartbeats.filter(h => h.staleness !== "fresh").length;
        // Count cron *definitions* by latest status, not 24h run volume.
        // Each cron in the registry maps to exactly one bucket so the sum
        // stays equal to total — gives a meaningful "X / Y healthy" chip
        // instead of a flood of run-events.
        const cronHealthy = crons.filter(c => c.lastStatus === "success").length;
        const cronError = crons.filter(c => c.lastStatus === "error").length;
        const cronNeverRun = crons.filter(c => c.lastStatus == null).length;
        return {
            lanes,
            agents: { total: agents.length, healthy, stale },
            crons: {
                total: crons.length,
                healthy: cronHealthy,
                error: cronError,
                neverRun: cronNeverRun,
                recentSuccess24h: 0,
                recentError24h: 0,
            },
        } as CommandBoardSummary;
    }, [summary, tasks, heartbeats, crons, agents.length]);

    const openCount =
        (summaryCounts.lanes["needs-will"] ?? 0) +
        (summaryCounts.lanes.running ?? 0) +
        (summaryCounts.lanes["blocked-failed"] ?? 0) +
        (summaryCounts.lanes.autonomous ?? 0);
    const closedCount = summaryCounts.lanes["recently-closed"] ?? 0;

    const cronAccent =
        summaryCounts.crons.error > 0
            ? "bg-rose-500"
            : summaryCounts.crons.healthy > 0
              ? "bg-emerald-500"
              : "bg-zinc-600";

    return (
        <div
            className="flex flex-col h-screen bg-[#09090b] text-zinc-100"
            data-testid="command-board-shell"
        >
            {/* Top bar */}
            <header className="px-4 py-2 border-b border-zinc-800/80 flex items-center gap-3 bg-[#09090b]">
                <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center font-black tracking-tighter text-blue-400 text-xs">
                        A
                    </span>
                    <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">
                        Aria Command Board
                    </h1>
                </div>
                <div className="flex items-center gap-2 ml-2">
                    <HealthChip
                        label="Agents"
                        value={`${summaryCounts.agents.healthy}/${summaryCounts.agents.total}`}
                        accent={
                            summaryCounts.agents.stale > 0
                                ? "bg-amber-400"
                                : "bg-emerald-500"
                        }
                    />
                    <HealthChip
                        label="Crons"
                        value={`${summaryCounts.crons.healthy}/${summaryCounts.crons.total}`}
                        accent={cronAccent}
                    />
                    <HealthChip
                        label="Open"
                        value={openCount}
                        accent={openCount > 0 ? "bg-amber-400" : "bg-zinc-600"}
                    />
                    <HealthChip
                        label="Closed"
                        value={closedCount}
                        accent="bg-emerald-500"
                    />
                </div>
                <div className="flex-1" />
                {lastError ? (
                    <span
                        className="flex items-center gap-1 text-[10px] font-mono text-rose-400"
                        title={lastError}
                    >
                        <Bell className="w-3 h-3" />
                        api error
                    </span>
                ) : null}
                {lastUpdated ? (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
                        <Activity className="w-3 h-3" />
                        {new Date(lastUpdated).toLocaleTimeString()}
                    </span>
                ) : null}
                <button
                    type="button"
                    aria-label="Refresh command board"
                    onClick={() => fetchAll(true)}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 border border-zinc-700 text-xs"
                >
                    <RefreshCw
                        className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
                    />
                    Refresh
                </button>
            </header>

            {/* Main grid: left rail / center board / right detail; bottom dock */}
            <div className="flex-1 grid grid-cols-[260px_1fr_320px] gap-2 p-2 overflow-hidden">
                <div className="flex flex-col gap-2 overflow-hidden">
                    <div className="flex-1 overflow-hidden">
                        <AgentHierarchyPanel
                            agents={agents}
                            heartbeats={heartbeats}
                            tasks={tasks}
                            selectedAgentId={selectedAgentId}
                            onSelectAgent={setSelectedAgentId}
                        />
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <AgentCatalogPanel
                            catalog={catalog}
                            selectedAgentId={selectedAgentId}
                        />
                    </div>
                </div>

                <div className="overflow-hidden">
                    <WorkQueueBoard
                        tasks={visibleTasks}
                        selectedTaskId={selectedTaskId}
                        onSelectTask={setSelectedTaskId}
                    />
                </div>

                <div className="flex flex-col gap-2 overflow-hidden">
                    <div className="flex-1 overflow-hidden">
                        <TaskDetailPanel
                            selectedTaskId={selectedTaskId}
                            fetchImpl={fx}
                            onActionComplete={() => fetchAll(true)}
                        />
                    </div>
                    <div className="h-[200px] shrink-0 overflow-hidden">
                        <CronRunsPanel crons={crons} />
                    </div>
                </div>
            </div>

            <div className="h-[320px] shrink-0 border-t border-zinc-800/80 bg-[#09090b] p-2 overflow-hidden">
                <OpsModuleDock />
            </div>
        </div>
    );
}

export default CommandBoardShell;
