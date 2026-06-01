/**
 * @file    POLifecyclePanel.tsx
 * @purpose Dashboard panel showing PO lifecycle states as a visual flow.
 *          DISPLAYS error/loading/no-data/empty states cleanly.
 *          State flow: REVIEW → SENT → ACKNOWLEDGED → INVOICED → RECONCILED → RECEIVED → COMPLETED
 *          COMPACT mode renders just the flow bar (no detail breakdown) for embedding in CommandBoard.
 * @author  Hermia
 * @created 2026-06-01
 * @deps    react
 */
"use client";

import React, { useEffect, useState } from "react";

type LifecycleCounts = Record<string, number>;

const STATE_ORDER = ["REVIEW", "SENT", "ACKNOWLEDGED", "INVOICED", "RECONCILED", "RECEIVED", "COMPLETED"];

const STATE_COLORS: Record<string, string> = {
    REVIEW: "bg-purple-100 text-purple-800 border-purple-300",
    SENT: "bg-blue-100 text-blue-800 border-blue-300",
    ACKNOWLEDGED: "bg-indigo-100 text-indigo-800 border-indigo-300",
    INVOICED: "bg-amber-100 text-amber-800 border-amber-300",
    RECONCILED: "bg-green-100 text-green-800 border-green-300",
    RECEIVED: "bg-teal-100 text-teal-800 border-teal-300",
    COMPLETED: "bg-gray-100 text-gray-800 border-gray-300",
    CANCELLED: "bg-red-100 text-red-800 border-red-300",
};

const STATE_COLORS_DARK: Record<string, string> = {
    REVIEW: "bg-purple-900/40 text-purple-200 border-purple-600/50",
    SENT: "bg-blue-900/40 text-blue-200 border-blue-600/50",
    ACKNOWLEDGED: "bg-indigo-900/40 text-indigo-200 border-indigo-600/50",
    INVOICED: "bg-amber-900/40 text-amber-200 border-amber-600/50",
    RECONCILED: "bg-green-900/40 text-green-200 border-green-600/50",
    RECEIVED: "bg-teal-900/40 text-teal-200 border-teal-600/50",
    COMPLETED: "bg-gray-700/40 text-gray-300 border-gray-600/50",
    CANCELLED: "bg-red-900/40 text-red-200 border-red-600/50",
};

const STATE_ICONS: Record<string, string> = {
    REVIEW: "🔍",
    SENT: "📨",
    ACKNOWLEDGED: "👋",
    INVOICED: "🧾",
    RECONCILED: "✅",
    RECEIVED: "📦",
    COMPLETED: "🏁",
    CANCELLED: "🗑️",
};

interface POLifecyclePanelProps {
    /** Compact mode: just the flow bar, no detail breakdown, dark-theme friendly. */
    compact?: boolean;
}

