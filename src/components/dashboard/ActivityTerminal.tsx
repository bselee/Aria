"use client";

/**
 * @file    ActivityTerminal.tsx
 * @purpose Terminal-style line-by-line activity feed. One row per event,
 *          monospace, time + intent + action. Pulls from the same
 *          ap_activity_log + cron_runs tables ActivityFeed.tsx uses,
 *          renders compact instead of card-based.
 *
 * Click a row to expand its metadata JSON.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { RefreshCw } from "lucide-react";

type ActivityLog = {
    id: string;
    created_at: string;
    email_from: string | null;
    email_subject: string | null;
    intent: string;
    action_taken: string;
    metadata: any;
    reviewed_at: string | null;
    reviewed_action: string | null;
};

type CronRun = {
    id: string;
    job_name: string;
    started_at: string;
    finished_at: string | null;
    status: string | null;
    failure_reason: string | null;
};

type StreamRow =
    | { kind: 'ap'; row: ActivityLog }
    | { kind: 'cron'; row: CronRun };

function fmt(ts: string): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(0, 19);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return sameDay ? time : `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`;
}

const INTENT_TONE: Record<string, string> = {
    INVOICE:                      'text-cyan-300',
    PROCESSING_ERROR:             'text-rose-300',
    RECONCILIATION:               'text-emerald-300',
    PO_SEND_FINALE:               'text-emerald-300',
    PO_COMMIT:                    'text-emerald-300',
    DROPSHIP:                     'text-purple-300',
    BILL_FORWARDED:               'text-cyan-300',
    BILL_FORWARD_FAILED:          'text-rose-400',
    AP_ACTION:                    'text-zinc-300',
};
const cronTone = (status: string | null) =>
    status === 'success' ? 'text-emerald-300'
    : status === 'failed' || status === 'error' ? 'text-rose-300'
    : status === 'running' ? 'text-amber-300'
    : 'text-zinc-400';

function intentIcon(intent: string): string {
    const i = intent.toUpperCase();
    if (i.includes('ERROR') || i.includes('FAIL')) return '✗';
    if (i.includes('RECONCIL')) return '↻';
    if (i.includes('SEND') || i.includes('COMMIT')) return '→';
    if (i.includes('FORWARD')) return '↦';
    if (i.includes('DROPSHIP')) return '⇢';
    if (i.includes('INVOICE')) return '$';
    return '·';
}

export default function ActivityTerminal() {
    const [stream, setStream] = useState<StreamRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState<'all' | 'ap' | 'cron' | 'errors'>('all');

    const fetchAll = useCallback(async (silent = false) => {
        silent ? setRefreshing(true) : setLoading(true);
        try {
            const supabase = createBrowserClient();
            const [apRes, cronRes] = await Promise.all([
                supabase
                    .from('ap_activity_log')
                    .select('id, created_at, email_from, email_subject, intent, action_taken, metadata, reviewed_at, reviewed_action')
                    .order('created_at', { ascending: false })
                    .limit(150),
                supabase
                    .from('cron_runs')
                    .select('id, job_name, started_at, finished_at, status, failure_reason')
                    .order('started_at', { ascending: false })
                    .limit(100),
            ]);
            const ap = (apRes.data ?? []).map(r => ({ kind: 'ap' as const, row: r as ActivityLog }));
            const cron = (cronRes.data ?? []).map(r => ({ kind: 'cron' as const, row: r as CronRun }));
            const merged = [...ap, ...cron].sort((a, b) => {
                const at = a.kind === 'ap' ? a.row.created_at : a.row.started_at;
                const bt = b.kind === 'ap' ? b.row.created_at : b.row.started_at;
                return bt.localeCompare(at);
            });
            setStream(merged.slice(0, 200));
        } catch (err) {
            console.warn('[ActivityTerminal] fetch failed:', err);
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
        if (filter === 'all') return stream;
        if (filter === 'ap') return stream.filter(s => s.kind === 'ap');
        if (filter === 'cron') return stream.filter(s => s.kind === 'cron');
        if (filter === 'errors') {
            return stream.filter(s =>
                s.kind === 'cron'
                    ? (s.row.status === 'failed' || s.row.status === 'error')
                    : s.row.intent.toUpperCase().includes('ERROR') || s.row.intent.toUpperCase().includes('FAIL'),
            );
        }
        return stream;
    }, [stream, filter]);

    function toggleExpand(key: string) {
        setExpanded(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
    }

    return (
        <div className="h-full flex flex-col bg-zinc-950/60 min-h-0">
            <div className="px-3 py-2 border-b border-zinc-800/70 flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Activity</span>
                {(['all', 'ap', 'cron', 'errors'] as const).map(f => (
                    <button key={f}
                        onClick={() => setFilter(f)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                            filter === f ? 'bg-zinc-700 text-zinc-100 border-zinc-500' : 'text-zinc-500 border-zinc-800 hover:text-zinc-300'
                        }`}
                    >
                        {f}
                    </button>
                ))}
                <div className="flex-1" />
                <button onClick={() => fetchAll(true)} disabled={refreshing}
                    className="text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-[1.45] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50">
                {loading && <div className="px-3 py-2 text-zinc-600">loading…</div>}
                {!loading && visible.length === 0 && <div className="px-3 py-2 text-zinc-600">no activity in window</div>}
                {visible.map(s => {
                    const isCron = s.kind === 'cron';
                    const key = `${s.kind}:${s.row.id}`;
                    const ts = isCron ? s.row.started_at : s.row.created_at;
                    const isOpen = expanded.has(key);

                    if (isCron) {
                        const status = s.row.status ?? 'running';
                        return (
                            <div key={key}>
                                <button
                                    onClick={() => toggleExpand(key)}
                                    className="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-zinc-800/30 border-l-2 border-l-transparent hover:border-l-zinc-700"
                                >
                                    <span className="text-zinc-600 shrink-0 w-[68px]">{fmt(ts)}</span>
                                    <span className={`shrink-0 w-3 text-center ${cronTone(status)}`}>{status === 'success' ? '✓' : status === 'failed' || status === 'error' ? '✗' : '·'}</span>
                                    <span className="shrink-0 w-[10ch] text-zinc-500 uppercase">CRON</span>
                                    <span className="shrink-0 text-zinc-300">{s.row.job_name}</span>
                                    {s.row.failure_reason && <span className="text-rose-400 truncate">— {s.row.failure_reason}</span>}
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
                    const intent = log.intent ?? '';
                    const tone = INTENT_TONE[intent.toUpperCase()] ?? 'text-zinc-300';
                    const icon = intentIcon(intent);
                    return (
                        <div key={key}>
                            <button
                                onClick={() => toggleExpand(key)}
                                className="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-zinc-800/30 border-l-2 border-l-transparent hover:border-l-zinc-700"
                            >
                                <span className="text-zinc-600 shrink-0 w-[68px]">{fmt(ts)}</span>
                                <span className={`shrink-0 w-3 text-center ${tone}`}>{icon}</span>
                                <span className={`shrink-0 w-[14ch] uppercase truncate ${tone}`}>{intent.toLowerCase().slice(0, 14)}</span>
                                <span className="shrink-0 text-zinc-300 truncate flex-1">{log.action_taken}</span>
                                {log.reviewed_at && <span className="text-emerald-400 shrink-0">✓ reviewed</span>}
                            </button>
                            {isOpen && (
                                <pre className="px-3 py-1 ml-[88px] text-[10px] text-zinc-500 whitespace-pre-wrap break-all bg-zinc-900/40">
                                    {log.email_from && `from: ${log.email_from}\n`}
                                    {log.email_subject && `subject: ${log.email_subject}\n`}
                                    {log.metadata && Object.keys(log.metadata).length > 0
                                        ? JSON.stringify(log.metadata, null, 2)
                                        : ''}
                                </pre>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
