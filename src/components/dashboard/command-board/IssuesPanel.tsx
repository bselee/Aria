/**
 * @file    IssuesPanel.tsx
 * @purpose Single-column "blocking-me-first" issue list — the primary
 *          operational surface on the dashboard. Mirrors the Telegram
 *          /issues command with inline action buttons.
 *
 *          Action POSTs hit /api/command-board/issues/:id/actions which
 *          routes through the linked task when one exists (so the AP
 *          reconciler stays authoritative for ap_pending_approvals).
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, RotateCcw, Eye, RefreshCw, Loader2, Pause, Play, Settings } from "lucide-react";

type IssueRow = {
    id: string;
    title: string;
    lifecycle_state: string;
    autonomy_state: string | null;
    current_handler: string | null;
    blocker_reason: string | null;
    next_action: string | null;
    priority: number;
    owner: string;
    age_seconds: number;
    task_count?: number;
    inputs?: { control?: { mode?: string; paused?: boolean } } & Record<string, unknown>;
};

type ControlAction = "approve" | "reject" | "resolve" | "pause" | "resume" | "run_next_step";

type IssuesResponse = { issues: IssueRow[]; total: number };

function isHumanApproval(i: IssueRow) {
    return i.lifecycle_state === "blocked" && i.blocker_reason === "human_approval_required";
}

function rank(i: IssueRow): number {
    if (isHumanApproval(i)) return 0;
    if (i.lifecycle_state === "blocked") return 1;
    if (i.lifecycle_state === "waiting_external") return 2;
    if (i.lifecycle_state === "working") return 3;
    if (i.lifecycle_state === "triaging") return 4;
    return 5;
}

function ageLabel(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

type ActionState = Record<string, ControlAction | undefined>;

export default function IssuesPanel() {
    const [issues, setIssues] = useState<IssueRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<ActionState>({});
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/command-board/issues?limit=50&bust=" + Date.now());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = (await res.json()) as IssuesResponse;
            setIssues(json.issues ?? []);
            setTotal(json.total ?? 0);
            setError(null);
        } catch (e: any) {
            setError(e?.message ?? "fetch failed");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 30_000);
        return () => clearInterval(t);
    }, [refresh]);

    const sorted = useMemo(
        () => [...issues].sort((a, b) => rank(a) - rank(b)),
        [issues],
    );

    const counts = useMemo(() => {
        const human = issues.filter(isHumanApproval).length;
        const blocked = issues.filter(i => i.lifecycle_state === "blocked").length - human;
        const waiting = issues.filter(i => i.lifecycle_state === "waiting_external").length;
        const inFlight = issues.filter(i =>
            i.lifecycle_state === "working" ||
            i.lifecycle_state === "triaging" ||
            i.lifecycle_state === "detected",
        ).length;
        return { human, blocked, waiting, inFlight };
    }, [issues]);

    const act = async (id: string, action: ControlAction) => {
        setActing(s => ({ ...s, [id]: action }));
        try {
            const res = await fetch(`/api/command-board/issues/${id}/actions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }),
            });
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                throw new Error(j?.error ?? `HTTP ${res.status}`);
            }
            await refresh();
        } catch (e: any) {
            setError(e?.message ?? "action failed");
        } finally {
            setActing(s => {
                const n = { ...s };
                delete n[id];
                return n;
            });
        }
    };

    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
                    Blocking me · Issues ({total})
                </span>
                <div className="flex items-center gap-2 ml-2 text-[10px] font-mono">
                    {counts.human > 0 && (
                        <span className="text-amber-300">👀 {counts.human} need you</span>
                    )}
                    {counts.blocked > 0 && (
                        <span className="text-rose-300">🚫 {counts.blocked} blocked</span>
                    )}
                    {counts.waiting > 0 && (
                        <span className="text-zinc-400">⏳ {counts.waiting} waiting</span>
                    )}
                    {counts.inFlight > 0 && (
                        <span className="text-emerald-300">▶ {counts.inFlight} in flight</span>
                    )}
                </div>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={refresh}
                    disabled={loading}
                    className="text-[10px] font-mono text-zinc-400 hover:text-zinc-200 disabled:opacity-50 inline-flex items-center gap-1"
                >
                    <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                    refresh
                </button>
            </header>

            {error && (
                <div className="px-3 py-1.5 text-[10px] font-mono text-rose-300 bg-rose-500/10 border-b border-rose-500/20">
                    {error}
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {sorted.length === 0 && !loading ? (
                    <div className="text-center text-[11px] font-mono text-zinc-600 py-8">
                        ✓ no open issues
                    </div>
                ) : (
                    sorted.map(i => <IssueRowCard key={i.id} issue={i} acting={acting[i.id]} onAction={act} />)
                )}
            </div>
        </div>
    );
}

function IssueRowCard({
    issue,
    acting,
    onAction,
}: {
    issue: IssueRow;
    acting?: ControlAction;
    onAction: (id: string, action: ControlAction) => void;
}) {
    const human = isHumanApproval(issue);
    const ctrl = issue.inputs?.control;
    const paused = ctrl?.paused === true;
    const tag = human ? "👀"
        : issue.lifecycle_state === "blocked" ? "🚫"
            : issue.lifecycle_state === "waiting_external" ? "⏳"
                : "▶";
    const tagClass = human ? "text-amber-300"
        : issue.lifecycle_state === "blocked" ? "text-rose-300"
            : issue.lifecycle_state === "waiting_external" ? "text-zinc-400"
                : "text-emerald-300";

    return (
        <div
            data-testid={`issue-row-${issue.id}`}
            className="rounded border border-zinc-800/60 bg-zinc-900/40 hover:bg-zinc-900/70 transition-colors"
        >
            <div className="px-3 py-2 flex items-start gap-2">
                <span className={`text-sm shrink-0 ${tagClass}`}>{tag}</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] font-medium text-zinc-100 truncate">{issue.title}</span>
                        <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                            {issue.lifecycle_state}
                        </span>
                        {issue.current_handler && (
                            <span className="text-[9px] font-mono text-zinc-500">· {issue.current_handler}</span>
                        )}
                        {ctrl?.mode && (
                            <span
                                data-testid={`issue-control-mode-${issue.id}`}
                                className="text-[9px] font-mono text-blue-300/80 px-1 rounded bg-blue-500/10 border border-blue-500/20"
                            >
                                {ctrl.mode}
                            </span>
                        )}
                        {paused && (
                            <span
                                data-testid={`issue-paused-${issue.id}`}
                                className="text-[9px] font-mono text-zinc-300 px-1 rounded bg-zinc-700"
                            >
                                ⏸ paused
                            </span>
                        )}
                        {issue.blocker_reason && (
                            <span className="text-[9px] font-mono text-rose-300">🚫 {issue.blocker_reason}</span>
                        )}
                        <span className="text-[9px] font-mono text-zinc-600 ml-auto">{ageLabel(issue.age_seconds)}</span>
                    </div>
                    {issue.next_action && (
                        <div className="mt-1 text-[10px] text-zinc-400">→ {issue.next_action}</div>
                    )}
                </div>
            </div>
            <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
                {human ? (
                    <>
                        <ActionButton
                            label="Approve"
                            color="emerald"
                            icon={CheckCircle2}
                            disabled={!!acting}
                            loading={acting === "approve"}
                            onClick={() => onAction(issue.id, "approve")}
                        />
                        <ActionButton
                            label="Reject"
                            color="rose"
                            icon={XCircle}
                            disabled={!!acting}
                            loading={acting === "reject"}
                            onClick={() => onAction(issue.id, "reject")}
                        />
                    </>
                ) : (
                    <ActionButton
                        label={issue.lifecycle_state === "blocked" ? "Resolve" : "Mark done"}
                        color="emerald"
                        icon={CheckCircle2}
                        disabled={!!acting}
                        loading={acting === "resolve"}
                        onClick={() => onAction(issue.id, "resolve")}
                    />
                )}
                {/* Plan task 7: pause / resume / run-next controls. Compact —
                    only render when applicable. No catalog/tool data fetched
                    in list rows. */}
                {issue.lifecycle_state !== "complete" && (
                    paused ? (
                        <ActionButton
                            label="Resume"
                            color="zinc"
                            icon={Play}
                            disabled={!!acting}
                            loading={acting === "resume"}
                            onClick={() => onAction(issue.id, "resume")}
                            ariaLabel={`Resume issue ${issue.id}`}
                        />
                    ) : (
                        <ActionButton
                            label="Pause"
                            color="zinc"
                            icon={Pause}
                            disabled={!!acting}
                            loading={acting === "pause"}
                            onClick={() => onAction(issue.id, "pause")}
                            ariaLabel={`Pause issue ${issue.id}`}
                        />
                    )
                )}
                {issue.lifecycle_state !== "complete" && (
                    <ActionButton
                        label="Run next"
                        color="zinc"
                        icon={Settings}
                        disabled={!!acting}
                        loading={acting === "run_next_step"}
                        onClick={() => onAction(issue.id, "run_next_step")}
                        ariaLabel={`Run next step for issue ${issue.id}`}
                    />
                )}
                <a
                    href={`/dashboard/tasks?issue=${issue.id}`}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 rounded"
                >
                    <Eye className="w-3 h-3" />
                    detail
                </a>
            </div>
        </div>
    );
}

function ActionButton({
    label,
    color,
    icon: Icon,
    disabled,
    loading,
    onClick,
    ariaLabel,
}: {
    label: string;
    color: "emerald" | "rose" | "zinc";
    icon: typeof CheckCircle2;
    disabled?: boolean;
    loading?: boolean;
    onClick: () => void;
    ariaLabel?: string;
}) {
    const palette =
        color === "emerald" ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
            : color === "rose" ? "bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 border-rose-500/40"
                : "bg-zinc-700/50 hover:bg-zinc-700 text-zinc-200 border-zinc-600";
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel ?? label}
            className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border disabled:opacity-50 ${palette}`}
        >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
            {label}
        </button>
    );
}
