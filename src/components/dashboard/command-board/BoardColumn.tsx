/**
 * @file    BoardColumn.tsx
 * @purpose A single lane on the WorkQueueBoard. Renders a stack of task
 *          cards for one lane, with a sticky header showing the lane label
 *          and count.
 */
"use client";

import React from "react";
import type { LucideIcon } from "lucide-react";

import type { CommandBoardTaskCard } from "./types";

type BoardColumnProps = {
    laneId: string;
    label: string;
    icon: LucideIcon;
    accent: string; // tailwind text colour, e.g. "text-amber-400"
    tasks: CommandBoardTaskCard[];
    selectedTaskId: string | null;
    onSelect: (taskId: string) => void;
};

function ageLabel(seconds: number): string {
    if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}

function priorityClasses(priority: string | null): string {
    if (!priority) return "text-zinc-500 border-zinc-700/40";
    if (priority === "P0") return "text-rose-300 border-rose-500/40 bg-rose-500/10";
    if (priority === "P1") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
    if (priority === "P2") return "text-zinc-300 border-zinc-700/50";
    return "text-zinc-500 border-zinc-800/50";
}

function TaskCard({
    task,
    selected,
    onSelect,
}: {
    task: CommandBoardTaskCard;
    selected: boolean;
    onSelect: (id: string) => void;
}) {
    const autoHandledBy = task.auto_handled_by;
    const dedup = task.dedup_count ?? 0;

    return (
        <button
            type="button"
            onClick={() => onSelect(task.id)}
            data-testid={`task-card-${task.id}`}
            className={`group w-full text-left px-3 py-2 rounded-md border transition-colors ${
                selected
                    ? "border-blue-500/60 bg-blue-500/10"
                    : "border-zinc-800/70 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900"
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="text-[13px] text-zinc-100 leading-snug truncate flex-1 min-w-0">
                    {task.title}
                </div>
                {task.priority ? (
                    <span
                        className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase ${priorityClasses(
                            task.priority,
                        )}`}
                    >
                        {task.priority}
                    </span>
                ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-mono text-zinc-500">
                {task.owner ? (
                    <span>
                        owner: <span className="text-zinc-400">{task.owner}</span>
                    </span>
                ) : null}
                {task.source_table ? (
                    <span>
                        src: <span className="text-zinc-400">{task.source_table}</span>
                    </span>
                ) : null}
                <span>{ageLabel(task.age_seconds)}</span>
                {task.parent_task_id ? (
                    <span className="text-violet-400">child</span>
                ) : null}
                {task.has_children ? (
                    <span className="text-violet-400">parent</span>
                ) : null}
                {dedup > 1 ? (
                    <span className="px-1 rounded bg-zinc-800 text-zinc-300">
                        ×{dedup}
                    </span>
                ) : null}
                {typeof autoHandledBy === "string" && autoHandledBy.length > 0 ? (
                    <span className="px-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        auto: {autoHandledBy}
                    </span>
                ) : null}
            </div>
        </button>
    );
}

export function BoardColumn({
    laneId,
    label,
    icon: Icon,
    accent,
    tasks,
    selectedTaskId,
    onSelect,
}: BoardColumnProps) {
    return (
        <div
            data-testid={`lane-${laneId}`}
            className="flex flex-col min-w-[240px] flex-1 bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden"
        >
            <div className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur">
                <div className="flex items-center gap-2">
                    <Icon className={`w-3.5 h-3.5 ${accent}`} />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                        {label}
                    </span>
                </div>
                <span className="text-[10px] font-mono text-zinc-500">
                    {tasks.length}
                </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {tasks.length === 0 ? (
                    <div className="text-center text-[10px] font-mono text-zinc-600 py-6">
                        empty
                    </div>
                ) : (
                    tasks.map(t => (
                        <TaskCard
                            key={t.id}
                            task={t}
                            selected={selectedTaskId === t.id}
                            onSelect={onSelect}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

export default BoardColumn;
