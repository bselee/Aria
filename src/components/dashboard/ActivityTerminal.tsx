"use client";

/**
 * @file    ActivityTerminal.tsx
 * @purpose Terminal-style activity feed merging AP activity and cron runs.
 *
 * Click a row to expand metadata. Attention rows also show the next human
 * action and, when possible, a direct link to the relevant surface.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
    getActivityIntentLabel,
    getActivityLink,
    getAttentionRank,
    getCorrelationExplanation,
    getDefaultProcessState,
    getNextHumanAction,
    getTeachPayload,
    type ActivityLog,
    type CronRun,
    type ProcessState,
    type StreamRow,
} from "./activityWorkflow";

function fmt(ts: string): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(0, 19);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return sameDay ? time : `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`;
}

const INTENT_TONE: Record<string, string> = {
    INVOICE: "text-cyan-300",
    PROCESSING_ERROR: "text-rose-300",
    RECONCILIATION: "text-emerald-300",
    PO_SEND_FINALE: "text-emerald-300",
    PO_COMMIT: "text-emerald-300",
    DROPSHIP: "text-purple-300",
    BILL_FORWARDED: "text-cyan-300",
    BILL_FORWARD: "text-cyan-300",
    BILL_FORWARD_FAILED: "text-rose-400",
    AP_ACTION: "text-zinc-300",
    EYES_NEEDED: "text-amber-300",
    HUMAN_INTERACTION: "text-amber-300",
    HUMAN_INTERACT: "text-amber-300",
    PREPAYMENT: "text-amber-300",
};

const cronTone = (status: string | null) =>
    status === "success" ? "text-emerald-300"
        : status === "failed" || status === "error" ? "text-rose-300"
            : status === "running" ? "text-amber-300"
                : "text-zinc-400";

function intentIcon(intent: string): string {
    const i = getActivityIntentLabel(intent);
    if (i.includes("ERROR") || i.includes("FAIL")) return "x";
    if (i === "EYES_NEEDED") return "!";
    if (i.includes("RECONCIL")) return "~";
    if (i.includes("SEND") || i.includes("COMMIT")) return ">";
    if (i.includes("FORWARD")) return ">";
    if (i.includes("DROPSHIP")) return "d";
    if (i.includes("INVOICE")) return "$";
    return ".";
}

export default function ActivityTerminal() {
    const [stream, setStream] = useState<StreamRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
    const [filter, setFilter] = useState<"all" | "ap" | "cron" | "errors">("all");

    const fetchAll = useCallback(async (silent = false) => {
        silent ? setRefreshing(true) : setLoading(true);
        try {
            const supabase = createBrowserClient();
            const [apRes, cronRes] = await Promise.all([
                supabase
                    .from("ap_activity_log")
                    .select("id, created_at, email_from, email_subject, intent, action_taken, metadata, reviewed_at, reviewed_action, human_note, human_note_by, human_note_at, process_state, resolution, learning_candidate")
                    .order("created_at", { ascending: false })
                    .limit(150),
                supabase
                    .from("cron_runs")
                    .select("id, job_name, started_at, finished_at, status, failure_reason")
                    .order("started_at", { ascending: false })
                    .limit(100),
            ]);
            const ap = (apRes.data ?? []).map(r => ({ kind: "ap" as const, row: r as ActivityLog }));
            const cron = (cronRes.data ?? []).map(r => ({ kind: "cron" as const, row: r as CronRun }));
            const merged = [...ap, ...cron].sort((a, b) => {
                const at = a.kind === "ap" ? a.row.created_at : a.row.started_at;
                const bt = b.kind === "ap" ? b.row.created_at : b.row.started_at;
                return bt.localeCompare(at);
            });
            setStream(merged.slice(0, 200));
        } catch (err) {
            console.warn("[ActivityTerminal] fetch failed:", err);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchAll();
        const t = setInterval(() => fetchAll(true), 30_000);
        return () => clearInterval(t);
    }, [fetchAll]);

    const visible = useMemo(() => {
        if (filter === "all") return stream;
        if (filter === "ap") return stream.filter(s => s.kind === "ap");
        if (filter === "cron") return stream.filter(s => s.kind === "cron");
        if (filter === "errors") {
            return stream.filter(s =>
                s.kind === "cron"
                    ? (s.row.status === "failed" || s.row.status === "error")
                    : getActivityIntentLabel(s.row.intent).includes("ERROR")
                    || getActivityIntentLabel(s.row.intent).includes("FAIL")
                    || getAttentionRank(s) !== null,
            );
        }
        return stream;
    }, [stream, filter]);

    function toggleExpand(key: string) {
        setExpanded(p => {
            const n = new Set(p);
            n.has(key) ? n.delete(key) : n.add(key);
            return n;
        });
    }

    async function saveWorkflowPatch(logId: string, patch: Record<string, unknown>) {
        const res = await fetch(`/api/dashboard/activity/${logId}/workflow`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Workflow update failed");

        setStream(current => current.map(item => {
            if (item.kind !== "ap" || item.row.id !== logId) return item;
            return { ...item, row: { ...item.row, ...data.activity } };
        }));
    }

    const attentionRows = useMemo(
        () => stream
            .map(row => ({ row, rank: getAttentionRank(row) }))
            .filter((entry): entry is { row: StreamRow; rank: number } => entry.rank !== null)
            .sort((a, b) => a.rank - b.rank)
            .slice(0, 5),
        [stream],
    );

    return (
        <div className="h-full flex flex-col bg-zinc-950/60 min-h-0">
            <div className="px-3 py-2 border-b border-zinc-800/70 flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Activity</span>
                {(["all", "ap", "cron", "errors"] as const).map(f => (
                    <button key={f}
                        onClick={() => setFilter(f)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                            filter === f ? "bg-zinc-700 text-zinc-100 border-zinc-500" : "text-zinc-500 border-zinc-800 hover:text-zinc-300"
                        }`}
                    >
                        {f}
                    </button>
                ))}
                <div className="flex-1" />
                <button onClick={() => fetchAll(true)} disabled={refreshing}
                    className="text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40"
                    aria-label="Refresh activity">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                </button>
            </div>
            {attentionRows.length > 0 && (
                <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/[0.03] shrink-0">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-1">Needs Eyes</div>
                    <div className="space-y-1">
                        {attentionRows.map(({ row }) => {
                            const key = `${row.kind}:${row.row.id}`;
                            const subject = row.kind === "ap" ? row.row.email_subject : row.row.job_name;
                            const next = getNextHumanAction(row);
                            return (
                                <button
                                    key={key}
                                    onClick={() => toggleExpand(key)}
                                    className="w-full text-left flex items-baseline gap-2 text-[11px] font-mono text-zinc-300 hover:text-zinc-100"
                                >
                                    <span className="text-amber-300 shrink-0">!</span>
                                    <span className="truncate shrink-0 max-w-[22ch]">{subject}</span>
                                    {next && <span className="truncate text-amber-200/80">{next}</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-[1.45] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50">
                {loading && <div className="px-3 py-2 text-zinc-600">loading...</div>}
                {!loading && visible.length === 0 && <div className="px-3 py-2 text-zinc-600">no activity in window</div>}
                {visible.map(s => {
                    const isCron = s.kind === "cron";
                    const key = `${s.kind}:${s.row.id}`;
                    const ts = isCron ? s.row.started_at : s.row.created_at;
                    const isOpen = expanded.has(key);
                    const nextHumanAction = getNextHumanAction(s);
                    const link = getActivityLink(s);

                    if (isCron) {
                        const status = s.row.status ?? "running";
                        return (
                            <div key={key}>
                                <button
                                    onClick={() => toggleExpand(key)}
                                    className="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-zinc-800/30 border-l-2 border-l-transparent hover:border-l-zinc-700"
                                >
                                    <span className="text-zinc-600 shrink-0 w-[68px]">{fmt(ts)}</span>
                                    <span className={`shrink-0 w-3 text-center ${cronTone(status)}`}>{status === "success" ? "v" : status === "failed" || status === "error" ? "x" : "."}</span>
                                    <span className="shrink-0 w-[10ch] text-zinc-500 uppercase">CRON</span>
                                    <span className="shrink-0 text-zinc-300">{s.row.job_name}</span>
                                    {s.row.failure_reason && <span className="text-rose-400 truncate">- {s.row.failure_reason}</span>}
                                    {nextHumanAction && <span className="text-amber-300 truncate">{nextHumanAction}</span>}
                                </button>
                                {isOpen && (
                                    <pre className="px-3 py-1 ml-[88px] text-[10px] text-zinc-500 whitespace-pre-wrap break-all bg-zinc-900/40">
                                        {JSON.stringify({ status, started: s.row.started_at, finished: s.row.finished_at, failureReason: s.row.failure_reason }, null, 2)}
                                    </pre>
                                )}
                            </div>
                        );
                    }

                    const log = s.row;
                    const label = getActivityIntentLabel(log.intent);
                    const tone = INTENT_TONE[label] ?? INTENT_TONE[log.intent?.toUpperCase()] ?? "text-zinc-300";
                    const icon = intentIcon(log.intent);
                    const draft = noteDrafts[log.id] ?? log.human_note ?? "";
                    const processState = getDefaultProcessState(s);
                    const correlation = getCorrelationExplanation(s);
                    const teachPayload = log.learning_candidate ? getTeachPayload(s) : null;
                    return (
                        <div key={key}>
                            <button
                                onClick={() => toggleExpand(key)}
                                className="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-zinc-800/30 border-l-2 border-l-transparent hover:border-l-zinc-700"
                            >
                                <span className="text-zinc-600 shrink-0 w-[68px]">{fmt(ts)}</span>
                                <span className={`shrink-0 w-3 text-center ${tone}`}>{icon}</span>
                                <span className={`shrink-0 w-[14ch] uppercase truncate ${tone}`}>{label.toLowerCase().slice(0, 14)}</span>
                                <span className="shrink-0 text-zinc-300 truncate flex-1">{log.action_taken}</span>
                                {nextHumanAction && <span className="text-amber-300 truncate max-w-[34ch]">{nextHumanAction}</span>}
                                {link && (
                                    <a
                                        href={link.href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="inline-flex items-center gap-1 text-[10px] text-blue-300 hover:text-blue-200 shrink-0"
                                    >
                                        {link.label}
                                        <ExternalLink className="w-3 h-3" />
                                    </a>
                                )}
                                {log.reviewed_at && <span className="text-emerald-400 shrink-0">v reviewed</span>}
                            </button>
                            {isOpen && (
                                <div className="px-3 py-2 ml-[88px] text-[10px] text-zinc-500 bg-zinc-900/40 space-y-2">
                                    <pre className="whitespace-pre-wrap break-all">
                                        {log.email_from && `from: ${log.email_from}\n`}
                                        {log.email_subject && `subject: ${log.email_subject}\n`}
                                        {nextHumanAction && `${nextHumanAction}\n`}
                                        {log.metadata && Object.keys(log.metadata).length > 0
                                            ? JSON.stringify(log.metadata, null, 2)
                                            : ""}
                                    </pre>
                                    {correlation && (
                                        <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2 space-y-1">
                                            <div className="uppercase tracking-wider text-zinc-400">Correlation</div>
                                            <div className="text-zinc-200">{correlation.title}</div>
                                            <div className="text-zinc-500">confidence: {correlation.confidence}</div>
                                            {correlation.positiveSignals.map(signal => (
                                                <div key={signal} className="text-emerald-300">+ {signal}</div>
                                            ))}
                                            {correlation.negativeSignals.map(signal => (
                                                <div key={signal} className="text-amber-300">- {signal}</div>
                                            ))}
                                        </div>
                                    )}
                                    {teachPayload && (
                                        <div className="rounded border border-blue-500/20 bg-blue-500/[0.04] p-2">
                                            <div className="uppercase tracking-wider text-blue-300 mb-1">Teach payload</div>
                                            <pre className="whitespace-pre-wrap break-all text-blue-100/80">
                                                {JSON.stringify(teachPayload, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                    <div className="space-y-1">
                                        <label className="block text-zinc-400" htmlFor={`activity-note-${log.id}`}>Activity note</label>
                                        <textarea
                                            id={`activity-note-${log.id}`}
                                            aria-label="Activity note"
                                            value={draft}
                                            onChange={event => setNoteDrafts(current => ({ ...current, [log.id]: event.target.value }))}
                                            className="w-full min-h-[54px] resize-y rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-zinc-600"
                                        />
                                        <div className="flex flex-wrap gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => saveWorkflowPatch(log.id, { note: draft })}
                                                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                                            >
                                                Save note
                                            </button>
                                            {(["opened", "waiting_on_vendor", "handled"] as ProcessState[]).map(state => (
                                                <button
                                                    key={state}
                                                    type="button"
                                                    onClick={() => saveWorkflowPatch(log.id, { processState: state })}
                                                    className={`rounded border px-2 py-1 ${processState === state ? "border-amber-400 text-amber-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
                                                >
                                                    {state === "opened" ? "Opened" : state === "waiting_on_vendor" ? "Waiting on vendor" : "Handled"}
                                                </button>
                                            ))}
                                            <button
                                                type="button"
                                                onClick={() => saveWorkflowPatch(log.id, { learningCandidate: !log.learning_candidate })}
                                                className={`rounded border px-2 py-1 ${log.learning_candidate ? "border-blue-400 text-blue-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
                                            >
                                                Teach from this
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
