/**
 * @file    DepositMatchPanel.tsx
 * @purpose Dashboard panel for matching Bank of Colorado deposits against
 *          Daily Cash Report sheets and Finaloop Draft Orders.
 *          Advisory only — reads CSVs, shows match suggestions, no writes.
 * @author  Hermia
 * @created 2026-07-16
 * @deps    React, next
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";

/* ────────────────────── Types ────────────────────── */

interface OrderMatchStatus {
    orderName: string;
    sheetAmount: number;
    unpaidBalance: number;
    customer: string;
    isUnpaid: boolean;
    placedDate: string;
    status: string;
}

interface DepositMatchResult {
    sheetLabel: string;
    sheetTotal: number;
    totalSheetOrders: number;
    unpaidOrders: OrderMatchStatus[];
    unpaidTotal: number;
    paidOrders: OrderMatchStatus[];
    paidTotal: number;
    notFoundInFinaloop: { orderName: string; amount: number }[];
    notFoundTotal: number;
    depositAmount: number;
    depositMatchesUnpaid: boolean;
    depositVariance: number;
    recommendation: string;
    matchedSubset?: {
        matchedOrders: OrderMatchStatus[];
        matchedTotal: number;
        remainingDeposit: number;
        unmatchedOrders: OrderMatchStatus[];
        unmatchedTotal: number;
        isExactMatch: boolean;
    };
    finaloopFile: string;
    sheetFile: string;
}

interface FileStatus {
    hasFinaloop: boolean;
    hasSheet: boolean;
    ready: boolean;
    finaloopStats?: { totalOrders: number; draftOrders: number; totalUnpaidBalance: number };
    sheetStats?: { orders: number; total: number };
}

/* ────────────────────── Component ────────────────────── */

