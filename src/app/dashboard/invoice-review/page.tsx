/**
 * @file    page.tsx
 * @purpose Dedicated full-width invoice approval review page. Side-by-side
 *          invoice-vs-PO comparison for AP reconciliation decisions —
 *          replaces the compressed-text-in-a-feed pattern in
 *          InvoiceQueuePanel for the actual decision-making moment.
 *          Zero new backend: reuses GET /api/dashboard/invoice-queue and
 *          POST /api/dashboard/reconciliation-action verbatim.
 * @author  Hermia (Aria)
 * @created 2026-07-24
 * @deps    React, next/link, lucide-react, PanelErrorBoundary
 * @env     none (client-side fetch against existing dashboard API routes)
 *
 * DECISION(2026-07-24): Built per docs/dashboard-design-audit.md backlog
 * item 11, sequenced after PanelErrorBoundary (P0-1) and the --dash-l1/l2/l3
 * Tailwind tokens (P1-1) landed. Also applies the P2-2 bounded-loading-state
 * pattern (12s timeout → error/retry) since this page fetches from the same
 * PostgREST/Finale stack documented elsewhere as flaky under load.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    PauseCircle,
    XCircle,
    Shuffle,
    ExternalLink,
    FileText,
} from "lucide-react";
import { PanelErrorBoundary } from "@/components/dashboard/command-board/PanelErrorBoundary";
import type { InvoiceQueueItem, InvoiceQueueResponse } from "@/app/api/dashboard/invoice-queue/route";

// ── Loading-timeout config (P2-2 pattern) ───────────────────────────────────
const LOAD_TIMEOUT_MS = 12_000;

// ── Types ────────────────────────────────────────────────────────────────────

type PriceChangeRow = {
    productId?: string;
    description?: string;
    // Mapped shape (from reconciliation-action's stored metadata):
    from?: number;
    to?: number;
    pct?: number;
    // Raw reconciler shape (PriceChange interface in reconciler.ts):
    poPrice?: number;
    invoicePrice?: number;
    percentChange?: number;
    quantity?: number;
    receivedQty?: number;
    receivingGap?: number;
    verdict?: string;
    reason?: string;
};

type FeeChangeRow = {
    feeType?: string;
    type?: string;
    description?: string;
    from?: number;
    to?: number;
    amount?: number;
    existingAmount?: number;
    isNew?: boolean;
    verdict?: string;
};

/** Normalizes the two price-change shapes that show up in metadata into one. */
function normalizePriceChange(pc: PriceChangeRow) {
    const from = pc.from ?? pc.poPrice ?? 0;
    const to = pc.to ?? pc.invoicePrice ?? 0;
    const pct = pc.pct ?? (pc.percentChange !== undefined ? pc.percentChange * 100 : 0);
    return {
        productId: pc.productId ?? "",
        description: pc.description ?? pc.productId ?? "Unknown item",
        from,
        to,
        pct,
        verdict: pc.verdict ?? "needs_approval",
        reason: pc.reason,
        quantity: pc.quantity,
        receivedQty: pc.receivedQty,
        receivingGap: pc.receivingGap,
    };
}

function normalizeFeeChange(fc: FeeChangeRow) {
    const from = fc.from ?? fc.existingAmount ?? 0;
    const to = fc.to ?? fc.amount ?? 0;
    return {
        label: fc.description ?? fc.feeType ?? fc.type ?? "Fee",
        from,
        to,
        isNew: fc.isNew ?? from === 0,
        verdict: fc.verdict ?? "needs_approval",
    };
}

