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
import { PanelErrorBoundary } from "./PanelErrorBoundary";
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

function PurchasingLifecyclePanel() {
    // Flow left → right: Order → Active POs → Receivings.
    // Always three columns (horizontal scroll on narrow screens). Each pane
    // scrolls internally — never stack the whole workflow top-to-bottom.
    return (
        <PurchasingLifecycleProvider>
            <div className="flex flex-col h-full min-h-0 overflow-hidden">
                <div
                    className="flex-1 min-h-0 grid grid-cols-3 gap-2 p-2 overflow-x-auto items-start"
                    data-testid="purchasing-lifecycle-panel"
                >
                    <section
                        className="min-w-0 min-h-0 overflow-hidden bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-ordering"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="PurchasingPanel">
                                <PurchasingPanel embedded />
                            </PanelErrorBoundary>
                        </div>
                    </section>
                    <section
                        className="min-w-0 min-h-0 overflow-hidden bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-purchases"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="ActivePurchasesPanel">
                                <ActivePurchasesPanel embedded />
                            </PanelErrorBoundary>
                        </div>
                    </section>
                    <section
                        className="min-w-0 min-h-0 overflow-hidden bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-rcv"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="ReceivedItemsPanel">
                                <ReceivedItemsPanel embedded />
                            </PanelErrorBoundary>
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

export function CommandBoardShell({ pollIntervalMs = 5 * 60_000, fetchImpl }: CommandBoardShellProps) {
    const fx = fetchImpl ?? fetch;

    const [catalog, setCatalog] = useState<CommandBoardCatalog | null>(null);
    const [summary, setSummary] = useState<CommandBoardSummary | null>(null);
    const [agents, setAgents] = useState<CommandBoardAgent[]>([]);
    const [tasks, setTasks] = useState<CommandBoardTaskCard[]>([]);
    const [heartbeats, setHeartbeats] = useState<CommandBoardHeartbeat[]>([]);
    const [crons, setCrons] = useState<CommandBoardCron[]>([]);

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

    // Lifecycle panel rendered directly — no tabs needed

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
        const agentsUnhealthy = summaryCounts.agents.stale > 0;
        const cronsUnhealthy = summaryCounts.crons.error > 0;

        return (
            <div className="flex flex-col h-screen bg-[#09090b] text-zinc-100" data-testid="command-board-shell">
                {/* Header — only surface chips that need action. Healthy 0/N agents/crons is noise. */}
                <header className="px-4 py-2 border-b border-zinc-800/80 flex items-center gap-3 bg-[#09090b]">
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

            {/* Main: lifecycle panel directly — no tab bar needed */}
            <div className="flex-1 overflow-hidden">
                <PurchasingLifecyclePanel />
            </div>
        </div>
    );
}

export default CommandBoardShell;
