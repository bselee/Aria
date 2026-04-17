"use client";

import { useCallback, useEffect, useState } from "react";
import { FileSearch, RefreshCw, ChevronDown } from "lucide-react";

type QueueItem = {
    id: string;
    vendorName: string;
    status: string;
    sourceType: string;
    artifactKind: string;
    discoveredAt: string;
};

type RunItem = {
    id: string;
    vendorName: string;
    runStatus: string;
    matchedCount: number;
    missingCount: number;
    mismatchCount: number;
    duplicateCount: number;
    needsReviewCount: number;
    createdAt: string;
    lastError?: string | null;
};

type ResponseBody = {
    queue: QueueItem[];
    runs: RunItem[];
    cachedAt: string;
};

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}

export default function StatementReconciliationPanel() {
    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [runs, setRuns] = useState<RunItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [acting, setActing] = useState<string | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => {
      const s = localStorage.getItem("aria-dash-stmtrecon-collapsed");
      if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-stmtrecon-collapsed", String(isCollapsed)); }, [isCollapsed]);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch("/api/dashboard/statement-reconciliation");
            if (!res.ok) return;
            const body: ResponseBody = await res.json();
            setQueue(body.queue ?? []);
            setRuns(body.runs ?? []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 60_000);
        return () => clearInterval(interval);
    }, [fetchData]);

    const launch = useCallback(async (body: Record<string, unknown>, label: string) => {
        setActing(label);
        try {
            await fetch("/api/dashboard/statement-reconciliation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            await fetchData();
        } finally {
            setActing(null);
        }
    }, [fetchData]);

    return (
        <div className="border border-zinc-800 bg-zinc-900/60 rounded-lg overflow-hidden">
            <div className="px-4 py-2 flex items-center gap-2 border-b border-zinc-800/70">
                <FileSearch className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">
                    Statement Recon
                </span>
                <div className="flex-1" />
                <button
                    onClick={fetchData}
                    className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    refresh
                </button>
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "" : "rotate-180"}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center gap-2">
                        <button
                            onClick={() => launch({ action: "run_fedex_download" }, "fedex")}
                            disabled={acting !== null}
                            className="px-2 py-1 rounded border border-zinc-700 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                            {acting === "fedex" ? "launching..." : "FedEx Request"}
                        </button>
                        <span className="text-[10px] font-mono text-zinc-500">
                            dashboard-only launch, background processing
                        </span>
                    </div>

                    <div className="px-4 py-3">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-2">
                            Suggested Queue
                        </div>
                        {loading ? (
                            <div className="text-xs text-zinc-500">loading...</div>
                        ) : queue.length === 0 ? (
                            <div className="text-xs text-zinc-500">no queued statements</div>
                        ) : (
                            <div className="space-y-2">
                                {queue.slice(0, 6).map((item) => (
                                    <div key={item.id} className="flex items-center gap-2 text-xs">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-zinc-200 truncate">{item.vendorName}</div>
                                            <div className="text-zinc-500 font-mono">
                                                {item.sourceType} · {item.status} · {timeAgo(item.discoveredAt)}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => launch({ action: "run_existing_intake", intakeId: item.id }, item.id)}
                                            disabled={acting !== null}
                                            className="px-2 py-1 rounded border border-zinc-700 text-[10px] font-mono text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                                        >
                                            {acting === item.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : "run"}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="px-4 py-3 border-t border-zinc-800/60">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-2">
                            Recent Runs
                        </div>
                        {runs.length === 0 ? (
                            <div className="text-xs text-zinc-500">no runs yet</div>
                        ) : (
                            <div className="space-y-2">
                                {runs.slice(0, 5).map((run) => (
                                    <div key={run.id} className="text-xs">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-zinc-200 truncate">{run.vendorName}</span>
                                            <span className="text-zinc-500 font-mono">{run.runStatus}</span>
                                        </div>
                                        <div className="text-zinc-500 font-mono">
                                            m:{run.matchedCount} miss:{run.missingCount} diff:{run.mismatchCount} review:{run.needsReviewCount + run.duplicateCount}
                                        </div>
                                        {run.lastError ? (
                                            <div className="text-[10px] text-rose-300">{run.lastError}</div>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
