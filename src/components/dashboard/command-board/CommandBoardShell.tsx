/**
 * @file    CommandBoardShell.tsx
 * @purpose Top-level dashboard layout. Module tabs + full-canvas content +
 *          sticky right rail with blocking-me, agent tree, cron health.
 *
 *          The 12 operational panels (AP, Receivings, Ordering, Tracking,
 *          Builds, etc.) get FULL CANVAS now — they were previously crammed
 *          into a 320px bottom dock. The "Blocking Me" tab is the default
 *          and renders the issue-ledger surface (IssuesPanel).
 */
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bell, RefreshCw, ChevronRight, ChevronDown } from "lucide-react";

import AgentHierarchyPanel from "./AgentHierarchyPanel";
import CronRunsPanel from "./CronRunsPanel";
import IssuesPanel from "./IssuesPanel";
import TasksPanel from "@/components/dashboard/TasksPanel";
import { PANEL_BY_ID } from "./panelRegistry";
import type { PanelId } from "./useDashboardLayout";
import type {
    CommandBoardAgent,
    CommandBoardCatalog,
    CommandBoardCron,
    CommandBoardHeartbeat,
    CommandBoardSummary,
    CommandBoardTaskCard,
} from "./types";

type CommandBoardShellProps = {
    pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
};

type AgentsResponse = CommandBoardCatalog & { agents: CommandBoardAgent[] };
type TasksResponse = { tasks: CommandBoardTaskCard[]; total?: number };
type HeartbeatsResponse = { heartbeats: CommandBoardHeartbeat[] };
type CronsResponse = { crons: CommandBoardCron[] };

