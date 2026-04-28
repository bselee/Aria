/**
 * @file    TaskDetailPanel.tsx
 * @purpose Right rail of the command board. Loads detail for the
 *          currently-selected task from `/api/command-board/tasks/:id`,
 *          surfaces events from the task_history ledger, and renders the
 *          status-appropriate set of action buttons (approve / reject /
 *          dismiss / claim / retry / cancel).
 *
 *          Action buttons POST to `/api/command-board/tasks/:id/actions`
 *          with `{ action: '...' }`. The bot-safety agent owns that route.
 */
"use client";

import React, { useEffect, useState } from "react";
import {
    Check,
    CheckCircle2,
    ExternalLink,
    Hash,
    History,
    Hourglass,
    Loader2,
    Repeat,
    StopCircle,
    User,
    UserCheck,
    X,
    XCircle,
} from "lucide-react";

import type { CommandBoardTaskDetail, CommandBoardTaskEvent } from "./types";

type ActionKind = "approve" | "reject" | "dismiss" | "claim" | "retry" | "cancel";

type TaskDetailPanelProps = {
    selectedTaskId: string | null;
    /**
     * Optional override for tests — defaults to global `fetch`. Lets us inject
     * a mock without polluting other components.
     */
    fetchImpl?: typeof fetch;
    /** Notification when an action succeeds, so parent can refresh. */
    onActionComplete?: (taskId: string, action: ActionKind) => void;
};

function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "—";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

function statusActions(status: string): ActionKind[] {
    switch (status) {
        case "NEEDS_APPROVAL":
            return ["approve", "reject"];
        case "PENDING":
            return ["claim", "dismiss"];
        case "FAILED":
            return ["retry", "dismiss"];
        case "CLAIMED":
        case "RUNNING":
            return ["cancel"];
        default:
            return ["dismiss"];
    }
}

const ACTION_LABELS: Record<ActionKind, string> = {
    approve: "Approve",
    reject: "Reject",
    dismiss: "Dismiss",
    claim: "Claim",
    retry: "Retry",
    cancel: "Cancel",
};

const ACTION_ICONS: Record<ActionKind, typeof Check> = {
    approve: Check,
    reject: X,
    dismiss: X,
    claim: UserCheck,
    retry: Repeat,
    cancel: StopCircle,
};

const ACTION_CLASSES: Record<ActionKind, string> = {
    approve: "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border-emerald-500/40",
    reject: "bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border-rose-500/40",
    dismiss: "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700",
    claim: "bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 border-blue-500/40",
    retry: "bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/40",
    cancel: "bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 border-rose-500/30",
};

function PlaybookStatusLine({
    kind,
    state,
}: {
    kind: string;
    state: string | null | undefined;
}) {
    const Icon =
        state === "running" ? Loader2 :
        state === "queued" ? Hourglass :
        state === "succeeded" ? CheckCircle2 :
        state === "failed" ? XCircle :
        state === "manual_only" ? User :
        Hourglass;
    const stateColor =
        state === "running" ? "text-blue-300" :
        state === "succeeded" ? "text-emerald-300" :
        state === "failed" ? "text-rose-300" :
        state === "manual_only" ? "text-amber-300" :
        "text-zinc-400";
    const iconColor =
        state === "running" ? "text-blue-400 animate-spin" :
        state === "succeeded" ? "text-emerald-400" :
        state === "failed" ? "text-rose-400" :
        state === "manual_only" ? "text-amber-400" :
        "text-zinc-500";
    return (
        <div
            data-testid="playbook-status"
            className="flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono bg-zinc-900/60 border border-zinc-800/60"
            aria-label={`Playbook ${kind} state ${state ?? "unknown"}`}
        >
            <Icon className={`w-3 h-3 ${iconColor}`} />
            <span className="text-zinc-300">{kind}</span>
            <span className="text-zinc-600">·</span>
            <span className={stateColor}>{state ?? "unknown"}</span>
        </div>
    );
}

function EventRow({ event }: { event: CommandBoardTaskEvent }) {
    return (
        <div className="px-2 py-1.5 border-l-2 border-zinc-800/80 text-[11px]">
            <div className="flex items-center gap-2 text-zinc-300">
                <span className="font-mono uppercase text-[10px] text-zinc-500">
                    {event.event_type}
                </span>
                <span className="text-zinc-600">{timeAgo(event.created_at)}</span>
            </div>
            {event.payload && Object.keys(event.payload).length > 0 ? (
                <pre className="mt-0.5 text-[10px] font-mono text-zinc-500 truncate">
                    {JSON.stringify(event.payload).slice(0, 140)}
                </pre>
            ) : null}
        </div>
    );
}

