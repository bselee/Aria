"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle, ChevronDown, ChevronRight, FileText, RefreshCw, Trash2, XCircle, Zap } from "lucide-react";
import type { ApHealthResponse } from "@/app/api/dashboard/ap-health/route";

// ── Styles ────────────────────────────────────────────────────────────────────

const card = "bg-zinc-900/40 border border-zinc-800/60 rounded-lg p-3";
const label = "text-[10px] uppercase tracking-widest text-zinc-500";
const value = "text-lg font-bold text-zinc-100 mt-0.5";
const actionBtn = "px-2 py-1 rounded text-[11px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500/50 border";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StuckInvoice {
    subject: string;
    from: string;
    status: string;
    ageHours: number;
    message_id?: string | null;
}

interface SenderPattern {
    domain: string;
    sender: string;
    stuck: StuckInvoice[];
    suggestedAction: "autopay" | "dropship" | "retry";
    suggestedLabel?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtPct(n: number): string { return `${n}%`; }

function extractDomain(from: string): string | null {
    const match = from.match(/@([a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,}))/);
    return match ? match[1] : null;
}

function extractLabel(from: string): string {
    // "Name <email@domain>" -> "Name"; "email@domain" -> "email"
    const nameMatch = from.match(/^([^<]+)</);
    if (nameMatch) return nameMatch[1].trim();
    const atMatch = from.match(/^([^@]+)@/);
    return atMatch ? atMatch[1] : from;
}

function detectPatterns(stuck: StuckInvoice[]): SenderPattern[] {
    const byDomain = new Map<string, StuckInvoice[]>();
    for (const inv of stuck) {
        const domain = extractDomain(inv.from);
        if (!domain) continue;
        const list = byDomain.get(domain) || [];
        list.push(inv);
        byDomain.set(domain, list);
    }

    const patterns: SenderPattern[] = [];
    for (const [domain, items] of byDomain) {
        if (items.length < 2) continue;

        // Heuristics for suggested actions
        const domainLower = domain.toLowerCase();
        let action: "autopay" | "dropship" | "retry" = "retry";
        let suggestedLabel: string | undefined;

        // Known autopay patterns
        if (
            domainLower.includes("fedex") ||
            domainLower.includes("terminix") ||
            domainLower.includes("culligan") ||
            domainLower.includes("intuit") // QuickBooks invoices
        ) {
            action = "autopay";
            suggestedLabel = extractLabel(items[0].from);
        }
        // Known dropship patterns
        else if (
            domainLower.includes("autopot") ||
            domainLower.includes("loganlab") ||
            domainLower.includes("quickbooks")
        ) {
            action = "dropship";
            suggestedLabel = extractLabel(items[0].from);
        }
        // Default: suggest retry
        else {
            action = "retry";
        }

        patterns.push({
            domain,
            sender: items[0].from,
            stuck: items,
            suggestedAction: action,
            suggestedLabel,
        });
    }

    return patterns;
}