export default function DepositMatchPanel() {
    const [depositAmount, setDepositAmount] = useState("");
    const [result, setResult] = useState<DepositMatchResult | null>(null);
    const [fileStatus, setFileStatus] = useState<FileStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState(false);

    // Check file status on mount
    useEffect(() => {
        checkFileStatus();
    }, []);

    const checkFileStatus = useCallback(async () => {
        setChecking(true);
        try {
            const res = await fetch("/api/dashboard/deposit-match");
            if (res.ok) {
                const data = await res.json();
                setFileStatus(data);
            }
        } catch { /* server might not be running */ }
        setChecking(false);
    }, []);

    const handleMatch = useCallback(async () => {
        const amount = parseFloat(depositAmount);
        if (isNaN(amount) || amount <= 0) {
            setError("Enter a valid deposit amount");
            return;
        }

        setLoading(true);
        setError(null);
        setResult(null);

        try {
            const res = await fetch("/api/dashboard/deposit-match", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ depositAmount: amount }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Match failed");
            }

            const data = await res.json();
            setResult(data);
        } catch (err: any) {
            setError(err.message);
        }
        setLoading(false);
    }, [depositAmount]);

    return (
        <div className="flex flex-col h-full text-sm">
            {/* Header bar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <span className="font-semibold text-foreground">
                    💰 Deposit Match
                </span>
                <div className="flex items-center gap-2">
                    <button
                        onClick={checkFileStatus}
                        className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent"
                        title="Refresh file status"
                    >
                        ↻
                    </button>
                    <button
                        onClick={() => setCollapsed(!collapsed)}
                        className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent"
                    >
                        {collapsed ? "▸" : "▾"}
                    </button>
                </div>
            </div>

            {!collapsed && (
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {/* File status */}
                    {checking ? (
                        <div className="text-xs text-muted-foreground animate-pulse">
                            Checking for CSV files...
                        </div>
                    ) : fileStatus ? (
                        <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-2">
                                <span className={fileStatus.hasFinaloop ? "text-emerald-500" : "text-rose-500"}>
                                    {fileStatus.hasFinaloop ? "✅" : "❌"}
                                </span>
                                <span>Finaloop Draft Orders</span>
                                {fileStatus.finaloopStats && (
                                    <span className="text-muted-foreground">
                                        ({fileStatus.finaloopStats.draftOrders} unpaid · $
                                        {fileStatus.finaloopStats.totalUnpaidBalance.toFixed(2)})
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <span className={fileStatus.hasSheet ? "text-emerald-500" : "text-rose-500"}>
                                    {fileStatus.hasSheet ? "✅" : "❌"}
                                </span>
                                <span>Daily Cash Report sheet</span>
                                {fileStatus.sheetStats && (
                                    <span className="text-muted-foreground">
                                        ({fileStatus.sheetStats.orders} orders · $
                                        {fileStatus.sheetStats.total.toFixed(2)})
                                    </span>
                                )}
                            </div>
                            {!fileStatus.ready && (
                                <div className="text-amber-500 mt-1">
                                    ⚠️ Place CSV files in .hermes/desktop-attachments/
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="text-xs text-rose-500">
                            ❌ Could not check file status
                        </div>
                    )}

                    {/* Deposit input */}
                    <div className="flex gap-2">
                        <input
                            type="number"
                            step="0.01"
                            placeholder="Deposit amount ($)"
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleMatch()}
                            className="flex-1 px-3 py-1.5 text-sm border border-border rounded bg-background
                                       text-foreground placeholder:text-muted-foreground
                                       focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <button
                            onClick={handleMatch}
                            disabled={loading || !fileStatus?.ready}
                            className="px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground
                                       hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {loading ? "..." : "Match"}
                        </button>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="p-2 text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/30 rounded border border-rose-200 dark:border-rose-800">
                            {error}
                        </div>
                    )}

                    {/* Results */}
                    {result && (
                        <div className="space-y-3">
                            {/* Summary */}
                            <div className="grid grid-cols-3 gap-2 text-xs">
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">Deposit</div>
                                    <div className="font-semibold text-foreground">
                                        ${result.depositAmount.toFixed(2)}
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">Sheet</div>
                                    <div className="font-semibold text-foreground">
                                        ${result.sheetTotal.toFixed(2)}
                                    </div>
                                    <div className="text-muted-foreground text-[10px]">
                                        {result.totalSheetOrders} orders
                                    </div>
                                </div>
                                <div className="p-2 bg-muted rounded">
                                    <div className="text-muted-foreground">Variance</div>
                                    <div className={`font-semibold ${result.depositMatchesUnpaid ? "text-emerald-500" : "text-amber-500"}`}>
                                        {result.depositMatchesUnpaid ? "✅ Exact" : `$${result.depositVariance.toFixed(2)}`}
                                    </div>
                                </div>
                            </div>

                            {/* Unpaid orders — action items */}
                            {result.unpaidOrders.length > 0 && (
                                <div>
                                    <div className="text-xs font-medium mb-1 flex items-center gap-1">
                                        <span className="text-amber-500">⬜</span>
                                        Unpaid — Match these in Finaloop
                                        <span className="text-muted-foreground ml-auto">
                                            {result.unpaidOrders.length} · ${result.unpaidTotal.toFixed(2)}
                                        </span>
                                    </div>
                                    <div className="space-y-0.5">
                                        {result.unpaidOrders.map((o) => (
                                            <div
                                                key={o.orderName}
                                                className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-accent"
                                            >
                                                <span className="text-muted-foreground w-12 shrink-0">
                                                    {o.orderName}
                                                </span>
                                                <span className="font-medium w-16 text-right shrink-0">
                                                    ${o.unpaidBalance.toFixed(2)}
                                                </span>
                                                <span className="text-muted-foreground truncate flex-1">
                                                    {o.customer}
                                                </span>
                                                <span className="text-muted-foreground text-[10px] w-16 text-right">
                                                    {o.placedDate}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Matched subset (when deposit != unpaid total) */}
                            {result.matchedSubset && !result.depositMatchesUnpaid && result.matchedSubset.matchedOrders.length > 0 && (
                                <div>
                                    <div className="text-xs font-medium mb-1 flex items-center gap-1">
                                        <span className="text-cyan-500">⊞</span>
                                        Best match: ${result.matchedSubset.matchedTotal.toFixed(2)}
                                        {!result.matchedSubset.isExactMatch && (
                                            <span className="text-muted-foreground ml-1">
                                                (${result.matchedSubset.remainingDeposit.toFixed(2)} remaining)
                                            </span>
                                        )}
                                    </div>
                                    <div className="space-y-0.5">
                                        {result.matchedSubset.matchedOrders.map((o) => (
                                            <div
                                                key={`match-${o.orderName}`}
                                                className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-accent"
                                            >
                                                <span className="text-cyan-500">→</span>
                                                <span className="text-muted-foreground w-12">{o.orderName}</span>
                                                <span className="font-medium w-16 text-right">
                                                    ${o.unpaidBalance.toFixed(2)}
                                                </span>
                                                <span className="text-muted-foreground truncate">
                                                    {o.customer}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Already paid */}
                            {result.paidOrders.length > 0 && (
                                <div>
                                    <div className="text-xs font-medium mb-1 text-emerald-500">
                                        ✅ {result.paidOrders.length} already paid — ${result.paidTotal.toFixed(2)}
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {result.paidOrders.map((o) => (
                                            <span key={`paid-${o.orderName}`} className="text-[10px] px-1.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 rounded">
                                                {o.orderName}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Not found */}
                            {result.notFoundInFinaloop.length > 0 && (
                                <div>
                                    <div className="text-xs font-medium mb-1 text-muted-foreground">
                                        ℹ️ {result.notFoundInFinaloop.length} not in Draft Orders (paid via processor)
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {result.notFoundInFinaloop.map((o) => (
                                            <span key={`nf-${o.orderName}`} className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                                                {o.orderName}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Recommendation */}
                            <div className="text-xs p-2 bg-muted rounded text-muted-foreground whitespace-pre-line leading-relaxed">
                                {result.recommendation}
                            </div>

                            {/* File info */}
                            <div className="text-[10px] text-muted-foreground text-right">
                                {result.sheetFile} · {result.finaloopFile}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
