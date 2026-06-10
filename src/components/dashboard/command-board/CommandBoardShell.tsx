/**
 * @file    CommandBoardShell.tsx
 * @purpose Top-level dashboard layout. Module tabs + full-canvas content.
 *
 *          The 12 operational panels (AP, Receivings, Ordering, Tracking,
 *          Builds, etc.) get FULL CANVAS now — they were previously crammed
 *          into a 320px bottom dock. The "Blocking Me" tab is the default
 *          and renders the issue-ledger surface (IssuesPanel).
 *
 *          Tab switching is instant after first visit: every visited tab
 *          stays mounted (CSS-hidden when inactive) so JIT compile + data
 *          fetch happen ONCE per tab, then switching is pure visibility.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bell, RefreshCw } from "lucide-react";

import ActivePurchasesPanel from "@/components/dashboard/ActivePurchasesPanel";
import PurchasingPanel from "@/components/dashboard/PurchasingPanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";
import { PurchasingLifecycleProvider } from "./PurchasingLifecycleContext";
import AxiomSkuMappingPanel from "./AxiomSkuMappingPanel";
import KanbanBoard from "@/components/dashboard/KanbanBoard";
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

import APHealthPanel from "@/components/dashboard/APHealthPanel";

// ── Module tab definitions ──────────────────────────────────────────────────
//
// Tab order matches Will's daily ops priority. "Blocking" is first because
// that's where actionable issues surface; AP / Receivings / Ordering follow
// because that's the bulk of the daily flow. Builds + Tracking are
// secondary; Tasks/Activity are diagnostic.
type TabId =
    | "lifecycle"
    | "builds"
    | "axiom-skus"
    | "kanban"
    | "activity";

type TabDef = { id: TabId; label: string; render: () => React.ReactNode };

const TAB_STORAGE_KEY = "aria-dash-active-tab";

function PurchasingLifecyclePanel() {
    return (
        <PurchasingLifecycleProvider>
            <div className="flex flex-col h-full min-h-0 overflow-hidden">
                <div className="shrink-0 px-2 pt-2">
                    <APHealthPanel />
                </div>
                <div
                    className="flex-1 min-h-0 grid grid-cols-[minmax(680px,1.7fr)_minmax(280px,0.75fr)_minmax(260px,0.65fr)] gap-2 p-2 overflow-x-auto"
                    data-testid="purchasing-lifecycle-panel"
                >
            <section className="min-w-0 min-h-0 overflow-hidden border border-zinc-800/70 bg-zinc-950/50" data-testid="lifecycle-pane-ordering">
                <div className="px-3 py-1.5 border-b border-zinc-800/70 text-xs font-mono font-semibold uppercase text-zinc-100">
                    Ordering
                </div>
                <div className="h-[calc(100%-30px)] min-h-0 overflow-hidden">
                    <PurchasingPanel />
                </div>
            </section>
            <section className="min-w-0 min-h-0 overflow-hidden border border-zinc-800/70 bg-zinc-950/50" data-testid="lifecycle-pane-purchases">
                <div className="px-3 py-1.5 border-b border-zinc-800/70 text-xs font-mono font-semibold uppercase text-zinc-100">
                    Purchases
                </div>
                <div className="h-[calc(100%-30px)] min-h-0 overflow-hidden">
                    <ActivePurchasesPanel />
                </div>
            </section>
            <section className="min-w-0 min-h-0 overflow-hidden border border-zinc-800/70 bg-zinc-950/50" data-testid="lifecycle-pane-rcv">
                <div className="px-3 py-1.5 border-b border-zinc-800/70 text-xs font-mono font-semibold uppercase text-zinc-100">
                    RCV
                </div>
                <div className="h-[calc(100%-30px)] min-h-0 overflow-hidden">
                    <ReceivedItemsPanel />
                </div>
            </section>
                </div>
            </div>
        </PurchasingLifecycleProvider>
    );
}

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

    const [activeTab, setActiveTab] = useState<TabId>("lifecycle");
    // Tabs that have been visited stay MOUNTED so switching back is instant.
    // First visit pays the JIT-compile + data-fetch cost once; subsequent
    // switches are pure CSS visibility flips.
    const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(new Set(["lifecycle"]));

    const [refreshing, setRefreshing] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    const aborterRef = useRef<AbortController | null>(null);

    // Restore last tab from localStorage
    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
            const RETIRED = new Set(["ops", "ordering", "purchases", "rcv", "build-schedule", "tasks", "oversight", "blocking"]);
            if (saved && RETIRED.has(saved)) setActiveTab("lifecycle");
            else if (saved) setActiveTab(saved as TabId);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try { window.localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch { /* ignore */ }
        setVisitedTabs(prev => prev.has(activeTab) ? prev : new Set(prev).add(activeTab));
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
            { id: "lifecycle", label: "Lifecycle", render: () => <PurchasingLifecyclePanel /> },
            {
                id: "builds",
                label: "Builds",
                // Schedule + risk consolidated into one stacked view.
                // All-needed components surface in Ordering (lifecycle tab), so
                // this tab is for situational awareness on the build queue.
                render: () => (
                    <div className="flex flex-col h-full min-h-0 overflow-auto gap-2 p-2">
                        <section className="min-h-0 border border-zinc-800/70 bg-zinc-950/40">
                            {panelById("build-schedule")}
                        </section>
                        <section className="min-h-0 border border-zinc-800/70 bg-zinc-950/40">
                            {panelById("build-risk")}
                        </section>
                    </div>
                ),
            },
            { id: "axiom-skus", label: "Axiom SKUs", render: () => <AxiomSkuMappingPanel /> },
            { id: "kanban", label: "Kanban", render: () => <KanbanBoard /> },
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
                    <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">Ops Board</h1>
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
                        className={`px-2.5 py-1 rounded text-xs font-mono uppercase tracking-wider border transition-colors ${
                            activeTab === tab.id
                                ? "bg-blue-500/20 text-blue-100 border-blue-500/40"
                                : "bg-zinc-900 text-zinc-300 border-zinc-800 hover:text-zinc-100 hover:border-zinc-700"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </nav>

            {/* Main: full-canvas tab content. Every visited tab stays
                mounted so switching is instant after first load — only
                the active one is visible (CSS), the rest are hidden but
                still hold their fetched data + compiled JS. */}
            <div className="flex-1 p-2 overflow-hidden">
                <div className="h-full overflow-hidden rounded-md border border-zinc-800/60 bg-zinc-950/40">
                    {tabs.map(tab => {
                        const visited = visitedTabs.has(tab.id);
                        if (!visited) return null;
                        const isActive = tab.id === activeTab;
                        return (
                            <div
                                key={tab.id}
                                className={`h-full overflow-hidden ${isActive ? "block" : "hidden"}`}
                                aria-hidden={!isActive}
                            >
                                {tab.render()}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

export default CommandBoardShell;
