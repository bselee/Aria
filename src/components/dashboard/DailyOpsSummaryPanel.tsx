"use client";

/**
 * @file    DailyOpsSummaryPanel.tsx
 * @purpose Dashboard panel showing today's email volume, AP invoices processed,
 *          POs created/sent, tracking updates, and cron health at a glance.
 * @author  Hermia
 * @created 2026-05-29
 */
import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Mail, FileText, Package, Clock, AlertTriangle, CheckCircle } from "lucide-react";

interface OpsSummary {
    date: string;
    emails: { received: number };
    ap: { queued: number; forwarded: number; reconciled: number; rejected: number; duplicate: number };
    purchasing: { posCreated: number; posSent: number; receivings: number };
    cron: { totalRuns: number; failedJobs: string[]; successJobs: number };
}

export default function DailyOpsSummaryPanel() {
    const [data, setData] = useState<OpsSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchSummary = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/dashboard/daily-ops-summary?bust=" + Date.now());
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setData(json);
            setError(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchSummary(); }, [fetchSummary]);

    return (
        <div className="flex flex-col h-full p-4 overflow-auto">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">Daily Ops Summary</h2>
                <button onClick={fetchSummary} disabled={loading} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50">
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
            </div>

            {error && <div className="text-rose-400 text-xs mb-3">⚠ {error}</div>}
            {!data && loading && <div className="text-zinc-500 text-xs">Loading...</div>}

            {data && (
                <div className="space-y-4">
                    {/* Email Volume */}
                    <Section icon={<Mail className="w-4 h-4" />} title="Email">
                        <Metric label="Received" value={data.emails.received} />
                    </Section>

                    {/* AP Pipeline */}
                    <Section icon={<FileText className="w-4 h-4" />} title="Accounts Payable">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <Metric label="Queued" value={data.ap.queued} />
                            <Metric label="Forwarded" value={data.ap.forwarded} color="text-emerald-400" />
                            <Metric label="Reconciled" value={data.ap.reconciled} color="text-cyan-400" />
                            <Metric label="Rejected" value={data.ap.rejected} color={data.ap.rejected > 0 ? "text-rose-400" : undefined} />
                            <Metric label="Duplicate" value={data.ap.duplicate} color="text-zinc-500" />
                        </div>
                    </Section>

                    {/* Purchasing */}
                    <Section icon={<Package className="w-4 h-4" />} title="Purchasing">
                        <div className="grid grid-cols-3 gap-x-4 gap-y-1">
                            <Metric label="Created" value={data.purchasing.posCreated} />
                            <Metric label="Sent" value={data.purchasing.posSent} color="text-blue-400" />
                            <Metric label="Received" value={data.purchasing.receivings} color="text-emerald-400" />
                        </div>
                    </Section>

                    {/* Cron Health */}
                    <Section icon={<Clock className="w-4 h-4" />} title={`Cron (${data.cron.totalRuns} runs today)`}>
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-mono text-emerald-400">{data.cron.successJobs} ok</span>
                            {data.cron.failedJobs.length > 0 ? (
                                <span className="text-xs font-mono text-rose-400 flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3" />
                                    {data.cron.failedJobs.length} failed: {data.cron.failedJobs.slice(0, 3).join(", ")}
                                    {data.cron.failedJobs.length > 3 && ` +${data.cron.failedJobs.length - 3}`}
                                </span>
                            ) : (
                                <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3" /> All clear
                                </span>
                            )}
                        </div>
                    </Section>
                </div>
            )}
        </div>
    );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <div className="border border-zinc-800/60 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2 text-zinc-300">
                {icon}
                <span className="text-xs font-semibold uppercase tracking-wide">{title}</span>
            </div>
            {children}
        </div>
    );
}

function Metric({ label, value, color }: { label: string; value: number; color?: string }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono text-zinc-500">{label}</span>
            <span className={`text-sm font-bold font-mono ${color || "text-zinc-200"}`}>{value}</span>
        </div>
    );
}
