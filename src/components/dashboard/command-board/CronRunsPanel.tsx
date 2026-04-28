/**
 * @file    CronRunsPanel.tsx
 * @purpose Cron schedule + recent runs strip. Reads from
 *          `/api/command-board/crons`. No realtime — uses parent shell's
 *          poll cycle.
 */
"use client";

import React from "react";
import { CheckCircle2, Clock, XCircle } from "lucide-react";

import type { CommandBoardCron } from "./types";

type CronRunsPanelProps = {
    crons: CommandBoardCron[];
};

function timeAgo(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "—";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
}

function statusIcon(status: CommandBoardCron["lastStatus"]) {
    if (status === "success")
        return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
    if (status === "error")
        return <XCircle className="w-3 h-3 text-rose-400" />;
    return <Clock className="w-3 h-3 text-zinc-500" />;
}

export function CronRunsPanel({ crons }: CronRunsPanelProps) {
    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Crons
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                    {crons.length}
                </span>
            </header>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {crons.length === 0 ? (
                    <div className="text-center text-[10px] font-mono text-zinc-600 py-6">
                        no crons
                    </div>
                ) : (
                    crons.map(c => (
                        <div
                            key={c.name}
                            className="px-2 py-1.5 rounded border border-zinc-800/40 bg-zinc-900/40 text-[11px]"
                            title={c.description}
                        >
                            <div className="flex items-center gap-2">
                                {statusIcon(c.lastStatus)}
                                <span className="text-zinc-200 flex-1 truncate">
                                    {c.name}
                                </span>
                                <span className="text-[10px] font-mono text-zinc-500">
                                    {timeAgo(c.lastRunAt)}
                                </span>
                            </div>
                            <div className="mt-0.5 text-[10px] font-mono text-zinc-500 truncate">
                                {c.scheduleHuman}
                                {c.lastDurationMs != null
                                    ? ` · ${c.lastDurationMs}ms`
                                    : ""}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

export default CronRunsPanel;
