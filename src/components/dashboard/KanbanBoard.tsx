/**
 * @file    src/components/dashboard/KanbanBoard.tsx
 * @purpose Visual kanban board component for the Hermes purchasing-lifecycle
 *          board. Shows 4 lanes (Ordering, Purchasing, Tracking, Receiving)
 *          with task cards. Task detail expansion on click.
 * @author  Hermia
 * @created 2026-06-02
 * @deps    Next.js, Tailwind CSS, lucide-react
 * @env     API: /api/dashboard/kanban
 */

"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    Loader2,
    AlertTriangle,
    CheckCircle2,
    Clock,
    Play,
    ChevronDown,
    ChevronRight,
    User,
    RefreshCw,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface KanbanTask {
    id: string;
    title: string;
    status: string;
    priority: number;
    assignee: string;
    lane: string;
    created_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    consecutive_failures: number;
    last_failure_error: string | null;
    result: string | null;
}

interface KanbanResponse {
    lanes: Record<string, KanbanTask[]>;
    tasks: KanbanTask[];
    board: string;
    dbPath: string;
    error?: string;
}

const LANE_LABELS: Record<string, string> = {
    Ordering: "📦 Ordering",
    Purchasing: "💰 Purchasing",
    Tracking: "🚚 Tracking",
    Receiving: "📥 Receiving",
};

const LANE_COLORS: Record<string, string> = {
    Ordering: "border-l-blue-500/60",
    Purchasing: "border-l-amber-500/60",
    Tracking: "border-l-purple-500/60",
    Receiving: "border-l-emerald-500/60",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
    ready: <Play className="w-3 h-3 text-zinc-500" />,
    in_progress: <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />,
    blocked: <AlertTriangle className="w-3 h-3 text-red-400" />,
    completed: <CheckCircle2 className="w-3 h-3 text-emerald-400" />,
    failed: <AlertTriangle className="w-3 h-3 text-red-500" />,
};

// ── Task Card ──────────────────────────────────────────────────────────────