function fmtDollars(n: number): string {
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function verdictBadgeClasses(verdict: string): string {
    switch (verdict) {
        case "auto_approve":
            return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
        case "needs_approval":
            return "text-amber-400 bg-amber-500/10 border-amber-500/20";
        case "short_shipment_hold":
            return "text-orange-400 bg-orange-500/10 border-orange-500/20";
        case "rejected":
            return "text-rose-400 bg-rose-500/10 border-rose-500/20";
        default:
            return "text-dash-l3 bg-zinc-700/20 border-zinc-700/30";
    }
}

// ── Loading state with bounded timeout (P2-2) ───────────────────────────────

type LoadState = "loading" | "ready" | "timeout" | "error";

function useInvoiceQueue() {
    const [state, setState] = useState<LoadState>("loading");
    const [invoices, setInvoices] = useState<InvoiceQueueItem[]>([]);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback((bust = false) => {
        if (bust) setRefreshing(true);
        else setState("loading");
        setErrorMsg(null);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            setState((prev) => (prev === "loading" ? "timeout" : prev));
        }, LOAD_TIMEOUT_MS);

        fetch(bust ? "/api/dashboard/invoice-queue?bust=1" : "/api/dashboard/invoice-queue", {
            signal: controller.signal,
            cache: "no-store",
        })
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json() as Promise<InvoiceQueueResponse>;
            })
            .then((data) => {
                clearTimeout(timeoutId);
                setInvoices(data.invoices ?? []);
                setState("ready");
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                if (err?.name === "AbortError") {
                    setState("timeout");
                    return;
                }
                setErrorMsg(err instanceof Error ? err.message : String(err));
                setState("error");
            })
            .finally(() => setRefreshing(false));

        return () => {
            clearTimeout(timeoutId);
            controller.abort();
        };
    }, []);

    useEffect(() => {
        const cleanup = load(false);
        const interval = setInterval(() => load(true), 30_000);
        return () => {
            cleanup?.();
            clearInterval(interval);
        };
    }, [load]);

    return { state, invoices, errorMsg, refreshing, reload: load };
}

// ── Bounded loading / error / empty states (P2-2 pattern) ──────────────────

function LoadingSkeleton() {
    return (
        <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton-shimmer h-14 rounded" />
            ))}
        </div>
    );
}

function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center h-full p-6 gap-2 text-center">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span className="text-dash-l1 text-sm">Couldn't load the approval queue</span>
            <span className="text-dash-l2 text-xs max-w-sm">{message}</span>
            <button
                type="button"
                onClick={onRetry}
                className="mt-2 px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-dash-l2 border border-zinc-700 text-xs inline-flex items-center gap-1.5"
            >
                <RefreshCw className="w-3 h-3" />
                Retry
            </button>
        </div>
    );
}

// ── Queue rail row ───────────────────────────────────────────────────────────

