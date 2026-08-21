/**
 * @file    src/components/dashboard/BasautoReconPanel.tsx
 * @purpose Dashboard panel: basauto.vercel.app vs Aria purchasing
 *          reconciliation. Shows why the two systems disagree per SKU —
 *          over-buy risks (committed POs basauto can't see), velocity gaps,
 *          false urgencies, and SKUs missing from Aria's pipeline — so Bill
 *          never has to open basauto himself.
 *
 *          Data: /api/dashboard/basauto-recon (JSON written by the 07:00
 *          Hermes cron via src/cli/basauto-recon.ts). Refreshes every 60s.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    next (use client), React
 * @env     reads /api/dashboard/basauto-recon
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";

type Verdict =
    | "OVERBUY_RISK"
    | "VELOCITY_MISMATCH"
    | "FALSE_URGENT"
    | "BORDERLINE"
    | "MISSING_IN_ARIA"
    | "QTY_MISMATCH"
    | "AGREE"
    | "ARIA_ONLY";

interface ReconItem {
    sku: string;
    vendor: string | null;
    description: string | null;
    verdict: Verdict;
    severity: "high" | "medium" | "low";
    reason: string;
    basauto: {
        urgency: string;
        stockDaysLeft: number | null;
        reorderQty: number | null;
        reorderDate: string | null;
        velocity: number | null;
        onOrder: number | null;
        quantityInDrafts: number | null;
        supplierLeadDays: number | null;
    };
    aria: {
        urgency: string | null;
        runwayDays: number | null;
        dailyRate: number | null;
        stockOnHand: number | null;
        stockOnOrder: number | null;
        poQty: number;
        pos: Array<{ orderId: string; quantity: number }>;
        suggestedQty: number | null;
        leadTimeDays: number | null;
    } | null;
}

interface ReconData {
    report: {
        crawledAt: string;
        source: "api" | "playwright";
        ariaCachedAt: string | null;
        errors: string[];
        summary: {
            flagged: number;
            high: number;
            medium: number;
            low: number;
            byVerdict: Record<Verdict, number>;
            basautoItems: number;
            basautoNonOK: number;
            ariaItems: number;
            ariaNonOK: number;
        };
        items: ReconItem[];
    } | null;
    stale: boolean;
    message?: string;
}

const POLL_INTERVAL = 60_000;

const VERDICT_STYLE: Record<Verdict, { label: string; cls: string }> = {
    OVERBUY_RISK: { label: "OVERBUY RISK", cls: "bg-red-500/20 text-red-400 border-red-500/40" },
    QTY_MISMATCH: { label: "QTY DISAGREE", cls: "bg-orange-500/20 text-orange-400 border-orange-500/40" },
    VELOCITY_MISMATCH: { label: "VELOCITY GAP", cls: "bg-amber-500/20 text-amber-400 border-amber-500/40" },
    FALSE_URGENT: { label: "FALSE URGENCY", cls: "bg-blue-500/20 text-blue-400 border-blue-500/40" },
    BORDERLINE: { label: "BORDERLINE", cls: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40" },
    MISSING_IN_ARIA: { label: "MISSING IN ARIA", cls: "bg-purple-500/20 text-purple-400 border-purple-500/40" },
    ARIA_ONLY: { label: "ARIA-ONLY", cls: "bg-gray-500/20 text-gray-400 border-gray-500/40" },
    AGREE: { label: "AGREE", cls: "bg-green-500/20 text-green-400 border-green-500/40" },
};

const VERDICT_ORDER: Verdict[] = [
    "OVERBUY_RISK",
    "QTY_MISMATCH",
    "VELOCITY_MISMATCH",
    "FALSE_URGENT",
    "BORDERLINE",
    "MISSING_IN_ARIA",
    "ARIA_ONLY",
    "AGREE",
];

const fmt = (n: number | null | undefined): string =>
    n === null || n === undefined ? "?" : n.toLocaleString("en-US");

export default function BasautoReconPanel() {
    const [data, setData] = useState<ReconData | null>(null);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);
    const [filter, setFilter] = useState<"high" | "all">("high");

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch("/api/dashboard/basauto-recon");
            const json = await res.json();
            setData(json);
        } catch {
            // Silent — keep last good data
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchData]);

    if (loading && !data) {
        return (
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
                <h3 className="text-sm font-semibold text-gray-400 mb-2">BASAUTO Recon</h3>
                <p className="text-gray-500 text-xs">Loading...</p>
            </div>
        );
    }

    const report = data?.report ?? null;
    const items = report?.items ?? [];
    const shown = filter === "high" ? items.filter((i) => i.severity === "high") : items;
    const crawledLabel = report
        ? new Date(report.crawledAt).toLocaleString("en-US", {
              weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Denver",
          })
        : "?";

    return (
        <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
            {/* Header */}
            <div
                className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-gray-800/50"
                onClick={() => setCollapsed(!collapsed)}
            >
                <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-gray-300">BASAUTO Recon</h3>
                    {report && (
                        <>
                            <span className="text-xs text-gray-500">
                                {crawledLabel} MT · {report.source} crawl · Aria cache{" "}
                                {report.ariaCachedAt
                                    ? new Date(report.ariaCachedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Denver" })
                                    : "?"}
                            </span>
                            {data?.stale && (
                                <span className="bg-red-500/20 text-red-400 text-xs px-2 py-0.5 rounded-full font-medium">
                                    stale — cron not run
                                </span>
                            )}
                        </>
                    )}
                    {!report && <span className="text-xs text-gray-500">{data?.message ?? "No report"}</span>}
                </div>
                <span className="text-gray-500 text-xs">
                    {report ? `${report.summary.high} high · ${report.summary.medium} review` : ""}
                </span>
            </div>

            {!collapsed && report && (
                <>
                    {/* Verdict chips */}
                    <div className="px-4 pb-2 flex flex-wrap gap-1.5">
                        {VERDICT_ORDER.map((v) => {
                            const count = report.summary.byVerdict[v] ?? 0;
                            if (count === 0) return null;
                            const style = VERDICT_STYLE[v];
                            return (
                                <span key={v} className={`text-[10px] px-1.5 py-0.5 rounded border ${style.cls}`}>
                                    {style.label} {count}
                                </span>
                            );
                        })}
                    </div>

                    {/* Filter + errors */}
                    <div className="px-4 pb-2 flex items-center gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); setFilter(filter === "high" ? "all" : "high"); }}
                            className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-300 hover:bg-gray-700"
                        >
                            {filter === "high" ? "Show all" : "High only"}
                        </button>
                        {report.errors.map((err, i) => (
                            <span key={i} className="text-[10px] text-red-400 truncate" title={err}>
                                ⚠ {err}
                            </span>
                        ))}
                    </div>

                    {/* Items */}
                    <div className="max-h-[420px] overflow-y-auto divide-y divide-gray-800 border-t border-gray-800">
                        {shown.length === 0 && (
                            <p className="text-xs text-gray-500 px-4 py-3">
                                {filter === "high" ? "No high-severity items. Switch to Show all for review items." : "No disagreements."}
                            </p>
                        )}
                        {shown.map((it) => {
                            const style = VERDICT_STYLE[it.verdict];
                            return (
                                <div key={it.sku} className="px-4 py-2.5">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <span className="text-xs font-semibold text-gray-200">{it.sku}</span>
                                            {it.description && (
                                                <span className="text-xs text-gray-500"> — {it.description.slice(0, 60)}</span>
                                            )}
                                        </div>
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${style.cls}`}>
                                            {style.label}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-gray-400 mt-0.5">
                                        basauto {it.basauto.urgency}
                                        {it.basauto.stockDaysLeft !== null && ` · ${fmt(it.basauto.stockDaysLeft)}d left`}
                                        {it.basauto.reorderQty !== null && it.basauto.reorderQty > 0 && ` · wants ${fmt(it.basauto.reorderQty)}`}
                                        {it.aria && (
                                            <>
                                                {" | "}Aria {it.aria.urgency ?? "?"}
                                                {it.aria.runwayDays !== null && ` · ${Math.round(it.aria.runwayDays)}d runway`}
                                                {it.aria.poQty > 0 && ` · ${fmt(it.aria.poQty)} on PO`}
                                            </>
                                        )}
                                    </p>
                                    <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{it.reason}</p>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
