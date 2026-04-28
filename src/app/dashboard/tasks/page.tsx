"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import TaskDetailPanel from "@/components/dashboard/command-board/TaskDetailPanel";
import WorkQueueBoard from "@/components/dashboard/command-board/WorkQueueBoard";
import type { CommandBoardTaskCard } from "@/components/dashboard/command-board/types";

// Repointed to `/api/command-board/tasks` so this page shares the source of
// truth with the Command Board. The legacy `/api/dashboard/tasks` route is
// preserved as a thin compat wrapper for `TasksPanel` and any external
// callers — see `src/app/api/dashboard/tasks/route.ts`.
export default function TasksPage() {
    const [tasks, setTasks] = useState<CommandBoardTaskCard[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    async function fetchTasks(bust = false) {
        try {
            setError(null);
            if (bust) setRefreshing(true);
            const res = await fetch(
                `/api/command-board/tasks${bust ? "?bust=1" : ""}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setTasks(json.tasks ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }

    useEffect(() => {
        fetchTasks();
        const id = setInterval(() => fetchTasks(false), 30_000);
        return () => clearInterval(id);
    }, []);

    return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100">
            <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <Link
                            href="/dashboard"
                            className="inline-flex items-center gap-1 text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            <ArrowLeft className="w-3 h-3" />
                            Dashboard
                        </Link>
                        <h1 className="text-2xl font-semibold text-zinc-100 mt-2">
                            Aria Tasks
                        </h1>
                        <p className="text-xs font-mono text-zinc-500 mt-1">
                            Unified queue across approvals · dropships · exceptions · runbook commands · cron failures
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label="Refresh tasks"
                        onClick={() => fetchTasks(true)}
                        disabled={refreshing}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 border border-zinc-700 text-xs"
                    >
                        <RefreshCw
                            className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
                        />
                        Refresh
                    </button>
                </div>

                {error ? (
                    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs font-mono text-rose-300 mb-4">
                        Failed to load tasks: {error}
                    </div>
                ) : null}

                <div className="grid grid-cols-[1fr_320px] gap-3 h-[70vh]">
                    <div className="overflow-hidden">
                        {loading ? (
                            <div className="text-xs font-mono text-zinc-500">
                                loading…
                            </div>
                        ) : (
                            <WorkQueueBoard
                                tasks={tasks}
                                selectedTaskId={selectedTaskId}
                                onSelectTask={setSelectedTaskId}
                            />
                        )}
                    </div>
                    <div className="overflow-hidden">
                        <TaskDetailPanel
                            selectedTaskId={selectedTaskId}
                            onActionComplete={() => fetchTasks(true)}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