function QueueRow({
    item,
    active,
    onClick,
}: {
    item: InvoiceQueueItem;
    active: boolean;
    onClick: () => void;
}) {
    const isShortShip = item.status === "short_shipment_hold";
    const dotClass = isShortShip ? "bg-orange-500 animate-pulse" : "bg-amber-400 animate-pulse";

    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/60 transition-colors ${
                active ? "bg-zinc-800/80 border-l-2 border-l-amber-400" : "hover:bg-zinc-900/60 border-l-2 border-l-transparent"
            }`}
        >
            <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
                <span className="text-dash-l1 text-sm font-medium truncate">{item.vendorName}</span>
            </div>
            <div className="flex items-center justify-between mt-0.5 pl-3">
                <span className="text-dash-l2 text-xs font-mono">
                    #{item.invoiceNumber} · {fmtDollars(item.total)}
                </span>
                <span className="text-dash-l3 text-[10px] font-mono uppercase">{timeAgo(item.processedAt)}</span>
            </div>
            {item.dollarImpact !== null && item.dollarImpact !== 0 && (
                <div className="pl-3 mt-0.5">
                    <span className="text-[10px] font-mono text-amber-400">
                        Δ {fmtDollars(item.dollarImpact)}
                    </span>
                </div>
            )}
        </button>
    );
}

// ── Focused review pane ───────────────────────────────────────────────────

function FocusedReview({
    item,
    onAction,
    actingOn,
}: {
    item: InvoiceQueueItem;
    onAction: (action: "approve" | "pause" | "dismiss" | "rematch", rematchPo?: string) => void;
    actingOn: boolean;
}) {
    const [rematchInput, setRematchInput] = useState("");
    const [showRematch, setShowRematch] = useState(false);

    const metadata = (item.metadata ?? {}) as Record<string, any>;
    const priceChanges = ((metadata.priceChanges ?? []) as PriceChangeRow[]).map(normalizePriceChange);
    const feeChanges = ((metadata.feeChanges ?? []) as FeeChangeRow[]).map(normalizeFeeChange);
    const warnings: string[] = metadata.warnings ?? metadata.balanceCheck?.message
        ? [metadata.balanceCheck?.message].filter(Boolean)
        : [];
    const verdict = metadata.overallVerdict ?? metadata.verdict ?? item.status;

    const meaningfulPrices = priceChanges.filter((pc) => pc.verdict !== "no_change" && pc.verdict !== "no_match");
    const shortShipLines = priceChanges.filter((pc) => pc.verdict === "short_shipment_hold");

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-6 py-4 border-b border-zinc-800 shrink-0">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-dash-l1 text-lg font-semibold">{item.vendorName}</span>
                            <span className="text-dash-l2 text-sm font-mono">— Invoice #{item.invoiceNumber}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                            {item.poNumber && (
                                <span className="text-dash-l2 text-xs font-mono">
                                    PO #{item.poNumber}
                                </span>
                            )}
                            <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${verdictBadgeClasses(
                                    verdict,
                                )}`}
                            >
                                {String(verdict).replace(/_/g, " ")}
                            </span>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-dash-l1 text-xl font-mono font-semibold">{fmtDollars(item.total)}</div>
                        {item.dollarImpact !== null && item.dollarImpact !== 0 && (
                            <div className="text-amber-400 text-xs font-mono">
                                Impact: {fmtDollars(item.dollarImpact)}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Two-column diff */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
                {meaningfulPrices.length === 0 && feeChanges.length === 0 && shortShipLines.length === 0 && (
                    <div className="text-dash-l2 text-sm italic py-8 text-center">
                        No line-item differences recorded for this invoice — reasoning may be summarized in the
                        activity log only.
                    </div>
                )}

                {shortShipLines.length > 0 && (
                    <div className="mb-6">
                        <div className="text-dash-l3 uppercase tracking-wider text-[10px] mb-2 font-semibold flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                            Quantity Discrepancies (Short Shipments)
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            {shortShipLines.map((pc, i) => {
                                const gap = pc.receivingGap ?? Math.max(0, (pc.quantity ?? 0) - (pc.receivedQty ?? 0));
                                return (
                                    <div
                                        key={i}
                                        className="col-span-2 bg-orange-500/5 border border-orange-500/20 rounded p-3"
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="text-dash-l1 text-sm font-medium">{pc.description}</span>
                                            <span className="text-rose-400 text-sm font-mono">
                                                -{gap} unit{gap !== 1 ? "s" : ""}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-dash-l2 text-xs font-mono mt-1">
                                            <span>
                                                Invoiced {pc.quantity} · Received {pc.receivedQty ?? 0}
                                            </span>
                                            <span>Unit {fmtDollars(pc.to)}</span>
                                        </div>
                                        {pc.reason && (
                                            <div className="text-dash-l3 text-[10px] italic mt-1">{pc.reason}</div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {meaningfulPrices.length > 0 && (
                    <div className="mb-6">
                        <div className="text-dash-l3 uppercase tracking-wider text-[10px] mb-2 font-semibold">
                            Line Item Price Changes
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 text-[10px] text-dash-l3 uppercase tracking-wider mb-1 px-1">
                            <span>Invoice (what they billed)</span>
                            <span>PO (what we expected)</span>
                        </div>
                        <div className="space-y-1.5">
                            {meaningfulPrices.map((pc, i) => (
                                <div
                                    key={i}
                                    className="grid grid-cols-2 gap-x-4 items-center bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2"
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="text-dash-l1 text-sm truncate max-w-[160px]" title={pc.description}>
                                            {pc.description}
                                        </span>
                                        <span className="text-dash-l1 text-sm font-mono">{fmtDollars(pc.to)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-dash-l2 text-sm font-mono">{fmtDollars(pc.from)}</span>
                                        <span
                                            className={`text-[10px] font-mono flex items-center gap-1 ${
                                                pc.pct > 0 ? "text-rose-400" : "text-emerald-400"
                                            }`}
                                        >
                                            <AlertTriangle className="w-3 h-3" />
                                            {pc.pct > 0 ? "+" : ""}
                                            {pc.pct.toFixed(1)}%
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {feeChanges.length > 0 && (
                    <div className="mb-6">
                        <div className="text-dash-l3 uppercase tracking-wider text-[10px] mb-2 font-semibold">
                            Fee / Charge Updates
                        </div>
                        <div className="space-y-1.5">
                            {feeChanges.map((fc, i) => (
                                <div
                                    key={i}
                                    className="flex items-center justify-between bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2"
                                >
                                    <span className="text-dash-l1 text-sm">{fc.label}</span>
                                    <div className="flex items-center gap-2">
                                        {fc.from > 0 && (
                                            <>
                                                <span className="text-dash-l2 text-sm font-mono">{fmtDollars(fc.from)}</span>
                                                <span className="text-dash-l3">→</span>
                                            </>
                                        )}
                                        <span className="text-dash-l1 text-sm font-mono">{fmtDollars(fc.to)}</span>
                                        {fc.isNew && (
                                            <span className="text-[10px] text-blue-400 uppercase tracking-wider">New</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {warnings.length > 0 && (
                    <div className="mb-6 space-y-1.5">
                        {warnings.map((w, i) => (
                            <div
                                key={i}
                                className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-2 text-amber-300 text-xs"
                            >
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span>{w}</span>
                            </div>
                        ))}
                    </div>
                )}

                {item.balanceWarning && (
                    <div className="mb-6 flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-2 text-amber-300 text-xs">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{item.balanceWarning}</span>
                    </div>
                )}
            </div>

            {/* Action bar */}
            <div className="px-6 py-4 border-t border-zinc-800 shrink-0">
                {showRematch ? (
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={rematchInput}
                            onChange={(e) => setRematchInput(e.target.value)}
                            placeholder="PO number to rematch to…"
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-dash-l1 text-sm font-mono focus:outline-none focus:border-amber-500/50"
                            autoFocus
                        />
                        <button
                            type="button"
                            disabled={!rematchInput.trim() || actingOn}
                            onClick={() => {
                                onAction("rematch", rematchInput.trim());
                                setShowRematch(false);
                                setRematchInput("");
                            }}
                            className="px-3 py-1.5 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 text-xs font-medium disabled:opacity-40"
                        >
                            Confirm
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowRematch(false)}
                            className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-dash-l2 border border-zinc-700 text-xs"
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            type="button"
                            disabled={actingOn}
                            onClick={() => onAction("approve")}
                            className="flex-1 min-w-[120px] px-4 py-2.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                        >
                            <CheckCircle2 className="w-4 h-4" />
                            Approve
                        </button>
                        <button
                            type="button"
                            disabled={actingOn}
                            onClick={() => onAction("pause")}
                            className="flex-1 min-w-[120px] px-4 py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 text-dash-l2 border border-zinc-700 text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                        >
                            <PauseCircle className="w-4 h-4" />
                            Pause
                        </button>
                        <button
                            type="button"
                            disabled={actingOn}
                            onClick={() => setShowRematch(true)}
                            className="flex-1 min-w-[120px] px-4 py-2.5 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                        >
                            <Shuffle className="w-4 h-4" />
                            Rematch
                        </button>
                        <button
                            type="button"
                            disabled={actingOn}
                            onClick={() => onAction("dismiss")}
                            className="flex-1 min-w-[120px] px-4 py-2.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                        >
                            <XCircle className="w-4 h-4" />
                            Dismiss
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function InvoiceReviewPage() {
    const { state, invoices, errorMsg, refreshing, reload } = useInvoiceQueue();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [actingOn, setActingOn] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

    const pending = useMemo(
        () => invoices.filter((i) => i.status === "needs_approval" || i.status === "short_shipment_hold"),
        [invoices],
    );

    const selected = useMemo(
        () => pending.find((i) => i.activityLogId === selectedId) ?? pending[0] ?? null,
        [pending, selectedId],
    );

    useEffect(() => {
        if (!selectedId && pending.length > 0) {
            setSelectedId(pending[0].activityLogId);
        }
    }, [pending, selectedId]);

    const handleAction = useCallback(
        async (action: "approve" | "pause" | "dismiss" | "rematch", rematchPo?: string) => {
            if (!selected?.activityLogId) return;
            setActingOn(true);
            setToast(null);
            try {
                const res = await fetch("/api/dashboard/reconciliation-action", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        activityLogId: selected.activityLogId,
                        action,
                        ...(action === "rematch" ? { rematchPoNumber: rematchPo } : {}),
                    }),
                });
                const data = await res.json();
                if (!res.ok || data.success === false) {
                    setToast({ message: data.error || data.message || "Action failed", type: "error" });
                } else {
                    setToast({ message: data.message || `${action} applied`, type: "success" });
                    setSelectedId(null);
                }
            } catch {
                setToast({ message: "Network error — action may not have applied", type: "error" });
            } finally {
                setActingOn(false);
                reload(true);
                setTimeout(() => setToast(null), 4000);
            }
        },
        [selected, reload],
    );

    return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
            {/* Page header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
                <div>
                    <Link
                        href="/dashboard"
                        className="inline-flex items-center gap-1 text-xs font-mono text-dash-l3 hover:text-dash-l1 transition-colors"
                    >
                        <ArrowLeft className="w-3 h-3" />
                        Dashboard
                    </Link>
                    <h1 className="text-2xl font-semibold text-dash-l1 mt-2">Invoice Review</h1>
                    <p className="text-xs font-mono text-dash-l3 mt-1">
                        {pending.length} pending approval{pending.length === 1 ? "" : "s"}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => reload(true)}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-dash-l2 border border-zinc-700 text-xs"
                >
                    <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                    Refresh
                </button>
            </div>

            {/* Toast */}
            {toast && (
                <div
                    className={`px-6 py-2 text-sm font-mono ${
                        toast.type === "success"
                            ? "bg-emerald-500/10 text-emerald-400 border-b border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-400 border-b border-rose-500/20"
                    }`}
                >
                    {toast.message}
                </div>
            )}

            {/* Body */}
            <div className="flex-1 flex overflow-hidden">
                {state === "loading" && <div className="flex-1"><LoadingSkeleton /></div>}
                {(state === "timeout" || state === "error") && (
                    <div className="flex-1">
                        <LoadErrorState
                            message={
                                state === "timeout"
                                    ? "The approval queue took too long to respond (PostgREST/Finale may be under load)."
                                    : errorMsg ?? "Unknown error"
                            }
                            onRetry={() => reload(false)}
                        />
                    </div>
                )}
                {state === "ready" && pending.length === 0 && (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                            <div className="text-dash-l1 text-sm">Queue is clear</div>
                            <div className="text-dash-l3 text-xs mt-1">No invoices need approval right now.</div>
                        </div>
                    </div>
                )}
                {state === "ready" && pending.length > 0 && (
                    <>
                        {/* Left rail — queue list */}
                        <div className="w-[300px] border-r border-zinc-800 overflow-y-auto shrink-0">
                            {pending.map((item) => (
                                <QueueRow
                                    key={item.activityLogId ?? item.id}
                                    item={item}
                                    active={item.activityLogId === selected?.activityLogId}
                                    onClick={() => setSelectedId(item.activityLogId)}
                                />
                            ))}
                        </div>

                        {/* Focused review — wrapped per audit P0-1 spec */}
                        <div className="flex-1 overflow-hidden">
                            <PanelErrorBoundary label="Invoice Review">
                                {selected ? (
                                    <FocusedReview item={selected} onAction={handleAction} actingOn={actingOn} />
                                ) : (
                                    <div className="flex items-center justify-center h-full text-dash-l3 text-sm">
                                        Select an invoice from the queue
                                    </div>
                                )}
                            </PanelErrorBoundary>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
