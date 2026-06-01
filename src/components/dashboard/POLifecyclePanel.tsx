/**
 * @file    POLifecyclePanel.tsx
 * @purpose Dashboard panel showing PO lifecycle states as a visual flow.
 *          Displays a summary per state: ORDERED → INVOICED → RECONCILED → RECEIVED → COMPLETED
 * @author  Hermia
 * @created 2026-06-01
 * @deps    react
 */
"use client";

import React, { useEffect, useState } from "react";

type LifecycleCounts = Record<string, number>;

const STATE_ORDER = ["ORDERED", "INVOICED", "RECONCILED", "RECEIVED", "COMPLETED"];

const STATE_COLORS: Record<string, string> = {
    ORDERED: "bg-blue-100 text-blue-800 border-blue-300",
    INVOICED: "bg-amber-100 text-amber-800 border-amber-300",
    RECONCILED: "bg-green-100 text-green-800 border-green-300",
    RECEIVED: "bg-teal-100 text-teal-800 border-teal-300",
    COMPLETED: "bg-gray-100 text-gray-800 border-gray-300",
};

const STATE_ICONS: Record<string, string> = {
    ORDERED: "📋",
    INVOICED: "🧾",
    RECONCILED: "✅",
    RECEIVED: "📦",
    COMPLETED: "🏁",
};

export default function POLifecyclePanel() {
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
            // Fallback: show empty counts
            setCounts({});
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 60000); // refresh every 60s
        return () => clearInterval(interval);
    }, []);

    const total = counts
        ? Object.values(counts).reduce((sum, c) => sum + c, 0)
        : 0;

    return (
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

            {/* Error state */}
                {error && (
                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 p-2 rounded flex items-center gap-1">
                        <span>⚠️</span>
                        <span>Offline — {error}</span>
                    </div>
                )}

                {!error && !counts && !loading && (
                    <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 p-2 rounded flex items-center gap-1">
                        <span>⏳</span>
                        <span>No data yet — waiting for first sync</span>
                    </div>
                )}

                {!error && loading && !counts && (
                    <div className="flex items-center justify-center py-6 text-gray-400 text-xs">
                        <span className="animate-pulse">Loading...</span>
                    </div>
                )}

                {/* Flow arrows */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {error && (
                    <div className="text-xs text-red-500 bg-red-50 p-2 rounded">
                        {error}
                    </div>
                )}

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
                                                : "bg-blue-400"
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
            </div>
        </div>
    );
}