function TaskCard({ task }: { task: KanbanTask }) {
    const [expanded, setExpanded] = useState(false);
    const toggle = useCallback(() => setExpanded((v) => !v), []);

    return (
        <div
            className={`group bg-zinc-900/80 border border-zinc-800/60 rounded-md overflow-hidden
                        hover:border-zinc-700/80 transition-colors cursor-pointer`}
            onClick={toggle}
            key={task.id}
        >
            {/* Header row */}
            <div className="flex items-center gap-2 px-2.5 py-2">
                <span className="flex-shrink-0 mt-0.5">
                    {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                    ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                    )}
                </span>
                {STATUS_ICONS[task.status] ?? (
                    <Clock className="w-3 h-3 text-zinc-600" />
                )}
                <span className="flex-1 text-xs font-medium text-zinc-300 truncate">
                    {task.title}
                </span>
                {task.consecutive_failures > 0 && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-red-950/60 text-red-400 font-mono">
                        {task.consecutive_failures}f
                    </span>
                )}
                <span className="text-[10px] font-mono text-zinc-600">
                    P{task.priority}
                </span>
            </div>

            {/* Expanded detail */}
            {expanded && (
                <div className="px-2.5 pb-2.5 border-t border-zinc-800/40 pt-2 space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <User className="w-3 h-3" />
                        {task.assignee || "unassigned"}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                        ID:{" "}
                        <code className="text-zinc-600 text-[10px]">
                            {task.id}
                        </code>
                    </div>
                    {task.created_at && (
                        <div className="text-[11px] text-zinc-600">
                            Created:{" "}
                            {new Date(Number(task.created_at) * 1000).toLocaleDateString()}
                        </div>
                    )}
                    {task.last_failure_error && (
                        <div className="text-[11px] text-red-400/80 bg-red-950/30 p-1.5 rounded text-[10px] leading-relaxed max-h-20 overflow-y-auto">
                            {task.last_failure_error}
                        </div>
                    )}
                    {task.result && (
                        <div className="text-[11px] text-emerald-400/80 bg-emerald-950/30 p-1.5 rounded text-[10px] leading-relaxed max-h-20 overflow-y-auto">
                            {task.result}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Lane Column ────────────────────────────────────────────────────────────

function LaneColumn({
    lane,
    tasks,
}: {
    lane: string;
    tasks: KanbanTask[];
}) {
    const colorBorder = LANE_COLORS[lane] ?? "border-l-zinc-700/60";
    const label = LANE_LABELS[lane] ?? lane;

    return (
        <div
            className={`flex flex-col min-w-[260px] min-h-0 border border-zinc-800/60 bg-zinc-950/40 rounded-lg
                        ${colorBorder} border-l-2 overflow-hidden`}
            data-testid={`kanban-lane-${lane.toLowerCase()}`}
        >
            {/* Lane header */}
            <div className="px-3 py-2 border-b border-zinc-800/50 bg-zinc-950/80 flex items-center justify-between">
                <span className="text-xs font-mono font-semibold uppercase tracking-wide text-zinc-300">
                    {label}
                </span>
                <span className="text-[10px] font-mono text-zinc-600 bg-zinc-900 px-1.5 py-0.5 rounded">
                    {tasks.length}
                </span>
            </div>

            {/* Lane body */}
            <div className="flex-1 min-h-[300px] overflow-y-auto p-2 space-y-1.5">
                {tasks.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <span className="text-xs text-zinc-700 italic">
                            No tasks
                        </span>
                    </div>
                ) : (
                    tasks.map((task) => <TaskCard key={task.id} task={task} />)
                )}
            </div>
        </div>
    );
}

// ── Main Board ─────────────────────────────────────────────────────────────

export default function KanbanBoard() {
    const [data, setData] = useState<KanbanResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchKanban = useCallback(async (showSpinner = false) => {
        if (showSpinner) setLoading(true);
        try {
            const res = await fetch("/api/dashboard/kanban");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: KanbanResponse = await res.json();
            if (json.error) throw new Error(json.error);
            setData(json);
            setError(null);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchKanban(false);
    }, [fetchKanban]);

    // Auto-refresh every 30s
    useEffect(() => {
        const interval = setInterval(() => fetchKanban(false), 30_000);
        return () => clearInterval(interval);
    }, [fetchKanban]);

    // ── Loading state ──
    if (loading && !data) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
                <span className="ml-3 text-sm text-zinc-600">
                    Loading kanban…
                </span>
            </div>
        );
    }

    // ── Error state ──
    if (error || data?.error) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-2">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <span className="text-sm text-red-400">
                    {error || data?.error}
                </span>
                <button
                    className="text-xs text-zinc-500 hover:text-zinc-300 mt-2 underline transition-colors cursor-pointer"
                    onClick={() => fetchKanban(true)}
                >
                    Retry
                </button>
            </div>
        );
    }

    const lanes = data?.lanes ?? {};

    return (
        <div className="flex flex-col h-full min-h-0" data-testid="kanban-board">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 bg-zinc-950/80 flex-shrink-0">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold uppercase tracking-wide text-zinc-200">
                        🗂 Hermes Kanban
                    </span>
                    <span className="text-[10px] text-zinc-600">
                        {data?.board ?? "purchasing-lifecycle"}
                    </span>
                </div>
                <button
                    className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                    onClick={() => fetchKanban(true)}
                    title="Refresh kanban"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                </button>
            </div>

            {/* Lane grid */}
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-2">
                <div className="grid grid-cols-4 gap-2 h-full min-w-[1100px]">
                    {Object.entries(lanes).map(([lane, tasks]) => (
                        <LaneColumn
                            key={lane}
                            lane={lane}
                            tasks={tasks as KanbanTask[]}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
