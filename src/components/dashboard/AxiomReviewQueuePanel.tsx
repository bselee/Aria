"use client";

import { useEffect, useState, useCallback } from "react";
import { CopyPlus, ChevronDown, Check, X } from "lucide-react";
import type { AxiomQueueItem, AxiomQueueStats, AxiomQueueResponse } from "@/app/api/dashboard/axiom-queue/route";

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}

type StatusKey = "pending" | "approved" | "rejected" | "ordered";

const STATUS_CFG: Record<StatusKey, { dot: string; label: string; pulse: boolean }> = {
    pending: { dot: "bg-amber-400", label: "PENDING", pulse: true },
    approved: { dot: "bg-emerald-500", label: "APPROVED", pulse: false },
    rejected: { dot: "bg-zinc-600", label: "REJECT", pulse: false },
    ordered: { dot: "bg-blue-500", label: "ORDERED", pulse: false },
};

function statusCfg(status: string) {
    return STATUS_CFG[status as StatusKey] ?? { dot: "bg-zinc-600", label: status.toUpperCase(), pulse: false };
}

export default function AxiomReviewQueuePanel() {
    const [items, setItems] = useState<AxiomQueueItem[]>([]);
    const [stats, setStats] = useState<AxiomQueueStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [actingOn, setActingOn] = useState<string | null>(null);

    // Track edited quantities before approval
    const [editedQty, setEditedQty] = useState<Record<string, number>>({});

    const handleAction = useCallback(async (id: string, action: "approve" | "reject") => {
        setActingOn(id);
        const qty = editedQty[id];
        try {
            const res = await fetch("/api/dashboard/axiom-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, action, qty }),
            });
            const data = await res.json();
            if (!res.ok) {
                console.error("Action failed:", data.error);
            }
        } catch (err) {
            console.error("Action error:", err);
        } finally {
            setActingOn(null);
            fetchData(true);
        }
    }, [editedQty]);

    const handleQtyChange = (id: string, newQtyRaw: string) => {
        const qty = parseInt(newQtyRaw, 10);
        if (isNaN(qty)) return;
        setEditedQty(prev => ({ ...prev, [id]: qty }));
    };

    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-axiom-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => {
        localStorage.setItem("aria-dash-axiom-collapsed", String(isCollapsed));
    }, [isCollapsed]);

    const fetchData = useCallback((bust = false) => {
        const url = bust
            ? "/api/dashboard/axiom-queue?bust=1"
            : "/api/dashboard/axiom-queue";
        fetch(url)
            .then(r => r.ok ? r.json() : null)
            .then((data: AxiomQueueResponse | null) => {
                if (data) {
                    setItems(data.items);
                    setStats(data.stats);
                }
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(() => fetchData(), 60_000);
        return () => clearInterval(interval);
    }, [fetchData]);

    const pending = items.filter(i => i.status === "pending");
    const rest = items.filter(i => i.status !== "pending");

    return (
        <div className="border-b border-zinc-800 shrink-0">
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <CopyPlus className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">
                    Axiom Ordering
                </span>
                <div className="flex-1" />

                {pending.length > 0 && (
                    <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40">
                        {pending.length} NEEDS REVIEW
                    </span>
                )}
                {!loading && pending.length === 0 && (
                    <span className="text-xs font-mono text-zinc-600">all clear</span>
                )}

                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {stats && (
                        <div className="px-4 py-1.5 border-b border-zinc-800/40 flex items-center gap-3 flex-wrap">
                            <span className="text-[10px] font-mono text-zinc-500">
                                pending: <span className="text-amber-300">{stats.totalPending}</span>
                            </span>
                            <span className="text-[10px] font-mono text-zinc-600">|</span>
                            <span className="text-[10px] font-mono text-zinc-500">
                                approved: <span className="text-emerald-400">{stats.totalApproved}</span>
                            </span>
                            <span className="text-[10px] font-mono text-zinc-600">|</span>
                            <span className="text-[10px] font-mono text-zinc-500">
                                ordered: <span className="text-blue-400">{stats.totalOrdered}</span>
                            </span>
                        </div>
                    )}

                    {loading && (
                        <div className="px-4 py-2 space-y-2.5">
                            {[1].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-1.5 h-1.5 rounded-full skeleton-shimmer shrink-0" />
                                    <div className="skeleton-shimmer h-3.5 w-1/2" />
                                    <div className="skeleton-shimmer h-3 w-8 ml-auto" />
                                </div>
                            ))}
                        </div>
                    )}

                    {pending.map(item => {
                        const cfg = statusCfg(item.status);
                        const displayedQty = editedQty[item.id] !== undefined ? editedQty[item.id] : item.suggested_reorder_qty;

                        return (
                            <div
                                key={item.id}
                                className="flex items-start gap-2.5 px-4 py-2 border-b border-amber-500/10 bg-amber-500/5 border-l-2"
                                style={{ borderLeftColor: "var(--dash-accent-pending)" }}
                            >
                                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} animate-pulse`} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <a href={item.product_url} target="_blank" rel="noreferrer" className="text-sm font-mono font-semibold text-zinc-100 truncate hover:underline cursor-pointer">
                                            {item.product_id}
                                        </a>
                                        <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                                            (Finale: {item.finale_sku})
                                        </span>
                                        <span className="text-[10px] font-mono text-[var(--dash-ts)] shrink-0 ml-auto">
                                            {timeAgo(item.created_at)}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] font-mono text-amber-300/70 truncate">
                                            ⚠ Stock: {item.current_stock} (Runway: {item.runway_days}d | Vel: {item.velocity_30d}/mo)
                                        </span>
                                        <div className="flex-1" />
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-mono text-zinc-400">Order Qty:</span>
                                            <input
                                                type="number"
                                                className="w-16 px-1 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-xs font-mono text-zinc-200 outline-none focus:border-amber-500/50"
                                                value={displayedQty}
                                                onChange={(e) => handleQtyChange(item.id, e.target.value)}
                                            />
                                            <button
                                                onClick={() => handleAction(item.id, "approve")}
                                                disabled={actingOn === item.id}
                                                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                                            >
                                                <Check className="w-3 h-3" />
                                                {actingOn === item.id ? "..." : "Approve"}
                                            </button>
                                            <button
                                                onClick={() => handleAction(item.id, "reject")}
                                                disabled={actingOn === item.id}
                                                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-700/50 text-zinc-400 border border-zinc-600/30 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                                            >
                                                <X className="w-3 h-3" />
                                                Skip
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {rest.length > 0 && (
                        <div className="max-h-[160px] overflow-y-auto">
                            {rest.slice(0, 20).map(item => {
                                const cfg = statusCfg(item.status);
                                return (
                                    <div
                                        key={item.id}
                                        className="flex items-center gap-2.5 px-4 py-1.5 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors"
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                                        <span className="text-xs font-mono text-zinc-300 truncate flex-1">
                                            {item.product_id}
                                        </span>
                                        <span className="text-[10px] font-mono text-zinc-600 shrink-0">
                                            Qty: {item.suggested_reorder_qty}
                                        </span>
                                        <span className="text-[10px] font-mono font-semibold shrink-0 text-zinc-500 w-16 text-center">
                                            {cfg.label}
                                        </span>
                                        <span className="text-[10px] font-mono text-[var(--dash-ts)] shrink-0 w-6 text-right">
                                            {timeAgo(item.created_at)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