function formatRuleCode(rule: { match: Record<string, string>; action: string; label: string }): string {
    const matchEntries = Object.entries(rule.match)
        .map(([k, v]) => `${k}: '${v}'`)
        .join(", ");
    return `    { match: { ${matchEntries} }, action: '${rule.action}', label: '${rule.label}' },`;
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

// ── Action Button Component ───────────────────────────────────────────────────

function ActionButton({
    label,
    icon,
    onClick,
    variant = "primary",
    disabled = false,
}: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    variant?: "primary" | "danger" | "success" | "warning";
    disabled?: boolean;
}) {
    const variants = {
        primary: "bg-blue-500/20 text-blue-300 border-blue-500/40 hover:bg-blue-500/30",
        danger: "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30",
        success: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30",
        warning: "bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30",
    };
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`${actionBtn} ${variants[variant]} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
            {icon} <span className="ml-1">{label}</span>
        </button>
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
    const [actionInFlight, setActionInFlight] = useState<string | null>(null);
    const [actionFeedback, setActionFeedback] = useState<{ ok: boolean; message: string } | null>(null);

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

    // ── Pattern Detection ─────────────────────────────────────────────────────
    const patterns = useMemo(() => {
        if (!data?.recentStuck) return [];
        return detectPatterns(data.recentStuck as StuckInvoice[]);
    }, [data?.recentStuck]);

    // ── Proactive Action Handlers ─────────────────────────────────────────────

    const handleRetryInvoice = async (messageId: string) => {
        setActionInFlight(`retry-${messageId}`);
        setActionFeedback(null);
        try {
            const res = await fetch("/api/dashboard/ap-actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "retry-invoice", message_id: messageId }),
            });
            const json = await res.json();
            setActionFeedback({ ok: json.success, message: json.message });
            if (json.success) {
                // Refresh data after successful action
                setTimeout(fetchData, 1500);
            }
        } catch (err: any) {
            setActionFeedback({ ok: false, message: err.message });
        } finally {
            setActionInFlight(null);
        }
    };

    const handleSuggestRule = async (pattern: SenderPattern) => {
        if (!pattern.suggestedLabel) return;
        setActionInFlight(`rule-${pattern.domain}`);
        setActionFeedback(null);
        try {
            const res = await fetch("/api/dashboard/ap-actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "mark-autopay",
                    sender: pattern.sender,
                    label: pattern.suggestedLabel,
                }),
            });
            const json = await res.json();
            setActionFeedback({ ok: json.success, message: json.message });
        } catch (err: any) {
            setActionFeedback({ ok: false, message: err.message });
        } finally {
            setActionInFlight(null);
        }
    };

    const handleCleanZombies = async () => {
        setActionInFlight("clean-zombies");
        setActionFeedback(null);
        try {
            const res = await fetch("/api/dashboard/ap-actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "clean-zombies", days_old: 7, limit: 50 }),
            });
            const json = await res.json();
            setActionFeedback({ ok: json.success, message: json.message });
            if (json.success) {
                setTimeout(fetchData, 1500);
            }
        } catch (err: any) {
            setActionFeedback({ ok: false, message: err.message });
        } finally {
            setActionInFlight(null);
        }
    };

    // ── Status config ──────────────────────────────────────────────────────────
    const statusCfg: Record<string, { icon: any; color: string; bg: string; label: string }> = {
        healthy: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", label: "Healthy" },
        degraded: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", label: "Degraded" },
        critical: { icon: XCircle, color: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/20", label: "Critical" },
    };
    const sc = data ? statusCfg[data.status] : statusCfg.healthy;
    const StatusIcon = sc.icon;

    // ── Intent emoji map ────────────────────────────────────────────────────
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

                    {/* ── Action feedback ─────────────────────────────────────── */}
                    {actionFeedback && (
                        <div className={`text-xs p-2 rounded font-mono whitespace-pre-wrap ${
                            actionFeedback.ok
                                ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
                                : "text-red-400 bg-red-500/10 border border-red-500/20"
                        }`}>
                            <button
                                onClick={() => setActionFeedback(null)}
                                className="float-right text-zinc-500 hover:text-zinc-300 ml-2"
                            >
                                ×
                            </button>
                            {actionFeedback.ok ? "✅" : "❌"} {actionFeedback.message}
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

                            {/* ── Pattern Detection (Proactive) ─────────────── */}
                            {patterns.length > 0 && (
                                <div className="space-y-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                                        <div className={`${label} text-amber-400`}>Pattern Detected — Suggested Fixes</div>
                                    </div>
                                    {patterns.map((p) => {
                                        const rule = p.suggestedAction === "autopay" || p.suggestedAction === "dropship"
                                            ? {
                                                  match: { senderContains: p.domain.toLowerCase() },
                                                  action: p.suggestedAction,
                                                  label: `${p.suggestedLabel} (${p.suggestedAction === "autopay" ? "Autopay" : "Dropship"})`,
                                              }
                                            : null;

                                        return (
                                            <div key={p.domain} className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-2.5 space-y-2">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-zinc-300 font-mono">{p.domain}</span>
                                                    <span className="text-rose-400 font-bold">{p.stuck.length}× stuck</span>
                                                </div>

                                                {rule && (
                                                    <>
                                                        <div className="font-mono text-[10px] text-zinc-400 bg-zinc-950/60 rounded p-2 border border-zinc-800/40 overflow-x-auto">
                                                            {formatRuleCode(rule)}
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <ActionButton
                                                                label="Create Rule"
                                                                icon={<Zap className="w-3 h-3" />}
                                                                onClick={() => handleSuggestRule(p)}
                                                                variant="warning"
                                                                disabled={actionInFlight === `rule-${p.domain}`}
                                                            />
                                                            <ActionButton
                                                                label="Retry All"
                                                                icon={<RefreshCw className="w-3 h-3" />}
                                                                onClick={() => p.stuck.forEach(s => s.message_id && handleRetryInvoice(s.message_id!))}
                                                                variant="success"
                                                                disabled={actionInFlight !== null}
                                                            />
                                                        </div>
                                                    </>
                                                )}

                                                {!rule && (
                                                    <ActionButton
                                                        label="Retry All Stuck"
                                                        icon={<RefreshCw className="w-3 h-3" />}
                                                        onClick={() => p.stuck.forEach(s => s.message_id && handleRetryInvoice(s.message_id!))}
                                                        variant="success"
                                                        disabled={actionInFlight !== null}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Stuck Items with Retry */}
                            {data.stuck > 0 && data.recentStuck && data.recentStuck.length > 0 && (
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs font-semibold text-rose-400">🚨 Stuck Invoices</div>
                                        <div className="flex gap-2">
                                            <ActionButton
                                                label="Clean Zombies"
                                                icon={<Trash2 className="w-3 h-3" />}
                                                onClick={handleCleanZombies}
                                                variant="danger"
                                                disabled={actionInFlight !== null}
                                            />
                                        </div>
                                    </div>
                                    {data.recentStuck.map((s: any, i: number) => (
                                        <div key={i} className="text-[11px] text-zinc-400 border-l-2 border-rose-500/40 pl-2 py-1 flex items-center justify-between gap-2">
                                            <div className="flex-1 min-w-0 truncate">
                                                <span className="text-zinc-300">{s.from}</span>
                                                <span className="text-zinc-500"> — {(s.subject || "").slice(0, 40)}</span>
                                                <span className="text-rose-400 ml-1">({s.ageHours}h, {s.status})</span>
                                            </div>
                                            {s.message_id && (
                                                <ActionButton
                                                    label="Retry"
                                                    icon={<RefreshCw className={`w-3 h-3 ${actionInFlight === `retry-${s.message_id}` ? "animate-spin" : ""}`} />}
                                                    onClick={() => handleRetryInvoice(s.message_id)}
                                                    variant="primary"
                                                    disabled={actionInFlight !== null}
                                                />
                                            )}
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