async function fetchJson<T>(fx: typeof fetch, url: string): Promise<T> {
    const res = await fx(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

// ── Module tab definitions ──────────────────────────────────────────────────
//
// Tab order matches Will's daily ops priority. "Blocking" is first because
// that's where actionable issues surface; AP / Receivings / Ordering follow
// because that's the bulk of the daily flow. Builds + Tracking are
// secondary; Tasks/Activity are diagnostic.
type TabId =
    | "blocking"
    | "ap"
    | "receivings"
    | "ordering"
    | "tracking"
    | "builds"
    | "build-schedule"
    | "statement-recon"
    | "active-pos"
    | "tasks"
    | "oversight"
    | "activity";

type TabDef = { id: TabId; label: string; render: () => React.ReactNode };

const TAB_STORAGE_KEY = "aria-dash-active-tab";

function HealthChip({ label, value, accent }: { label: string; value: string | number; accent: string }) {
    return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900/60 border border-zinc-800/60">
            <span className={`w-1.5 h-1.5 rounded-full ${accent}`} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
            <span className="text-[11px] font-mono text-zinc-200">{value}</span>
        </div>
    );
}

export function CommandBoardShell({ pollIntervalMs = 30_000, fetchImpl }: CommandBoardShellProps) {
    const fx = fetchImpl ?? fetch;

    const [catalog, setCatalog] = useState<CommandBoardCatalog | null>(null);
    const [summary, setSummary] = useState<CommandBoardSummary | null>(null);
    const [agents, setAgents] = useState<CommandBoardAgent[]>([]);
    const [tasks, setTasks] = useState<CommandBoardTaskCard[]>([]);
    const [heartbeats, setHeartbeats] = useState<CommandBoardHeartbeat[]>([]);
    const [crons, setCrons] = useState<CommandBoardCron[]>([]);

    const [activeTab, setActiveTab] = useState<TabId>("blocking");
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [agentRailOpen, setAgentRailOpen] = useState(true);
    const [cronRailOpen, setCronRailOpen] = useState(false);

    const [refreshing, setRefreshing] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    const aborterRef = useRef<AbortController | null>(null);

    // Restore last tab from localStorage
    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
            if (saved) setActiveTab(saved as TabId);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try { window.localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch { /* ignore */ }
    }, [activeTab]);

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
                    fetchJson<CommandBoardSummary>(fx, `/api/command-board${suffix}`).catch(() => null),
                    fetchJson<AgentsResponse>(fx, `/api/command-board/agents${suffix}`),
                    fetchJson<TasksResponse>(fx, `/api/command-board/tasks${suffix}`),
                    fetchJson<HeartbeatsResponse>(fx, `/api/command-board/heartbeats${suffix}`),
                    fetchJson<CronsResponse>(fx, `/api/command-board/crons${suffix}`),
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

    // Map tabs → render functions. Reuses existing panels by id.
    const panelById = useCallback(
        (id: PanelId) => PANEL_BY_ID[id]?.render() ?? <div className="p-4 text-zinc-500">panel missing: {id}</div>,
        [],
    );

    const tabs: TabDef[] = useMemo(
        () => [
            { id: "blocking", label: "Blocking Me", render: () => <IssuesPanel /> },
            { id: "ap", label: "AP / Invoices", render: () => panelById("invoice-queue") },
            { id: "receivings", label: "Receivings", render: () => panelById("receivings") },
            { id: "ordering", label: "Ordering", render: () => panelById("purchasing") },
            { id: "tracking", label: "Tracking", render: () => panelById("tracking-board") },
            { id: "builds", label: "Build Risk", render: () => panelById("build-risk") },
            { id: "build-schedule", label: "Build Schedule", render: () => panelById("build-schedule") },
            { id: "statement-recon", label: "Statement Recon", render: () => panelById("statement-reconciliation") },
            { id: "active-pos", label: "Active POs", render: () => panelById("active-purchases") },
            { id: "tasks", label: "Tasks", render: () => <TasksPanel /> },
            { id: "oversight", label: "Oversight", render: () => panelById("oversight") },
            { id: "activity", label: "Activity", render: () => panelById("activity") },
        ],
        [panelById],
    );

    const activeTabDef = tabs.find(t => t.id === activeTab) ?? tabs[0];

    // Health summary
    const summaryCounts = useMemo(() => {
        if (summary) return summary;
        const lanes = { "needs-will": 0, running: 0, "blocked-failed": 0, autonomous: 0, "recently-closed": 0 };
        for (const t of tasks) {
            const lane = (t.lane ?? "running") as keyof typeof lanes;
            if (lanes[lane] != null) lanes[lane]++;
        }
        const healthy = heartbeats.filter(h => h.staleness === "fresh").length;
        const stale = heartbeats.filter(h => h.staleness !== "fresh").length;
        const cronHealthy = crons.filter(c => c.lastStatus === "success").length;
        const cronError = crons.filter(c => c.lastStatus === "error").length;
        const cronNeverRun = crons.filter(c => c.lastStatus == null).length;
        return {
            lanes,
            agents: { total: agents.length, healthy, stale },
            crons: { total: crons.length, healthy: cronHealthy, error: cronError, neverRun: cronNeverRun, recentSuccess24h: 0, recentError24h: 0 },
        } as CommandBoardSummary;
    }, [summary, tasks, heartbeats, crons, agents.length]);

    const cronAccent = summaryCounts.crons.error > 0 ? "bg-rose-500"
        : summaryCounts.crons.healthy > 0 ? "bg-emerald-500" : "bg-zinc-600";

    const needsWill = summaryCounts.lanes["needs-will"] ?? 0;

    return (
        <div className="flex flex-col h-screen bg-[#09090b] text-zinc-100" data-testid="command-board-shell">
            {/* Header */}
            <header className="px-4 py-2 border-b border-zinc-800/80 flex items-center gap-3 bg-[#09090b]">
                <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center font-black tracking-tighter text-blue-400 text-xs">
                        A
                    </span>
                    <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">Aria · Command Board</h1>
                </div>
                <div className="flex items-center gap-2 ml-2">
                    <HealthChip
                        label="needs you"
                        value={needsWill}
                        accent={needsWill > 0 ? "bg-amber-400" : "bg-emerald-500"}
                    />
                    <HealthChip
                        label="agents"
                        value={`${summaryCounts.agents.healthy}/${summaryCounts.agents.total}`}
                        accent={summaryCounts.agents.stale > 0 ? "bg-amber-400" : "bg-emerald-500"}
                    />
                    <HealthChip
                        label="crons"
                        value={`${summaryCounts.crons.healthy}/${summaryCounts.crons.total}`}
                        accent={cronAccent}
                    />
                </div>
                <div className="flex-1" />
                {lastError && (
                    <span title={lastError} className="flex items-center gap-1 text-[10px] font-mono text-rose-400">
                        <Bell className="w-3 h-3" /> error
                    </span>
                )}
                {lastUpdated && (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
                        <Activity className="w-3 h-3" />
                        {new Date(lastUpdated).toLocaleTimeString()}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => fetchAll(true)}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 border border-zinc-700 text-xs"
                >
                    <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                    Refresh
                </button>
            </header>

            {/* Module tab bar */}
            <nav
                role="tablist"
                aria-label="Operational modules"
                className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-950/60"
            >
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        data-testid={`shell-tab-${tab.id}`}
                        className={`px-2.5 py-1 rounded text-[11px] font-mono uppercase tracking-wider border transition-colors ${
                            activeTab === tab.id
                                ? "bg-blue-500/20 text-blue-100 border-blue-500/40"
                                : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:border-zinc-700"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </nav>

            {/* Main: full-canvas tab content + right rail */}
            <div className="flex-1 grid grid-cols-[1fr_280px] gap-2 p-2 overflow-hidden">
                {/* Center — full canvas */}
                <div className="overflow-hidden">
                    <div className="h-full overflow-hidden rounded-md border border-zinc-800/60 bg-zinc-950/40">
                        {activeTabDef.render()}
                    </div>
                </div>

                {/* Right rail — agent tree + cron health */}
                <aside className="flex flex-col gap-2 overflow-hidden">
                    <RailSection
                        title="Agents"
                        open={agentRailOpen}
                        onToggle={() => setAgentRailOpen(o => !o)}
                        defaultHeight="flex-1"
                    >
                        <AgentHierarchyPanel
                            agents={agents}
                            heartbeats={heartbeats}
                            tasks={tasks}
                            selectedAgentId={selectedAgentId}
                            onSelectAgent={setSelectedAgentId}
                        />
                    </RailSection>
                    <RailSection
                        title="Crons"
                        open={cronRailOpen}
                        onToggle={() => setCronRailOpen(o => !o)}
                        defaultHeight="h-[200px]"
                    >
                        <CronRunsPanel crons={crons} />
                    </RailSection>
                </aside>
            </div>
        </div>
    );
}

function RailSection({
    title,
    open,
    onToggle,
    defaultHeight,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    defaultHeight: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`${open ? defaultHeight : "shrink-0"} flex flex-col overflow-hidden`}>
            <button
                type="button"
                onClick={onToggle}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500 hover:text-zinc-300 bg-zinc-900/60 border border-zinc-800/60 rounded-t"
            >
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {title}
            </button>
            {open && <div className="flex-1 overflow-hidden border-x border-b border-zinc-800/60 rounded-b">{children}</div>}
        </div>
    );
}

export default CommandBoardShell;
