"use client";

import React from "react";
import { useEffect, useState } from "react";
import { Activity, CheckCircle, XCircle, AlertTriangle, FileText, ChevronDown, ChevronRight } from "lucide-react";
import type { ApHealthResponse } from "@/app/api/dashboard/ap-health/route";

// ── Styles ────────────────────────────────────────────────────────────────────

const card = "bg-zinc-900/40 border border-zinc-800/60 rounded-lg p-3";
const label = "text-[10px] uppercase tracking-widest text-zinc-500";
const value = "text-lg font-bold text-zinc-100 mt-0.5";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtPct(n: number): string {
    return `${n}%`;
}

// ── Card Component ────────────────────────────────────────────────────────────

function StatCard({ icon, label: lbl, value: val, accent }: { icon: React.ReactNode; label: string; value: string | number; accent: string }) {
    return (
        <div className={`${card} flex items-center gap-3`}>
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accent}`}>
                {icon}
            </div>
            <div className="min-w-0">
                <div className={label}>{lbl}</div>
                <div className={value}>{val}</div>
            </div>
        </div>
    );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function APHealthPanel() {
    const [data, setData] = useState<ApHealthResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem("aria-dash-ap-health-collapsed") === "true"; } catch { return false; }
    });

    const fetchData = async () => {
        try {
            const res = await fetch(`/api/dashboard/ap-health?bust=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: ApHealthResponse = await res.json();
            setData(json);
            setError(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 60000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        try { localStorage.setItem("aria-dash-ap-health-collapsed", String(collapsed)); } catch { /* noop */ }
    }, [collapsed]);

    // ── Status config ──────────────────────────────────────────────────────────
    const statusCfg = {
        healthy: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", label: "Healthy" },
        degraded: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", label: "Degraded" },
        critical: { icon: XCircle, color: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/20", label: "Critical" },
    };
    const sc = data ? statusCfg[data.status] : statusCfg.healthy;
    const StatusIcon = sc.icon;

    // ── Intent emoji map ────────────────────────────────────────────────────────
    const intentEmoji: Record<string, string> = {
        INVOICE: "📩", BILL_FORWARD: "➡️", DROPSHIP: "📦", OCR_RETRY: "🔍",
        RECONCILIATION: "✅", PAID_INVOICE: "💳", STATEMENT: "📋",
        ADVERTISEMENT: "📢", HUMAN_INTERACTION: "👤", BLOCKED_SENDER: "🚫",
        PROCESSING_ERROR: "❌", PO_RECEIVED: "📬", PO_ARRIVAL_AT_RISK: "⚠️",
        EXCEPTION_ESCALATED: "🔴", RECEIPT_PROMPT: "💬", TAX_DOCUMENT: "🧾",
    };

    return (
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-4 space-y-4">
            {/* ── Header ──────────────────────────────────────────────────────── */}
            <button
                onClick={() => setCollapsed(!collapsed)}
                className="w-full flex items-center justify-between text-left"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm font-semibold text-zinc-200">AP Pipeline Health</span>
                    {data && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${sc.bg} ${sc.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {sc.label}
                        </span>
                    )}
                    {loading && <span className="text-[10px] text-zinc-500 animate-pulse">⟳</span>}
                </div>
                {collapsed ? <ChevronRight className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
            </button>

            {!collapsed && (
                <>
                    {/* ── Error state ──────────────────────────────────────────── */}
                    {error && (
                        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 p-2 rounded">
                            ⚠️ Offline — {error}
                        </div>
                    )}

                    {/* ── Loading state ────────────────────────────────────────── */}
                    {loading && !data && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[1, 2, 3, 4].map(i => (
                                <div key={i} className={`${card} animate-pulse`}>
                                    <div className="h-3 w-16 bg-zinc-800 rounded mb-2" />
                                    <div className="h-6 w-10 bg-zinc-800 rounded" />
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ── Data ─────────────────────────────────────────────────── */}
                    {data && (
                        <div className="space-y-4">
                            {/* Summary cards */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                <StatCard
                                    icon={<FileText className="w-4 h-4 text-emerald-400" />}
                                    label="Processed Today" value={data.totalToday}
                                    accent="bg-emerald-500/10"
                                />
                                <StatCard
                                    icon={<CheckCircle className="w-4 h-4 text-blue-400" />}
                                    label="Match Rate" value={fmtPct(data.matchRate)}
                                    accent={data.matchRate >= 90 ? "bg-emerald-500/10" : data.matchRate >= 50 ? "bg-amber-500/10" : "bg-rose-500/10"}
                                />
                                <StatCard
                                    icon={<XCircle className="w-4 h-4 text-rose-400" />}
                                    label="Stuck" value={data.stuck}
                                    accent={data.stuck > 0 ? "bg-rose-500/10" : "bg-zinc-800/40"}
                                />
                                <StatCard
                                    icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}
                                    label="OCR Issues" value={data.ocrIssues}
                                    accent={data.ocrIssues > 0 ? "bg-amber-500/10" : "bg-zinc-800/40"}
                                />
                            </div>

                            {/* Match Rate Bar */}
                            {data.totalToday > 0 && (
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs">
                                        <span className="text-zinc-400">Match Rate</span>
                                        <span className={data.matchRate >= 90 ? "text-emerald-400" : data.matchRate >= 50 ? "text-amber-400" : "text-rose-400"}>
                                            {data.matched} matched / {data.matched + data.unmatched} total
                                        </span>
                                    </div>
                                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full transition-all duration-500 ${
                                                data.matchRate >= 90 ? "bg-emerald-500" : data.matchRate >= 50 ? "bg-amber-500" : "bg-rose-500"
                                            }`}
                                            style={{ width: `${data.matchRate}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Intent Breakdown */}
                            {data.totalToday > 0 && (
                                <div className="space-y-1.5">
                                    <div className={label}>Today's Breakdown</div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                                        {Object.entries(data.todayCounts)
                                            .sort(([, a], [, b]) => b - a)
                                            .slice(0, 12)
                                            .map(([intent, count]) => (
                                                <div key={intent} className="flex items-center gap-1.5 text-xs">
                                                    <span className="text-zinc-500">{intentEmoji[intent] || "•"}</span>
                                                    <span className="text-zinc-300 truncate">{intent}</span>
                                                    <span className="text-zinc-500 ml-auto">{count}</span>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}

                            {/* Stuck Items */}
                            {data.stuck > 0 && data.recentStuck.length > 0 && (
                                <div className="space-y-1.5">
                                    <div className="text-xs font-semibold text-rose-400">🚨 Stuck Invoices</div>
                                    {data.recentStuck.map((s, i) => (
                                        <div key={i} className="text-[11px] text-zinc-400 border-l-2 border-rose-500/40 pl-2">
                                            <span className="text-zinc-300">{s.from}</span>
                                            <span className="text-zinc-500"> — {(s.subject || '').slice(0, 50)}</span>
                                            <span className="text-rose-400"> ({s.ageHours}h, {s.status})</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}