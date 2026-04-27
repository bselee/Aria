"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    Filter,
    Inbox,
    RefreshCw,
    UserCheck,
    XCircle,
    Zap,
} from "lucide-react";
import type { AgentTask } from "@/lib/intelligence/agent-task";

type TasksResponse = {
    tasks: AgentTask[];
    counts: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        byOwner: Record<string, number>;
    };
    cachedAt: string;
};

const STATUS_CONFIG: Record<
    string,
    { color: string; bg: string; dot: string; label: string }
> = {
    PENDING:        { color: "text-sky-400",     bg: "bg-sky-500/10 border-sky-500/20",         dot: "bg-sky-500",     label: "Pending" },
    CLAIMED:        { color: "text-indigo-400",  bg: "bg-indigo-500/10 border-indigo-500/20",   dot: "bg-indigo-500",  label: "Claimed" },
    RUNNING:        { color: "text-cyan-400",    bg: "bg-cyan-500/10 border-cyan-500/20",       dot: "bg-cyan-500",    label: "Running" },
    NEEDS_APPROVAL: { color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/20",     dot: "bg-amber-400",   label: "Needs Approval" },
    APPROVED:       { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-500", label: "Approved" },
    REJECTED:       { color: "text-rose-400",    bg: "bg-rose-500/10 border-rose-500/20",       dot: "bg-rose-500",    label: "Rejected" },
    SUCCEEDED:      { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-500", label: "Succeeded" },
    FAILED:         { color: "text-rose-400",    bg: "bg-rose-500/20 border-rose-500/40",       dot: "bg-rose-500",    label: "Failed" },
    EXPIRED:        { color: "text-zinc-500",    bg: "bg-zinc-700/30 border-zinc-700/50",       dot: "bg-zinc-500",    label: "Expired" },
    CANCELLED:      { color: "text-zinc-500",    bg: "bg-zinc-700/30 border-zinc-700/50",       dot: "bg-zinc-500",    label: "Cancelled" },
};

const TYPE_LABEL: Record<string, string> = {
    cron_failure:     "Cron failure",
    approval:         "Approval",
    dropship_forward: "Dropship",
    po_send_confirm:  "PO confirm",
    agent_exception:  "Exception",
    control_command:  "Runbook",
    manual:           "Manual",
    code_change:      "Code change",
};

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
    cron_failure:     XCircle,
    approval:         UserCheck,
    dropship_forward: Inbox,
    po_send_confirm:  CheckCircle2,
    agent_exception:  AlertTriangle,
    control_command:  Zap,
    manual:           Clock,
    code_change:      Zap,
};

const PRIORITY_LABEL = ["P0", "P1", "P2", "P3", "P4"];
const PRIORITY_COLOR = [
    "text-rose-300 bg-rose-500/20 border-rose-500/40",   // P0
    "text-amber-300 bg-amber-500/20 border-amber-500/40", // P1
    "text-zinc-400 bg-zinc-700/30 border-zinc-700/50",    // P2
    "text-zinc-500 bg-zinc-800/30 border-zinc-700/30",    // P3
    "text-zinc-600 bg-zinc-800/20 border-zinc-800/30",    // P4
];

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
    const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
    return (
        <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider ${cfg.bg} ${cfg.color}`}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label}
        </span>
    );
}

function PriorityBadge({ priority }: { priority: number }) {
    const idx = Math.max(0, Math.min(4, priority));
    return (
        <span
            className={`px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider ${PRIORITY_COLOR[idx]}`}
        >
            {PRIORITY_LABEL[idx]}
        </span>
    );
}

function TypeChip({ type }: { type: string }) {
    const Icon = TYPE_ICON[type] ?? Clock;
    return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/40 border border-zinc-700/50 text-[10px] font-mono text-zinc-400">
            <Icon className="w-3 h-3" />
            {TYPE_LABEL[type] ?? type}
        </span>
    );
}

function TaskRow({ task }: { task: AgentTask }) {
    return (
        <div className="px-4 py-3 border-b border-zinc-800/60 hover:bg-zinc-900/40 transition-colors">
            <div className="flex items-start gap-3">
                <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
                    <PriorityBadge priority={task.priority} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <TypeChip type={task.type} />
                        <StatusBadge status={task.status} />
                        {task.requires_approval && task.status === "NEEDS_APPROVAL" && (
                            <span className="text-[10px] font-mono text-amber-400 uppercase tracking-wider">
                                ⚠ awaiting {task.owner}
                            </span>
                        )}
                    </div>
                    <div className="text-sm text-zinc-200 truncate" title={task.goal}>
                        {task.goal}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-zinc-600">
                        <span>{timeAgo(task.created_at)}</span>
                        {task.source_table && (
                            <span>
                                src: <span className="text-zinc-500">{task.source_table}</span>
                            </span>
                        )}
                        {task.retry_count > 0 && (
                            <span className="text-amber-400">↻ {task.retry_count}</span>
                        )}
                        <span>
                            owner: <span className="text-zinc-500">{task.owner}</span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CountChip({ label, value, accent }: { label: string; value: number; accent?: string }) {
    return (
        <div className="px-3 py-2 rounded-lg bg-zinc-900/60 border border-zinc-800/60 min-w-[88px]">
            <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                {label}
            </div>
            <div
                className={`text-lg font-semibold ${accent ?? "text-zinc-200"}`}
            >
                {value}
            </div>
        </div>
    );
}

function Skeleton() {
    return (
        <div className="space-y-3 p-4">
            {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="skeleton-shimmer h-16 rounded-lg" />
            ))}
        </div>
    );
}

export function TasksPanel() {
    const [data, setData] = useState<TasksResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [typeFilter, setTypeFilter] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const fetchData = async (bust = false) => {
        try {
            setError(null);
            if (bust) setRefreshing(true);
            const res = await fetch(`/api/dashboard/tasks${bust ? "?bust=1" : ""}`, {
                cache: "no-store",
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const json = (await res.json()) as TasksResponse;
            setData(json);
        } catch (err: any) {
            setError(err.message ?? String(err));
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(() => fetchData(), 30000);
        return () => clearInterval(interval);
    }, []);

    const filteredTasks = useMemo(() => {
        if (!data) return [];
        if (!typeFilter) return data.tasks;
        return data.tasks.filter(t => t.type === typeFilter);
    }, [data, typeFilter]);

    if (loading && !data) {
        return <Skeleton />;
    }

    if (error && !data) {
        return (
            <div className="p-4 text-rose-400 text-sm font-mono">
                Failed to load tasks: {error}
                <button
                    onClick={() => fetchData(true)}
                    className="ml-3 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-xs"
                >
                    Retry
                </button>
            </div>
        );
    }

    const counts = data?.counts;
    const needsApproval = counts?.byStatus?.NEEDS_APPROVAL ?? 0;
    const failed = counts?.byStatus?.FAILED ?? 0;
    const pending = counts?.byStatus?.PENDING ?? 0;
    const running = counts?.byStatus?.RUNNING ?? 0;

    const types = Object.keys(counts?.byType ?? {}).sort();

    return (
        <div className="flex flex-col h-full">
            <div className="px-4 py-3 border-b border-zinc-800/60 bg-zinc-900/50">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                            Tasks
                        </h2>
                        <span className="text-[10px] font-mono text-zinc-600">
                            {data?.tasks.length ?? 0} open
                            {data?.cachedAt && ` · ${timeAgo(data.cachedAt)}`}
                        </span>
                    </div>
                    <button
                        onClick={() => fetchData(true)}
                        disabled={refreshing}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 border border-zinc-700 text-xs"
                    >
                        <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                        Refresh
                    </button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <CountChip
                        label="Needs approval"
                        value={needsApproval}
                        accent={needsApproval > 0 ? "text-amber-400" : undefined}
                    />
                    <CountChip
                        label="Failed (24h)"
                        value={failed}
                        accent={failed > 0 ? "text-rose-400" : undefined}
                    />
                    <CountChip label="Pending" value={pending} />
                    <CountChip label="Running" value={running} accent="text-cyan-400" />
                </div>

                {types.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                        <Filter className="w-3 h-3 text-zinc-500" />
                        <button
                            onClick={() => setTypeFilter(null)}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                                typeFilter === null
                                    ? "bg-zinc-700 text-zinc-200 border-zinc-600"
                                    : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:border-zinc-700"
                            }`}
                        >
                            All
                        </button>
                        {types.map(t => (
                            <button
                                key={t}
                                onClick={() => setTypeFilter(t)}
                                className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                                    typeFilter === t
                                        ? "bg-zinc-700 text-zinc-200 border-zinc-600"
                                        : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:border-zinc-700"
                                }`}
                            >
                                {(TYPE_LABEL[t] ?? t)} ({counts?.byType?.[t] ?? 0})
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-y-auto">
                {filteredTasks.length === 0 ? (
                    <div className="p-8 text-center text-xs font-mono text-zinc-600">
                        Nothing waiting. ✨
                    </div>
                ) : (
                    filteredTasks.map(task => <TaskRow key={task.id} task={task} />)
                )}
            </div>
        </div>
    );
}

export default TasksPanel;
