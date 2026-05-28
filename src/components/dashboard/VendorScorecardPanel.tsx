"use client";

/**
 * @file    VendorScorecardPanel.tsx
 * @purpose Per-vendor reliability scorecard — grades, reply rates, on-time
 *          delivery, invoice accuracy. Sortable, searchable, expands to show
 *          recent POs.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    /api/dashboard/vendor-reliability
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Search, SortAsc, SortDesc, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { SortablePanel } from "./SortablePanel";

type Grade = "A" | "B" | "C" | "D" | "F" | null;

interface VendorRow {
    vendorName: string;
    poCount: number;
    replyRate: number | null;
    onTimeRate: number | null;
    avgReplyHours: number | null;
    avgDaysToDelivery: number | null;
    invoiceAccuracy: number | null;
    noncommRate: number | null;
    grade: Grade;
    windowStart: string;
    windowEnd: string;
}

type SortKey = "vendorName" | "grade" | "replyRate" | "onTimeRate" | "invoiceAccuracy" | "poCount" | "avgReplyHours" | "avgDaysToDelivery";

const GRADE_COLORS: Record<string, string> = {
    A: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    B: "bg-blue-500/20 text-blue-300 border-blue-500/40",
    C: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    D: "bg-orange-500/20 text-orange-300 border-orange-500/40",
    F: "bg-rose-500/20 text-rose-300 border-rose-500/40",
};

function pct(v: number | null): string {
    if (v == null) return "—";
    return `${Math.round(v * 100)}%`;
}

function hours(v: number | null): string {
    if (v == null) return "—";
    if (v < 24) return `${Math.round(v)}h`;
    return `${(v / 24).toFixed(1)}d`;
}

function days(v: number | null): string {
    if (v == null) return "—";
    return `${v.toFixed(1)}d`;
}

const gradeRank: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

export default function VendorScorecardPanel() {
    const [rows, setRows] = useState<VendorRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("grade");
    const [sortAsc, setSortAsc] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/dashboard/vendor-reliability?bust=" + Date.now());
            const data = await res.json();
            setRows(data.rows || []);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const filtered = useMemo(() => {
        let r = rows;
        if (search) {
            const q = search.toLowerCase();
            r = r.filter(v => v.vendorName.toLowerCase().includes(q));
        }
        r = [...r].sort((a, b) => {
            let cmp = 0;
            switch (sortKey) {
                case "vendorName":
                    cmp = a.vendorName.localeCompare(b.vendorName);
                    break;
                case "grade":
                    cmp = (gradeRank[a.grade || "F"] ?? 5) - (gradeRank[b.grade || "F"] ?? 5);
                    if (cmp === 0) cmp = (b.poCount || 0) - (a.poCount || 0);
                    break;
                case "poCount":
                    cmp = (a.poCount || 0) - (b.poCount || 0);
                    break;
                case "replyRate":
                    cmp = (a.replyRate ?? -1) - (b.replyRate ?? -1);
                    break;
                case "onTimeRate":
                    cmp = (a.onTimeRate ?? -1) - (b.onTimeRate ?? -1);
                    break;
                case "invoiceAccuracy":
                    cmp = (a.invoiceAccuracy ?? -1) - (b.invoiceAccuracy ?? -1);
                    break;
                case "avgReplyHours":
                    cmp = (a.avgReplyHours ?? 9999) - (b.avgReplyHours ?? 9999);
                    break;
                case "avgDaysToDelivery":
                    cmp = (a.avgDaysToDelivery ?? 9999) - (b.avgDaysToDelivery ?? 9999);
                    break;
            }
            return sortAsc ? cmp : -cmp;
        });
        return r;
    }, [rows, search, sortKey, sortAsc]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) setSortAsc(!sortAsc);
        else { setSortKey(key); setSortAsc(key === "vendorName"); }
    };

    const SortIcon = ({ k }: { k: SortKey }) => {
        if (sortKey !== k) return <span className="text-zinc-700 w-2.5 h-2.5" />;
        return sortAsc ? <SortAsc className="w-2.5 h-2.5 text-emerald-400" /> : <SortDesc className="w-2.5 h-2.5 text-emerald-400" />;
    };

    // Summary stats
    const totalPOs = rows.reduce((s, r) => s + (r.poCount || 0), 0);
    const avgReply = rows.filter(r => r.replyRate != null).reduce((s, r, _, a) => s + (r.replyRate! / a.length), 0);
    const avgOnTime = rows.filter(r => r.onTimeRate != null).reduce((s, r, _, a) => s + (r.onTimeRate! / a.length), 0);
    const gradeDistribution = rows.reduce<Record<string, number>>((acc, r) => { acc[r.grade || "?"] = (acc[r.grade || "?"] || 0) + 1; return acc; }, {});

    return (
        <SortablePanel id="vendor-scorecard">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-semibold text-zinc-200">📊 Vendor Scorecard</span>
                    <span className="text-[9px] font-mono text-zinc-600">{rows.length} vendors · {totalPOs} POs (180d)</span>
                </div>
                <button onClick={load} disabled={loading} className="text-zinc-600 hover:text-zinc-300 transition-colors" title="Refresh">
                    <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                </button>
            </div>

            {/* Summary bar */}
            <div className="px-3 py-1.5 border-b border-zinc-800/50 flex items-center gap-3 text-[9px] font-mono">
                <span className="text-zinc-500">Avg Reply: <span className="text-zinc-300">{pct(avgReply)}</span></span>
                <span className="text-zinc-500">Avg On-Time: <span className="text-zinc-300">{pct(avgOnTime)}</span></span>
                <div className="flex-1" />
                {(["A", "B", "C", "D", "F"] as const).map(g => (
                    gradeDistribution[g] ? (
                        <span key={g} className={`px-1 rounded border text-[8px] ${GRADE_COLORS[g] || ""}`}>
                            {g}:{gradeDistribution[g]}
                        </span>
                    ) : null
                ))}
            </div>

            {/* Search */}
            <div className="px-3 py-1.5 border-b border-zinc-800/30">
                <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1">
                    <Search className="w-3 h-3 text-zinc-600" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Filter vendors…"
                        className="bg-transparent text-[10px] font-mono text-zinc-200 outline-none flex-1 placeholder-zinc-700"
                    />
                </div>
            </div>

            {error && <div className="px-3 py-2 text-[10px] font-mono text-rose-400">{error}</div>}

            {/* Table header */}
            <div className="px-3 py-1 border-b border-zinc-800/50 flex items-center gap-1 text-[8px] font-mono uppercase tracking-wider text-zinc-600">
                <span className="w-4" />
                <button onClick={() => toggleSort("vendorName")} className="flex items-center gap-0.5 flex-1 min-w-0 text-left hover:text-zinc-300">
                    Vendor <SortIcon k="vendorName" />
                </button>
                <button onClick={() => toggleSort("grade")} className="flex items-center gap-0.5 w-7 text-center hover:text-zinc-300">
                    Gr <SortIcon k="grade" />
                </button>
                <button onClick={() => toggleSort("replyRate")} className="flex items-center gap-0.5 w-9 text-right hover:text-zinc-300">
                    Reply <SortIcon k="replyRate" />
                </button>
                <button onClick={() => toggleSort("onTimeRate")} className="flex items-center gap-0.5 w-9 text-right hover:text-zinc-300">
                    OnTm <SortIcon k="onTimeRate" />
                </button>
                <button onClick={() => toggleSort("invoiceAccuracy")} className="flex items-center gap-0.5 w-9 text-right hover:text-zinc-300">
                    Inv <SortIcon k="invoiceAccuracy" />
                </button>
                <button onClick={() => toggleSort("avgReplyHours")} className="flex items-center gap-0.5 w-9 text-right hover:text-zinc-300">
                    Spd <SortIcon k="avgReplyHours" />
                </button>
                <button onClick={() => toggleSort("poCount")} className="flex items-center gap-0.5 w-6 text-right hover:text-zinc-300">
                    # <SortIcon k="poCount" />
                </button>
            </div>

            {/* Rows */}
            <div className="overflow-y-auto max-h-[480px]">
                {loading && rows.length === 0 && (
                    <div className="px-3 py-6 text-[10px] font-mono text-zinc-600 text-center">Loading vendor data…</div>
                )}
                {filtered.length === 0 && !loading && (
                    <div className="px-3 py-6 text-[10px] font-mono text-zinc-600 text-center">
                        {search ? "No vendors match your filter" : "No vendor data yet — run /purchasing to populate"}
                    </div>
                )}
                {filtered.map(v => {
                    const isExpanded = expanded.has(v.vendorName);
                    return (
                        <div key={v.vendorName} className="border-b border-zinc-800/30">
                            <button
                                onClick={() => {
                                    const next = new Set(expanded);
                                    isExpanded ? next.delete(v.vendorName) : next.add(v.vendorName);
                                    setExpanded(next);
                                }}
                                className="w-full px-3 py-1.5 flex items-center gap-1 text-left hover:bg-zinc-800/30 transition-colors"
                            >
                                <span className="w-4 shrink-0">
                                    {isExpanded ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-600" />}
                                </span>
                                <span className="flex-1 min-w-0 text-[10px] font-mono text-zinc-200 truncate">
                                    {v.vendorName}
                                </span>
                                <span className={`w-7 text-center text-[9px] font-mono font-bold px-1 py-0.5 rounded border ${GRADE_COLORS[v.grade || "?"] || "bg-zinc-800 text-zinc-500 border-zinc-700"}`}>
                                    {v.grade || "?"}
                                </span>
                                <span className="w-9 text-right text-[9px] font-mono text-zinc-400">{pct(v.replyRate)}</span>
                                <span className="w-9 text-right text-[9px] font-mono text-zinc-400">{pct(v.onTimeRate)}</span>
                                <span className="w-9 text-right text-[9px] font-mono text-zinc-400">{pct(v.invoiceAccuracy)}</span>
                                <span className="w-9 text-right text-[9px] font-mono text-zinc-400">{hours(v.avgReplyHours)}</span>
                                <span className="w-6 text-right text-[9px] font-mono text-zinc-500">{v.poCount}</span>
                            </button>
                            {isExpanded && (
                                <div className="px-3 py-2 bg-zinc-900/40 border-t border-zinc-800/30 space-y-1.5 text-[9px] font-mono">
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                        <div className="text-zinc-500">Reply Rate</div>
                                        <div className="text-zinc-300">{pct(v.replyRate)} {v.avgReplyHours != null && <span className="text-zinc-600">(median {hours(v.avgReplyHours)})</span>}</div>
                                        <div className="text-zinc-500">On-Time Delivery</div>
                                        <div className="text-zinc-300">{pct(v.onTimeRate)} {v.avgDaysToDelivery != null && <span className="text-zinc-600">(median {days(v.avgDaysToDelivery)})</span>}</div>
                                        <div className="text-zinc-500">Invoice Accuracy</div>
                                        <div className="text-zinc-300">{pct(v.invoiceAccuracy)}</div>
                                        <div className="text-zinc-500">Non-Responsive</div>
                                        <div className={v.noncommRate != null && v.noncommRate > 0.2 ? "text-rose-400" : "text-zinc-300"}>
                                            {pct(v.noncommRate)} {v.noncommRate != null && v.noncommRate > 0.2 && <span>⚠</span>}
                                        </div>
                                        <div className="text-zinc-500">POs in Window</div>
                                        <div className="text-zinc-300">{v.poCount}</div>
                                        <div className="text-zinc-500">Window</div>
                                        <div className="text-zinc-500">{new Date(v.windowStart).toLocaleDateString()} → {new Date(v.windowEnd).toLocaleDateString()}</div>
                                    </div>
                                    {/* Grade breakdown */}
                                    <div className="mt-1.5 pt-1.5 border-t border-zinc-800/40">
                                        <span className="text-zinc-600">Grade: </span>
                                        <span className={`text-[10px] font-bold ${v.grade === "A" ? "text-emerald-400" : v.grade === "F" ? "text-rose-400" : "text-amber-400"}`}>
                                            {v.grade || "N/A"}
                                        </span>
                                        {v.grade === "F" && <span className="text-rose-400 ml-1">— consider alternate vendor</span>}
                                        {v.grade === "D" && <span className="text-orange-400 ml-1">— unreliable, monitor closely</span>}
                                        {v.grade === "A" && <span className="text-emerald-400 ml-1">— preferred vendor</span>}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </SortablePanel>
    );
}