export function TaskDetailPanel({
    selectedTaskId,
    fetchImpl,
    onActionComplete,
}: TaskDetailPanelProps) {
    const [detail, setDetail] = useState<CommandBoardTaskDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionPending, setActionPending] = useState<ActionKind | null>(null);

    const fx = fetchImpl ?? fetch;

    useEffect(() => {
        if (!selectedTaskId) {
            setDetail(null);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        fx(`/api/command-board/tasks/${selectedTaskId}`, { cache: "no-store" })
            .then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(json => {
                if (cancelled) return;
                setDetail(json as CommandBoardTaskDetail);
            })
            .catch(err => {
                if (cancelled) return;
                setError(err?.message ?? String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedTaskId, fx]);

    async function runAction(action: ActionKind) {
        if (!selectedTaskId || actionPending) return;
        setActionPending(action);
        try {
            const res = await fx(
                `/api/command-board/tasks/${selectedTaskId}/actions`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action }),
                },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            // Optimistic update: project the action onto the local detail so
            // the action buttons disappear immediately. The full refetch a few
            // lines down replaces this with the authoritative server state.
            setDetail(prev => {
                if (!prev) return prev;
                if (action === "approve") return { ...prev, status: "APPROVED" };
                if (action === "reject") return { ...prev, status: "REJECTED" };
                if (action === "dismiss") return { ...prev, status: "SUCCEEDED", completed_at: new Date().toISOString() };
                return prev;
            });

            onActionComplete?.(selectedTaskId, action);

            // Refetch the detail itself — onActionComplete only refreshes the
            // shell's lanes. Without this the panel keeps the stale detail.
            try {
                const detailRes = await fx(
                    `/api/command-board/tasks/${selectedTaskId}?bust=1`,
                    { cache: "no-store" },
                );
                if (detailRes.ok) {
                    setDetail(await detailRes.json() as CommandBoardTaskDetail);
                }
            } catch {
                /* keep the optimistic projection if refetch fails */
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setActionPending(null);
        }
    }

    if (!selectedTaskId) {
        return (
            <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md">
                <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                        Task Detail
                    </span>
                </header>
                <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-zinc-600">
                    select a task
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Task Detail
                </span>
                {detail ? (
                    <span className="text-[10px] font-mono text-zinc-500 truncate">
                        {detail.status}
                    </span>
                ) : null}
            </header>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {loading ? (
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        loading…
                    </div>
                ) : error ? (
                    <div className="text-[11px] font-mono text-rose-400">
                        Failed: {error}
                    </div>
                ) : !detail ? (
                    <div className="text-[11px] font-mono text-zinc-500">
                        no detail
                    </div>
                ) : (
                    <>
                        <div>
                            <div className="text-sm text-zinc-100 leading-snug">
                                {detail.title}
                            </div>
                            <div className="mt-1 text-[10px] font-mono text-zinc-500 flex flex-wrap gap-x-2 gap-y-1">
                                {detail.owner ? <span>owner: {detail.owner}</span> : null}
                                {detail.priority ? <span>{detail.priority}</span> : null}
                                {detail.dedup_count > 1 ? (
                                    <span className="px-1 rounded bg-zinc-800 text-zinc-300">
                                        ×{detail.dedup_count}
                                    </span>
                                ) : null}
                                {detail.input_hash ? (
                                    <span
                                        className="flex items-center gap-1"
                                        title={detail.input_hash}
                                    >
                                        <Hash className="w-3 h-3" />
                                        {detail.input_hash.slice(0, 8)}
                                    </span>
                                ) : null}
                            </div>
                        </div>

                        {detail.body ? (
                            <details className="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
                                <summary className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 cursor-pointer">
                                    Body
                                </summary>
                                <pre className="mt-1 text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-words">
                                    {typeof detail.body === "string"
                                        ? detail.body
                                        : JSON.stringify(detail.body, null, 2)}
                                </pre>
                            </details>
                        ) : null}

                        {detail.closes_when ? (
                            <div className="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-[10px] font-mono text-zinc-400">
                                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
                                    Closes when
                                </div>
                                <div className="break-words">
                                    {typeof detail.closes_when === "string"
                                        ? detail.closes_when
                                        : JSON.stringify(detail.closes_when)}
                                </div>
                            </div>
                        ) : null}

                        {detail.playbook_kind ? (
                            <PlaybookStatusLine
                                kind={detail.playbook_kind}
                                state={detail.playbook_state}
                            />
                        ) : null}

                        {detail.source_table && detail.source_id ? (
                            <div className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
                                <ExternalLink className="w-3 h-3" />
                                source: {detail.source_table}/{detail.source_id}
                            </div>
                        ) : null}

                        <div>
                            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">
                                <History className="w-3 h-3" />
                                Events
                                <span className="text-zinc-600">
                                    ({detail.events?.length ?? 0})
                                </span>
                            </div>
                            <div className="space-y-1">
                                {(detail.events ?? []).slice(0, 50).map((e, idx) => (
                                    <EventRow key={idx} event={e} />
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>

            {detail ? (
                <footer className="border-t border-zinc-800/60 bg-zinc-900/60 px-2 py-2 flex flex-wrap gap-1.5">
                    {statusActions(detail.status).map(action => {
                        const Icon = ACTION_ICONS[action];
                        const pending = actionPending === action;
                        return (
                            <button
                                key={action}
                                type="button"
                                aria-label={`${ACTION_LABELS[action]} task`}
                                onClick={() => runAction(action)}
                                disabled={actionPending !== null}
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono ${
                                    ACTION_CLASSES[action]
                                } disabled:opacity-50`}
                            >
                                {pending ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                    <Icon className="w-3 h-3" />
                                )}
                                {ACTION_LABELS[action]}
                            </button>
                        );
                    })}
                </footer>
            ) : null}
        </div>
    );
}

export default TaskDetailPanel;