export default function POLifecyclePanel({ compact = false }: POLifecyclePanelProps) {
    const [counts, setCounts] = useState<LifecycleCounts | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<string>("");

    const fetchData = async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/dashboard/po-lifecycle");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setCounts(data.counts || {});
            setLastRefresh(new Date().toLocaleTimeString());
            setError(null);
        } catch (e: any) {
            setError(e.message);
            setCounts({});
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 60000);
        return () => clearInterval(interval);
    }, []);

    const total = counts
        ? Object.values(counts).reduce((sum, c) => sum + c, 0)
        : 0;

    return compact ? (
        // ── Compact mode: dark theme, no detail breakdown ──────────────
        <div className="flex flex-col bg-zinc-900/40 border border-zinc-800/60 rounded overflow-hidden" data-testid="po-lifecycle-compact">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-900/60">
                <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">🔄</span>
                    <span className="font-semibold text-[11px] text-zinc-100 uppercase tracking-wider">
                        PO Pipeline
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-500 font-mono">
                        {loading ? "—" : `${total} POs`}
                    </span>
                    <button
                        onClick={fetchData}
                        disabled={loading}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                    >
                        {loading ? "..." : "↻"}
                    </button>
                </div>
            </div>

            {/* Flow bar */}
            <div className="flex-1 flex items-center overflow-x-auto px-3 py-2 gap-0 scrollbar-thin">
                {error && (
                    <span className="text-[10px] text-red-400 font-mono">⚠ {error}</span>
                )}
                {!error && loading && !counts && (
                    <span className="text-[10px] text-zinc-500 font-mono animate-pulse">loading...</span>
                )}
                {!error && !loading && counts && total === 0 && (
                    <span className="text-[10px] text-zinc-500 font-mono">📭 No POs tracked</span>
                )}
                {counts && total > 0 && (
                    <div className="flex items-center gap-0">
                        {STATE_ORDER.map((state, idx) => (
                            <React.Fragment key={state}>
                                <div
                                    className={`flex flex-col items-center justify-center w-12 h-12 rounded-full border shrink-0 ${
                                        STATE_COLORS_DARK[state] || "bg-zinc-800/60 text-zinc-400 border-zinc-700/50"
                                    }`}
                                    title={`${state}: ${counts?.[state] ?? 0} POs`}
                                >
                                    <span className="text-xs leading-none">{STATE_ICONS[state]}</span>
                                    <span className="text-[9px] font-bold leading-tight mt-0.5 tabular-nums">
                                        {counts?.[state] ?? 0}
                                    </span>
                                </div>
                                {idx < STATE_ORDER.length - 1 && (
                                    <div className="flex items-center justify-center px-0.5 shrink-0">
                                        <svg className="w-5 h-3" viewBox="0 0 20 12">
                                            <line x1="0" y1="6" x2="17" y2="6" stroke="#3f3f46" strokeWidth="1.5" />
                                            <polygon points="17,6 14,3 14,9" fill="#3f3f46" />
                                        </svg>
                                    </div>
                                )}
                            </React.Fragment>
                        ))}
                    </div>
                )}
            </div>
        </div>
    ) : (
        // ── Full mode: light card, detail breakdown ────────────────────
        <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                    <span className="text-lg">🔄</span>
                    <span className="font-semibold text-sm text-gray-800">
                        PO Lifecycle
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                        {total} POs
                    </span>
                    <button
                        onClick={fetchData}
                        className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                        disabled={loading}
                    >
                        {loading ? "..." : "↻"}
                    </button>
                </div>
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {/* Error state */}
                {error && (
                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded flex items-center gap-1">
                        <span>⚠️</span>
                        <span>Offline — {error}</span>
                    </div>
                )}

                {/* No data yet (initial load completed, nothing from API) */}
                {!error && !loading && counts && total === 0 && (
                    <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 p-2 rounded flex items-center gap-1">
                        <span>📭</span>
                        <span>No POs in lifecycle tracking yet</span>
                    </div>
                )}

                {/* Waiting for first sync (initial loading, no data returned yet) */}
                {!error && loading && !counts && (
                    <div className="flex items-center justify-center py-6 text-gray-400 text-xs">
                        <span className="animate-pulse">Loading...</span>
                    </div>
                )}

                {/* Flow content — only when we have data to show */}
                {counts && total > 0 && (
                    <>
                        {/* Flow arrows */}
                        <div className="flex items-center justify-between px-1 py-2">
                            {STATE_ORDER.map((state, idx) => (
                                <React.Fragment key={state}>
                                    <div
                                        className={`flex flex-col items-center justify-center w-14 h-14 rounded-full border-2 ${
                                            STATE_COLORS[state] || "bg-gray-100"
                                        }`}
                                    >
                                        <span className="text-sm">{STATE_ICONS[state]}</span>
                                        <span className="text-[10px] font-bold leading-tight mt-0.5">
                                            {counts?.[state] ?? 0}
                                        </span>
                                    </div>
                                    {idx < STATE_ORDER.length - 1 && (
                                        <div className="flex-1 flex items-center justify-center px-1">
                                            <svg className="w-full h-4" viewBox="0 0 40 16">
                                                <line
                                                    x1="0" y1="8" x2="35" y2="8"
                                                    stroke="#d1d5db" strokeWidth="2"
                                                />
                                                <polygon
                                                    points="35,8 30,4 30,12"
                                                    fill="#d1d5db"
                                                />
                                            </svg>
                                        </div>
                                    )}
                                </React.Fragment>
                            ))}
                        </div>

                        {/* State labels */}
                        <div className="flex justify-between px-1">
                            {STATE_ORDER.map(state => (
                                <span key={state} className="text-[10px] text-gray-500 text-center w-14">
                                    {state}
                                </span>
                            ))}
                        </div>

                        {/* Detail breakdown */}
                        <div className="mt-3 border-t border-gray-100 pt-2 space-y-1">
                            {STATE_ORDER.map(state => {
                                const count = counts?.[state] ?? 0;
                                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                                return (
                                    <div key={state} className="flex items-center gap-2 text-xs">
                                        <span className="w-20 text-gray-600 truncate">
                                            {STATE_ICONS[state]} {state}
                                        </span>
                                        <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                                            <div
                                                className={`h-full rounded-full transition-all duration-500 ${
                                                    state === "COMPLETED"
                                                        ? "bg-gray-400"
                                                        : state === "RECEIVED"
                                                        ? "bg-teal-400"
                                                        : state === "RECONCILED"
                                                        ? "bg-green-400"
                                                        : state === "INVOICED"
                                                        ? "bg-amber-400"
                                                        : state === "CANCELLED"
                                                        ? "bg-red-400"
                                                        : state === "ACKNOWLEDGED"
                                                        ? "bg-indigo-400"
                                                        : state === "SENT"
                                                        ? "bg-blue-400"
                                                        : "bg-purple-400"
                                                }`}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                        <span className="w-16 text-right text-gray-500 tabular-nums">
                                            {count} ({pct}%)
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Legend */}
                        <div className="mt-2 text-[10px] text-gray-400 text-center">
                            {lastRefresh ? `Updated ${lastRefresh}` : ""}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}