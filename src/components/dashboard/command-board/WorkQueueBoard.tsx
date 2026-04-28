/**
 * @file    WorkQueueBoard.tsx
 * @purpose Center panel of the command board. Splits tasks from
 *          `/api/command-board/tasks` into 5 lanes and renders them as
 *          BoardColumns. Click a card → bubbles up via `onSelectTask`.
 */
"use client";

import React, { useMemo } from "react";
import {
    AlertOctagon,
    Bot,
    CheckCircle2,
    PlayCircle,
    UserCheck,
} from "lucide-react";

import BoardColumn from "./BoardColumn";
import type { CommandBoardLane, CommandBoardTaskCard } from "./types";

type WorkQueueBoardProps = {
    tasks: CommandBoardTaskCard[];
    selectedTaskId: string | null;
    onSelectTask: (taskId: string) => void;
};

const LANES: Array<{
    id: CommandBoardLane;
    label: string;
    icon: typeof UserCheck;
    accent: string;
}> = [
    { id: "needs-will", label: "Needs Will", icon: UserCheck, accent: "text-amber-400" },
    { id: "running", label: "Running", icon: PlayCircle, accent: "text-cyan-400" },
    { id: "blocked-failed", label: "Blocked / Failed", icon: AlertOctagon, accent: "text-rose-400" },
    { id: "autonomous", label: "Autonomous", icon: Bot, accent: "text-violet-400" },
    { id: "recently-closed", label: "Recently Closed", icon: CheckCircle2, accent: "text-emerald-400" },
];

export function WorkQueueBoard({
    tasks,
    selectedTaskId,
    onSelectTask,
}: WorkQueueBoardProps) {
    const byLane = useMemo(() => {
        const map: Record<CommandBoardLane, CommandBoardTaskCard[]> = {
            "needs-will": [],
            running: [],
            "blocked-failed": [],
            autonomous: [],
            "recently-closed": [],
        };
        for (const t of tasks) {
            const lane: CommandBoardLane = (t.lane ?? "running") as CommandBoardLane;
            if (map[lane]) map[lane].push(t);
            else map.running.push(t);
        }
        return map;
    }, [tasks]);

    return (
        <div className="flex gap-2 h-full overflow-x-auto pb-2">
            {LANES.map(l => (
                <BoardColumn
                    key={l.id}
                    laneId={l.id}
                    label={l.label}
                    icon={l.icon}
                    accent={l.accent}
                    tasks={byLane[l.id] ?? []}
                    selectedTaskId={selectedTaskId}
                    onSelect={onSelectTask}
                />
            ))}
        </div>
    );
}

export default WorkQueueBoard;
