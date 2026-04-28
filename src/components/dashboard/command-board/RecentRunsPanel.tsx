/**
 * @file    RecentRunsPanel.tsx
 * @purpose Unified ledger view: most recent rows from `task_history` and
 *          `cron_runs`, sorted newest-first. Backed by /api/command-board/runs.
 *          Lives in the OpsModuleDock as one of the tabs.
 */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, Clock, ListFilter } from "lucide-react";

import type { CommandBoardRun } from "@/lib/command-board/types";

type SourceFilter = "all" | "task_history" | "cron_runs";

const POLL_INTERVAL_MS = 30_000;
const ROW_LIMIT = 100;

type RecentRunsPanelProps = {
    fetchImpl?: typeof fetch;
};

function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    return `${d}d ago`;
}

function statusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === "success" || s === "succeeded" || s === "approved") {
        return "text-emerald-400";
    }
    if (s === "error" || s === "failed" || s === "rejected" || s === "expired") {
        return "text-rose-400";
    }
    if (s === "running" || s === "claimed" || s === "needs_approval") {
        return "text-amber-400";
    }
    return "text-zinc-400";
}

function summary(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const p = payload as Record<string, unknown>;
    const candidates = [
        p.output_summary,
        p.summary,
        p.message,
        p.error,
        p.goal,
    ];
    const hit = candidates.find(c => typeof c === "string" && c.length > 0);
    return typeof hit === "string" ? hit : "";
}

export function RecentRunsPanel({ fetchImpl }: RecentRunsPanelProps) {
    const fx = fetchImpl ?? fetch;

    const [filter, setFilter] = useState<SourceFilter>("all");
    const [runs, setRuns] = useState<CommandBoardRun[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        async function load(bust = false) {
            setLoading(true);
            setError(null);
            const qs = new URLSearchParams();
            qs.set("limit", String(ROW_LIMIT));
            if (filter !== "all") qs.set("source", filter);
            if (bust) qs.set("bust", "1");
            try {
                const res = await fx(`/api/command-board/runs?${qs.toString()}`, {
                    cache: "no-store",
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json() as { runs?: CommandBoardRun[] };
                if (!cancelled) setRuns(json.runs ?? []);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load(false);
        const id = setInterval(() => load(true), POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [fx, filter]);

    const counts = useMemo(() => {
        const total = runs.length;
        const tasks = runs.filter(r => r.source === "task_history").length;
        const crons = runs.filter(r => r.source === "cron_runs").length;
        return { total, tasks, crons };
    }, [runs]);

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/40">
                <Activity className="w-3.5 h-3.5 text-zinc-400" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Recent Runs
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                    {counts.total}
                </span>
                <div className="flex-1" />
                <ListFilter className="w-3 h-3 text-zinc-600" />
                <div role="tablist" aria-label="Source filter" className="flex gap-1">
                    {(["all", "task_history", "cron_runs"] as const).map(opt => (
                        <button
                            key={opt}
                            type="button"
                            role="tab"
                            aria-selected={filter === opt}
                            onClick={() => setFilter(opt)}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                                filter === opt
                                    ? "bg-zinc-800 text-zinc-100 border-zinc-700"
                                    : "bg-transparent text-zinc-500 border-zinc-800 hover:text-zinc-300"
                            }`}
                        >
                            {opt === "all"
                                ? "all"
                                : opt === "task_history"
                                    ? `tasks (${counts.tasks})`
                                    : `crons (${counts.crons})`}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto">
                {error ? (
                    <div className="px-3 py-2 text-xs text-rose-400 font-mono">
                        {error}
                    </div>
                ) : null}
                {loading && runs.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[10px] font-mono text-zinc-600">
                        loading…
                    </div>
                ) : null}
                {!loading && runs.length === 0 && !error ? (
                    <div className="px-3 py-6 text-center text-[10px] font-mono text-zinc-600">
                        no runs in the window
                    </div>
                ) : null}
                <ul className="divide-y divide-zinc-900/80">
                    {runs.map(run => (
                        <li
                            key={`${run.source}:${run.id}`}
                            data-testid={`run-row-${run.id}`}
                            className="px-3 py-1.5 flex items-center gap-2 hover:bg-zinc-900/40"
                        >
                            <span
                                aria-label={run.source === "cron_runs" ? "cron" : "task"}
                                className={`text-[9px] font-mono uppercase tracking-wider px-1 rounded ${
                                    run.source === "cron_runs"
                                        ? "text-blue-400 bg-blue-500/10"
                                        : "text-zinc-400 bg-zinc-800/60"
                                }`}
                            >
                                {run.source === "cron_runs" ? "cron" : "task"}
                            </span>
                            <span className="text-xs text-zinc-200 truncate max-w-[40%]">
                                {run.name}
                            </span>
                            <span className={`text-[10px] font-mono ${statusClass(run.status)}`}>
                                {run.status}
                            </span>
                            <span className="text-[10px] text-zinc-500 truncate flex-1">
                                {summary(run.payload)}
                            </span>
                            <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500 shrink-0">
                                <Clock className="w-2.5 h-2.5" />
                                {relativeTime(run.created_at)}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

export default RecentRunsPanel;
