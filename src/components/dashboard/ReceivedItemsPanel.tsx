"use client";

import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown } from "lucide-react";
import { createClient as createBrowserClient } from "@/lib/db";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import InvoicePOMatcher from "./InvoicePOMatcher";

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    receiveDate: string;
    receiveDateTime?: string;
    receivedBy?: string | null;
    receiptStatus?: "full" | "partial" | "received";
    supplier: string;
    total: number;
    items: Array<{
        productId: string;
        quantity: number;
        orderedQuantity?: number;
        receivedQuantity?: number;
        receivedInWindow?: number;
        openQuantity?: number;
    }>;
    receiptHistory?: Array<{
        shipmentId: string;
        receiveDate: string;
        receiveDateTime: string;
        receivedBy?: string | null;
        items: Array<{ productId: string; quantity: number }>;
    }>;
    finaleUrl: string;
    _reconciliation?: {
        invoices: Array<{ invoice_number: string; subtotal: number; freight: number; tax: number; total: number; status: string }>;
        outcomes: Array<{ outcome: string; created_at: string; resolved_at: string | null }>;
        hasPendingApproval: boolean;
        hasAutoApplied: boolean;
        matchedInvoice: { invoice_number: string; subtotal: number; freight: number; tax: number; total: number; status: string; pdf_storage_path?: string | null; source_ref?: string | null } | null;
    };
};

type TrackingTodaySummary = {
    headline: string;
    lines: string[];
} | null;

type MatchSuggestion = {
    invoiceId: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceTotal: number;
    invoiceDate?: string;
    candidates: Array<{
        orderId: string;
        vendorName: string;
        orderDate: string;
        total: number;
        status: string;
        score: number;
        reasons: string[];
        isOpen: boolean;
    }>;
    autoApplyReady: boolean;
    autoMatched?: boolean;
};

type FreightClass = {
    pattern: string;
    confidence: string;
    sampleCount: number;
    source: string;
    autonomousReady: boolean;
};

// Real AP status keyed by Finale orderId
type ApStatusMap = Record<string, { label: string; cls: string }>;

function parseDenverDate(s: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(s: string): string {
    const d = parseDenverDate(s);
    if (!d) return s || '—';
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'America/Denver' };
    const isDateOnly = !s.includes(':');
    const datePart = d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' });
    if (isDateOnly) return datePart;
    const timePart = d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
}

function fmtDollars(n: number): string {
    if (!n || n <= 1) return '';   // skip $0 and $1 placeholder totals
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function getDynamicReceiptStatus(po: ReceivedPO): "full" | "partial" | "received" {
    if (!po.items || po.items.length === 0) {
        return po.receiptStatus || "received";
    }
    const hasDetails = po.items.some(i => i.receivedQuantity !== undefined);
    if (!hasDetails) {
        return po.receiptStatus || "received";
    }
    const isFull = po.items.every(i => {
        const ordered = i.orderedQuantity ?? i.quantity;
        const received = i.receivedQuantity ?? 0;
        return received >= ordered;
    });
    return isFull ? "full" : "partial";
}

function receiptBadge(po: ReceivedPO): { label: string; cls: string } | null {
    const status = getDynamicReceiptStatus(po);
    if (status === "full") {
        return { label: "FULL", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" };
    }
    if (status === "partial") {
        return { label: "PARTIAL", cls: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
    }
    return null;
}

function receiveSortValue(po: ReceivedPO): number {
    const parsed = parseDenverDate(po.receiveDate || po.receiveDateTime);
    return parsed?.getTime() ?? 0;
}

function partialDiscrepancy(po: ReceivedPO): string | null {
    const status = getDynamicReceiptStatus(po);
    if (status !== "partial" || po.items.length === 0) return null;
    
    const shortItems = po.items
        .filter(item => item.openQuantity == null || item.openQuantity > 0);
    
    if (shortItems.length === 0) return "partial receipt";
    
    const details = shortItems.slice(0, 2).map(item => {
        const ordered = item.orderedQuantity ?? item.quantity;
        const open = item.openQuantity;
        if (open !== undefined && open > 0) {
            return `${item.productId} short ${fmtQty(open)} of ${fmtQty(ordered)}`;
        }
        return `${item.productId} ×${fmtQty(ordered)}`;
    });
    
    let result = details.join(", ");
    if (shortItems.length > 2) result += ` +${shortItems.length - 2} more`;
    return result;
}

function fmtQty(n: number | null | undefined): string {
    return Number(n || 0).toLocaleString();
}

function getNextActionText(po: ReceivedPO, apLabel: string): string {
    const receiptStatus = getDynamicReceiptStatus(po);
    const isPartial = receiptStatus === "partial";
    const hasOpenQty = po.items.some(i => (i.openQuantity ?? 0) > 0);
    const hasInvoice = apLabel !== "UNMATCHED" && apLabel !== "";
    const isReconciled = apLabel === "RECONCILED" || apLabel === "RECONCILED ±" || receiptStatus === "full" && apLabel === "RECONCILED";
    const isPendingReview = apLabel === "PENDING";
    const hasDiscrepancy = apLabel === "RECONCILED ±";
    const isComplete = isReconciled && receiptStatus === "full" && !hasDiscrepancy;

    if (isComplete) return "✅ PO closed — no action needed";
    if (hasDiscrepancy && isReconciled) return "⚠️ Reconciled with pricing differences — verify final amounts";
    if (hasDiscrepancy) return "⚠️ Invoice $ differs from PO $ — resolve with vendor";
    if (isPendingReview) return "🔍 Invoice matched — review & approve reconciliation";
    if (isPartial && hasOpenQty) return "🔄 Partial receipt — backorder remains";
    if (hasInvoice) return "📋 Verify invoice matches PO qty & price";
    return "📋 Awaiting invoice match";
}

function daysSince(dateStr: string | undefined | null): number | null {
    if (!dateStr) return null;
    const d = parseDenverDate(dateStr);
    if (!d) return null;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function hasPartialLineQuantities(po: ReceivedPO): boolean {
    return po.items.some(item => item.receivedQuantity !== undefined || item.receivedInWindow !== undefined);
}

function receiptItemsText(items: Array<{ productId: string; quantity: number }>): string {
    if (items.length === 0) return "receipt recorded; line quantities unavailable";
    return items.map(item => `${item.productId} ×${fmtQty(item.quantity)}`).join(", ");
}

// ── Match Status (review-before-commit) ─────────────────────────────────────

type MatchStatus = "match" | "possible_match" | "no_match";

function computeMatchStatus(apLabel: string): MatchStatus {
    if (apLabel === "RECONCILED") return "match";
    if (apLabel === "RECONCILED ±" || apLabel === "PENDING") return "possible_match";
    return "no_match";
}

const matchStatusConfig: Record<MatchStatus, { label: string; emoji: string; cls: string }> = {
    match:          { label: "Match",          emoji: "✅", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
    possible_match: { label: "Possible Match", emoji: "⚠️", cls: "text-amber-300 border-amber-500/30 bg-amber-500/10" },
    no_match:       { label: "No Match",       emoji: "🔍", cls: "text-zinc-400 border-zinc-500/30 bg-zinc-500/10" },
};

/**
 * Render the pre-completion match comparison view for a PO.
 * Shows line-item comparison, charges comparison, proposed changes,
 * and a match-status-aware complete button.
 */
function MatchComparisonView({
    po,
    apLabel,
    diff,
    loading,
    error,
    saving,
    onToggle,
    onComplete,
    onApply,
}: {
    po: ReceivedPO;
    apLabel: string;
    diff: any;
    loading: boolean;
    error?: string;
    saving?: boolean;
    onToggle: () => void;
    onComplete: () => void;
    onApply: (adjustments: any[], freight: number | null) => void;
}) {
    const status = computeMatchStatus(apLabel);
    const cfg = matchStatusConfig[status];
    const rec = po._reconciliation;
    const matchedInv = rec?.matchedInvoice;

    return (
        <div className="mt-2 border border-zinc-800/60 rounded overflow-hidden">
            {/* ── Match Status Banner ── */}
            <div className={`px-3 py-2 flex items-center gap-2 ${cfg.cls} border-b border-zinc-800/40`}>
                <span className="text-[12px]">{cfg.emoji}</span>
                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider">{cfg.label}</span>
                <div className="flex-1" />
                <button
                    onClick={e => { e.stopPropagation(); onToggle(); }}
                    className="text-[9px] font-mono text-zinc-500 hover:text-zinc-300 underline underline-offset-2 decoration-zinc-700/30"
                >
                    {loading ? "Loading..." : loading === undefined ? "Compare" : diff ? "Hide" : "Compare"}
                </button>
            </div>

            {loading && (
                <div className="px-3 py-3 bg-zinc-950/30">
                    <span className="text-[10px] font-mono text-cyan-300/60 animate-pulse">Loading invoice comparison...</span>
                </div>
            )}

            {error && (
                <div className="px-3 py-2 bg-rose-950/10 text-[10px] font-mono text-rose-400">{error}</div>
            )}

            {/* ── Charges Comparison (from GET enrichment, always visible) ── */}
            {rec?.chargesComparison && (
                <div className="px-3 py-2 border-b border-zinc-800/40 bg-zinc-950/40">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">Charges Comparison</div>
                    <table className="w-full text-[10px] font-mono">
                        <thead>
                            <tr className="text-zinc-600 border-b border-zinc-800/40">
                                <th className="text-left py-0.5 pr-2">Charge</th>
                                <th className="text-right py-0.5 px-2">PO</th>
                                <th className="text-right py-0.5 px-2">Invoice</th>
                                <th className="text-right py-0.5 pl-2">Diff</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(["subtotal","freight","tax","tariffs","total"] as const).map((k, i) => {
                                const po = rec.chargesComparison!.po[k];
                                const inv = rec.chargesComparison!.invoice[k];
                                const diff = rec.chargesComparison!.diffs[k];
                                const label = k.charAt(0).toUpperCase() + k.slice(1);
                                const diffAbs = Math.abs(diff ?? 0);
                                const diffCls = diffAbs < 0.01 ? "text-zinc-600" : diffAbs > 50 ? "text-rose-400" : "text-amber-300";
                                const rowCls = k === "total" ? "border-t border-zinc-700/50 font-semibold" : "";
                                return (
                                    <tr key={k} className={rowCls}>
                                        <td className="py-0.5 pr-2 text-zinc-400">{label}</td>
                                        <td className="text-right py-0.5 px-2 text-zinc-300">{po != null ? `$${po.toFixed(2)}` : "—"}</td>
                                        <td className="text-right py-0.5 px-2 text-zinc-300">{inv != null ? `$${inv.toFixed(2)}` : "—"}</td>
                                        <td className={`text-right py-0.5 pl-2 ${diffCls}`}>
                                            {diff != null ? `${diff > 0 ? "+" : ""}$${diff.toFixed(2)}` : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ── Line-Item Comparison (from GET enrichment, always visible) ── */}
            {rec?.lineComparison && rec.lineComparison.length > 0 && (
                <div className="px-3 py-2 border-b border-zinc-800/40 bg-zinc-950/20">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">Line-Item Comparison</div>
                    <table className="w-full text-[10px] font-mono">
                        <thead>
                            <tr className="text-zinc-600 border-b border-zinc-800/40">
                                <th className="text-left py-0.5 pr-1.5">SKU</th>
                                <th className="text-right py-0.5 px-1">PO Qty</th>
                                <th className="text-right py-0.5 px-1">PO $</th>
                                <th className="text-right py-0.5 px-1">Rcv</th>
                                <th className="text-right py-0.5 px-1">Inv Qty</th>
                                <th className="text-right py-0.5 px-1">Inv $</th>
                                <th className="text-right py-0.5 pl-1.5">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rec.lineComparison.map((l: any) => {
                                const isBlocking = l.status === "blocking";
                                const isVariance = l.status === "variance";
                                const rowCls = isBlocking ? "bg-rose-950/15 border-b border-rose-800/20 text-rose-200"
                                    : isVariance ? "bg-amber-950/10 border-b border-amber-800/20 text-amber-200"
                                    : "text-zinc-300 border-b border-zinc-800/20";
                                const statusIcon = isBlocking ? "🔴" : isVariance ? "🟡" : "🟢";
                                return (
                                    <tr key={l.productId} className={rowCls}>
                                        <td className="py-0.5 pr-1.5 text-left font-semibold truncate max-w-[80px]" title={l.productId}>{l.productId || "—"}</td>
                                        <td className="text-right py-0.5 px-1">{fmtQty(l.poQty)}</td>
                                        <td className="text-right py-0.5 px-1">${(l.poUnitPrice ?? 0).toFixed(2)}</td>
                                        <td className="text-right py-0.5 px-1 text-cyan-400">{l.receivedQty != null ? fmtQty(l.receivedQty) : "—"}</td>
                                        <td className="text-right py-0.5 px-1">{l.invoiceQty != null ? fmtQty(l.invoiceQty) : "—"}</td>
                                        <td className="text-right py-0.5 px-1">{l.invoiceUnitPrice != null ? `$${l.invoiceUnitPrice.toFixed(2)}` : "—"}</td>
                                        <td className="text-right py-0.5 pl-1.5">{statusIcon}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ── 3-Way Match Summary ── */}
            {rec?.threeWayMatch && (
                <div className="px-3 py-2 border-b border-zinc-800/40 bg-zinc-950/30">
                    <div className="text-[10px] font-mono text-zinc-400">{rec.threeWayMatch.summary}</div>
                    {rec.threeWayMatch.discrepancies?.length > 0 && rec.threeWayMatch.discrepancies.map((d: any) => (
                        <div key={d.productId + d.kind} className={`text-[9px] font-mono mt-0.5 ${d.blocking ? "text-rose-400" : "text-amber-400"}`}>
                            {d.blocking ? "🚫" : "⚠️"} {d.message} {d.dollarImpact ? `($${d.dollarImpact})` : ""}
                        </div>
                    ))}
                </div>
            )}

            {/* ── Action ── */}
            <div className="px-3 py-2 flex items-center gap-2 justify-end bg-zinc-950/50">
                {status === "no_match" ? (
                    <span className="text-[9px] font-mono text-zinc-600 mr-auto">No invoice matched</span>
                ) : rec?.threeWayMatch?.canApprove ? (
                    <button
                        onClick={e => { e.stopPropagation(); onComplete(); }}
                        className="px-3 py-1 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer transition-colors"
                    >
                        Complete PO
                    </button>
                ) : (
                    <button
                        onClick={e => { e.stopPropagation(); onComplete(); }}
                        className="px-3 py-1 rounded text-[10px] font-mono font-semibold bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 cursor-pointer transition-colors"
                    >
                        Review & Complete
                    </button>
                )}
            </div>
        </div>
    );
}

export type ReceivedItemsPanelProps = {
    /** Lifecycle column mode: fill height, no card collapse/resize. */
    embedded?: boolean;
};

export default function ReceivedItemsPanel({ embedded = false }: ReceivedItemsPanelProps = {}) {
    const lifecycle = usePurchasingLifecycle();
        const [pos, setPos] = useState<ReceivedPO[]>([]);
        const [matchSuggestions, setMatchSuggestions] = useState<MatchSuggestion[]>([]);
        const [freightClasses, setFreightClasses] = useState<Record<string, FreightClass>>({});
        const [todaySummary, setTodaySummary] = useState<TrackingTodaySummary>(null);
        const [cachedAt, setCachedAt] = useState<string | null>(null);
        const [apMap, setApMap] = useState<ApStatusMap>({});
        const [loading, setLoading] = useState(true);
        const [refreshing, setRefreshing] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [approvingReconcile, setApprovingReconcile] = useState<Set<string>>(new Set());
        /** Tracks known receipt orderIds so new arrivals can bust Ordering cache. */
        const knownReceiptIdsRef = useRef<Set<string>>(new Set());
        /** Keep last-painted rows so silent refresh never blanks the panel. */
        const posRef = useRef<ReceivedPO[]>([]);
        posRef.current = pos;
        /**
         * HERMIA(2026-07-28): lifecycle context value changes on every hover/focus
         * event (focus is in the useMemo deps). If fetchReceivings closes over
         * `lifecycle`, its identity churns → the mount effect re-fires →
         * setLoading(true) → skeleton blank. Hold notifyReceipt in a ref instead.
         */
        const notifyReceiptRef = useRef(lifecycle.notifyReceipt);
        notifyReceiptRef.current = lifecycle.notifyReceipt;
    /** Gate refusal message per PO — set when complete_po returns 409 */
        const [gateBlockReason, setGateBlockReason] = useState<Map<string, string>>(new Map());
        /** PO modification state: orderId → expanded & diff data */
        const [modifyingPO, setModifyingPO] = useState<Map<string, {
            loading: boolean;
            diff?: any;
            error?: string;
            saving?: boolean;
        }>>(new Map());
        const [modifySuccess, setModifySuccess] = useState<string | null>(null);
    /** Unmatched POs check state */
    const [unmatchedData, setUnmatchedData] = useState<{
        unmatchedPos: Array<{ orderId: string; vendorName: string; date: string; total: number; status: string }>;
        unreconciledPos: Array<{ orderId: string; vendorName: string; date: string; total: number; status: string; lifecycleState: string }>;
    } | null>(null);
    const [unmatchedLoading, setUnmatchedLoading] = useState(false);
    /** Show all received POs toggle (default: only exceptions) */
    const [showAllReceived, setShowAllReceived] = useState(false);
    /** Collapse received PO list when there are invoices to match. */
    const [showReceivedPOs, setShowReceivedPOs] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const [recentAutoCompletions, setRecentAutoCompletions] = useState<Array<{
        intent: string; poNumber?: string; invoiceNumber?: string; vendorName?: string; createdAt: string;
    }>>([]);
    /** Computed: count of POs needing human attention */
    const needsReviewCount = pos.filter(p => {
        const lbl = apMap[p.orderId]?.label || "";
        return lbl === "RECONCILED ±" || lbl === "PENDING" || lbl === "UNMATCHED" || lbl === "";
    }).length;
    /** Manual match state: invoiceId → manual PO input */
        const [manuallyMatching, setManuallyMatching] = useState<Map<string, { poNumber: string; loading: boolean }>>(new Map());

        /** Pre-completion comparison: which POs have their MatchComparisonView expanded */
        const [comparisonPO, setComparisonPO] = useState<Set<string>>(new Set());

        /** Toggle the comparison view open/closed for a PO and lazy-load the diff. */
        function toggleComparison(orderId: string) {
            setComparisonPO(prev => {
                const next = new Set(prev);
                if (next.has(orderId)) {
                    next.delete(orderId);
                } else {
                    next.add(orderId);
                    // Lazy-load the diff if not already loaded
                    const existing = modifyingPO.get(orderId);
                    if (!existing || (!existing.loading && existing.diff === undefined && !existing.error)) {
                        // Use the existing loadPOInvoiceDiff
                        loadPOInvoiceDiff(orderId, pos.find(p => p.orderId === orderId)?._reconciliation?.matchedInvoice?.invoice_number);
                    }
                }
                return next;
            });
        }

    /** Update manual PO input for a given invoice. */
    function handleManualInputChange(invoiceId: string, value: string) {
        setManuallyMatching(prev => {
            const next = new Map(prev);
            const existing = next.get(invoiceId);
            next.set(invoiceId, { poNumber: value, loading: existing?.loading ?? false });
            return next;
        });
    }

    async function handleMatchInvoice(invoiceId: string, poNumber: string) {
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "match_invoice", invoiceId, poNumber }),
            });
            if (res.ok) {
                // Remove from suggestions
                setMatchSuggestions(prev => prev.filter(s => s.invoiceId !== invoiceId));
            }
        } catch (e: any) {
            console.error("Match invoice error:", e.message);
        }
    }

    async function handleCompletePO(orderId: string, vendorName: string) {
            try {
                const res = await fetch("/api/dashboard/receivings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "complete_po", orderId, vendorName }),
                });
                const json = await res.json();
                if (res.ok) {
                    // Clear any previous gate refusal for this PO
                    setGateBlockReason(prev => { const next = new Map(prev); next.delete(orderId); return next; });
                    fetchReceivings(true);
                } else if (res.status === 409 && json.detail) {
                    // Gate refused — show the 3-way match summary inline
                    setGateBlockReason(prev => { const next = new Map(prev); next.set(orderId, json.detail); return next; });
                    console.warn(`[ReceivedItems] complete_po ${orderId} blocked by 3-way gate: ${json.detail}`);
                } else {
                    throw new Error(json.error || `HTTP ${res.status}`);
                }
            } catch (e: any) {
                console.error("Complete PO error:", e.message);
            }
        }

    async function handleManualMatch(invoiceId: string) {
        const state = manuallyMatching.get(invoiceId);
        if (!state || !state.poNumber.trim()) return;
        setManuallyMatching(prev => {
            const next = new Map(prev);
            next.set(invoiceId, { ...state, loading: true });
            return next;
        });
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "match_invoice", invoiceId, poNumber: state.poNumber.trim() }),
            });
            if (res.ok) {
                setManuallyMatching(prev => { const next = new Map(prev); next.delete(invoiceId); return next; });
                setMatchSuggestions(prev => prev.filter(s => s.invoiceId !== invoiceId));
                fetchReceivings(true);
            } else {
                const err = await res.text();
                console.error("Manual match failed:", err);
                setManuallyMatching(prev => {
                    const next = new Map(prev);
                    next.set(invoiceId, { ...manuallyMatching.get(invoiceId)!, loading: false });
                    return next;
                });
            }
        } catch (e: any) {
            console.error("Manual match error:", e.message);
            setManuallyMatching(prev => {
                const next = new Map(prev);
                next.set(invoiceId, { ...manuallyMatching.get(invoiceId)!, loading: false });
                return next;
            });
        }
    }

    async function approveReconciliation(orderId: string, invoiceId?: string) {
        setApprovingReconcile(prev => new Set(prev).add(orderId));
        try {
            const res = await fetch("/api/dashboard/active-purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "approve_reconciliation",
                    orderId,
                    invoiceId,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Failed to approve reconciliation");
            // Update local apMap
            setApMap(prev => ({
                ...prev,
                [orderId]: { label: "Approved ✓", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
            }));
        } catch (e: any) {
            console.error("Approve reconciliation error:", e.message);
        } finally {
            setApprovingReconcile(prev => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    }

    /** Load PO-invoice diff from the po-modify API and expand the modifier UI. */
    async function loadPOInvoiceDiff(orderId: string, invoiceId?: string) {
        setModifyingPO(prev => {
            const next = new Map(prev);
            next.set(orderId, { loading: true });
            return next;
        });

        try {
            const params = new URLSearchParams({ orderId });
            if (invoiceId) params.set("invoiceId", invoiceId);
            const res = await fetch(`/api/dashboard/po-modify?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();

            setModifyingPO(prev => {
                const next = new Map(prev);
                next.set(orderId, { loading: false, diff: data.diff, error: undefined });
                return next;
            });
        } catch (e: any) {
            setModifyingPO(prev => {
                const next = new Map(prev);
                next.set(orderId, { loading: false, error: e.message });
                return next;
            });
        }
    }

    /** Apply PO modifications from the modifier UI. */
    async function applyPOInvoiceModification(orderId: string, adjustments: any[], freightAdjustment?: number | null) {
        setModifyingPO(prev => {
            const next = new Map(prev);
            const existing = next.get(orderId) || { loading: false };
            next.set(orderId, { ...existing, saving: true });
            return next;
        });
        setModifySuccess(null);

        try {
            // Find invoiceId from the invoice number in diff data
            const state = modifyingPO.get(orderId);
            let invoiceId: string | undefined;
            if (state?.diff?.invoiceNumber) {
                // Look up the first matching invoice from PO's reconciliation data
                const po = pos.find(p => p.orderId === orderId);
                const inv = po?._reconciliation?.invoices?.find(
                    i => i.invoice_number === state.diff.invoiceNumber,
                );
                if (inv) invoiceId = inv.invoice_number;
            }

            const payload: any = {
                orderId,
                invoiceId,
                adjustments,
                freightAdjustment: freightAdjustment ?? null,
                notes: "Manual adjustment from Receivings panel",
            };

            const res = await fetch("/api/dashboard/po-modify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const result = await res.json();

            if (result.success) {
                setModifySuccess(`PO ${orderId} modified: ${result.adjustmentsApplied} line(s) adjusted${result.freightApplied ? ", freight updated" : ""}`);
                // Close the modifier
                setModifyingPO(prev => {
                    const next = new Map(prev);
                    next.delete(orderId);
                    return next;
                });
                // Refresh after a moment
                setTimeout(() => fetchReceivings(true), 1500);
            } else {
                throw new Error(result.errors?.join("; ") || "Modification failed");
            }
        } catch (e: any) {
            setModifyingPO(prev => {
                const next = new Map(prev);
                const existing = next.get(orderId) || { loading: false };
                next.set(orderId, { ...existing, saving: false, error: e.message });
                return next;
            });
        }
    }

    // ── Resend PO email ─────────────────────────────────────────────────────
    async function resendPOEmail(orderId: string) {
        try {
            const res = await fetch("/api/dashboard/active-purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "resend_po_email", orderId }),
            });
            if (!res.ok) throw new Error(await res.text());
            setModifySuccess(`PO ${orderId} email re-sent`);
        } catch (e: any) {
            setError(`Resend failed: ${e.message}`);
        }
    }

    /** Toggle the PO modifier UI open/closed for a given orderId. */
    function toggleModifier(orderId: string, invoiceId?: string) {
        if (modifyingPO.has(orderId)) {
            setModifyingPO(prev => {
                const next = new Map(prev);
                next.delete(orderId);
                return next;
            });
        } else {
            loadPOInvoiceDiff(orderId, invoiceId);
        }
    }

    /** Check for POs without matched invoices. */
    async function checkUnmatchedPOs() {
        setUnmatchedLoading(true);
        try {
            const res = await fetch("/api/dashboard/po-modify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "check_unmatched" }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setUnmatchedData(data);
        } catch (e: any) {
            console.error("Failed to check unmatched POs:", e);
            setUnmatchedData({
                unmatchedPos: [],
                unreconciledPos: [],
            });
        } finally {
            setUnmatchedLoading(false);
        }
    }

    // Resizable height — persisted
    const containerRef = useRef<HTMLDivElement>(null);
    const [bodyHeight, setBodyHeight] = useState(220);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-recv-h");
        if (s) setBodyHeight(Math.max(80, Math.min(600, parseInt(s))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-recv-h", String(bodyHeight)); }, [bodyHeight]);

    // Collapse state — persisted to localStorage
    const [isCollapsed, setIsCollapsed] = useState(false);
    const effectivelyCollapsed = embedded ? false : isCollapsed;
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-recv-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-recv-collapsed", String(isCollapsed)); }, [isCollapsed]);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(80, Math.min(600, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [bodyHeight]);

    // Fetch real AP status directly from the invoices table (single source of truth)
    useEffect(() => {
        const supabase = createBrowserClient();
        supabase
            .from("invoices")
            .select("po_number, status, discrepancies")
            .not("po_number", "is", null)
            .order("created_at", { ascending: false })
            .limit(200)
            .then((res: { data: Array<{ po_number: string; status: string; discrepancies: any[] }> | null }) => {
                const data = res.data;
                if (!data) return;
                const map: ApStatusMap = {};
                for (const row of data) {
                    const id = row.po_number;
                    if (!id || map[id]) continue;  // first (most recent) wins

                    const st = row.status || "unmatched";
                    let label = "UNMATCHED";
                    let cls = "text-zinc-500 border-zinc-700 bg-zinc-800/20";

                    if (st === "matched_review") {
                        label = "PENDING";
                        cls = "text-amber-300 border-amber-500/30 bg-amber-500/10";
                    } else if (st === "reconciled" || st === "matched_approved") {
                        const hasChanges = row.discrepancies && row.discrepancies.length > 0;
                        label = hasChanges ? "RECONCILED ±" : "RECONCILED";
                        cls = hasChanges
                            ? "text-blue-400 border-blue-500/30 bg-blue-500/10"
                            : "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
                    } else if (st === "unmatched") {
                        label = "UNMATCHED";
                        cls = "text-zinc-400 border-zinc-500/30 bg-zinc-500/10";
                    }

                    map[id] = { label, cls };
                }
                setApMap(map);

                // Also fetch pending approvals from ap_pending_approvals
                supabase
                    .from("ap_pending_approvals")
                    .select("order_id, invoice_number, vendor_name, status")
                    .eq("status", "pending")
                    .order("created_at", { ascending: false })
                    .limit(30)
                    .then(paRes => {
                        const paData = (paRes as any).data;
                        if (!paData) return;
                        const paMap: ApStatusMap = {};
                        for (const pa of paData) {
                            if (!pa.order_id || paMap[pa.order_id]) continue;
                            paMap[pa.order_id] = {
                                label: "PENDING",
                                cls: "text-amber-300 border-amber-500/40 bg-amber-500/10",
                            };
                        }
                        // Merge: pending approvals override invoice status
                        setApMap(prev => ({ ...prev, ...paMap }));
                    });
            });
    }, []);

    const fetchReceivings = useCallback(async (silent = false) => {
                // HERMIA(2026-07-28): Never blank painted rows. Skeleton only on first paint
                // (no rows yet). Background / interval / post-action reloads use the spinner
                // flag only — previous POs stay visible until the new payload lands.
                const hasRows = posRef.current.length > 0;
                if (silent || hasRows) setRefreshing(true);
                else setLoading(true);
                setError(null);
                try {
                    // HERMIA(2026-08-06): Abort after 18s so the panel cannot spin forever.
                    // API has its own 20s guard + 3min cache; client must not hang longer.
                    const ctrl = new AbortController();
                    const kill = setTimeout(() => ctrl.abort(), 18_000);
                    let receivingsRes: Response;
                    let trackingRes: Response | null = null;
                    try {
                        [receivingsRes, trackingRes] = await Promise.all([
                            fetch('/api/dashboard/receivings', { signal: ctrl.signal }),
                            fetch('/api/dashboard/tracking', { signal: ctrl.signal }).catch(() => null),
                        ]);
                    } finally {
                        clearTimeout(kill);
                    }

                    if (!receivingsRes.ok) throw new Error(`HTTP ${receivingsRes.status}`);
                    const data = await receivingsRes.json();
                    if (data.error && !(data.received?.length)) throw new Error(data.error);
                    const sorted = [...(data.received || [])].sort((a, b) => receiveSortValue(b) - receiveSortValue(a));

                    // Notify Ordering when new receipt IDs appear so purchasing cache busts.
                    const nextIds = sorted.map((p: ReceivedPO) => String(p.orderId)).filter(Boolean);
                    const prev = knownReceiptIdsRef.current;
                    if (prev.size > 0) {
                        const fresh = nextIds.filter((id: string) => !prev.has(id));
                        if (fresh.length > 0) {
                            notifyReceiptRef.current(fresh);
                        }
                    }
                    knownReceiptIdsRef.current = new Set(nextIds);
                    setPos(sorted);
                    setMatchSuggestions(data.matchSuggestions || []);
                    setRecentAutoCompletions(data.recentAutoCompletions || []);
                    setFreightClasses(data.freightClasses || {});

                    if (trackingRes && trackingRes.ok) {
                        const trackingData = await trackingRes.json();
                        setTodaySummary(trackingData.todaySummary || null);
                    } else if (!hasRows) {
                        setTodaySummary(null);
                    }
                } catch (e: any) {
                    // Keep painted rows on timeout/abort — only surface error when empty
                    if (!posRef.current.length) {
                        const msg = e?.name === 'AbortError' ? 'Receivings timed out — retry' : e.message;
                        setError(msg);
                    }
                } finally {
                    setLoading(false);
                    setRefreshing(false);
                }
            }, []);

        useEffect(() => {
            fetchReceivings();
            const t = setInterval(() => fetchReceivings(true), 30 * 60 * 1000);
            return () => clearInterval(t);
        }, [fetchReceivings]);

    const matchDollars = matchSuggestions.reduce((sum, m) => sum + (Number(m.invoiceTotal) || 0), 0);
    const exceptionCount = pos.filter(po => {
        const lbl = (apMap[po.orderId]?.label || "").toLowerCase();
        if (lbl.includes("unmatched") || lbl.includes("review")) return true;
        if ((po as any).receiptStatus === "partial") return true;
        return false;
    }).length;

    return (
        <div
            className={embedded
                ? "h-full min-h-0 flex flex-col overflow-hidden"
                : "border-b border-zinc-800 shrink-0"
            }
            ref={containerRef}
        >
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Receivings</span>
                <span className="text-[10px] text-[var(--dash-ts)] font-mono">30d</span>
                                {matchSuggestions.length > 0 && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                        {matchSuggestions.length} match{matchSuggestions.length > 1 ? "es" : ""}
                                    </span>
                                )}
                                <div className="flex-1" />
                {!loading && pos.length > 0 && (
                    <span className="text-xs font-mono text-zinc-500">{pos.length} POs</span>
                )}
                <button onClick={() => fetchReceivings(true)} disabled={refreshing}
                    className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className={`p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1 ${embedded ? "hidden" : ""}`}
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {/* Accounting status — Receivings (separate from Ordering / Active) */}
            {!effectivelyCollapsed && !loading && (
                <div className="px-3 py-1 border-b border-zinc-800/50 bg-zinc-950/60 flex items-center gap-2 text-[10px] font-mono text-zinc-400">
                    <span className="text-zinc-600 uppercase tracking-wider shrink-0">AP</span>
                    {matchSuggestions.length > 0 ? (
                        <>
                            <span className="text-amber-300">{matchSuggestions.length} match{matchSuggestions.length === 1 ? "" : "es"}</span>
                            {matchDollars > 0 && (
                                <span className="text-amber-200/90">${Math.round(matchDollars).toLocaleString()}</span>
                            )}
                        </>
                    ) : (
                        <span className="text-emerald-400/80">0 open matches</span>
                    )}
                    <span className="text-zinc-700">·</span>
                    <span>{pos.length} receipt{pos.length === 1 ? "" : "s"}</span>
                    {exceptionCount > 0 && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span className="text-rose-300">{exceptionCount} need review</span>
                        </>
                    )}
                </div>
            )}

            {!effectivelyCollapsed && (
                <div className={embedded ? "flex-1 min-h-0 flex flex-col overflow-hidden" : undefined}>
                    {modifySuccess && (
                        <div className="px-4 py-2 border-b border-emerald-500/30 bg-emerald-500/10 text-[11px] font-mono text-emerald-400 flex items-center gap-2">
                            <span>✅</span>
                            <span className="flex-1">{modifySuccess}</span>
                            <button onClick={() => setModifySuccess(null)} className="text-emerald-400/50 hover:text-emerald-300">✕</button>
                        </div>
                    )}
                    {!loading && !error && pos.length > 0 && (() => {
                        const unmatched = pos.filter(p => {
                            const lbl = apMap[p.orderId]?.label || "";
                            return lbl === "UNMATCHED" || lbl === "";
                        }).length;
                        const partialCount = pos.filter(p => getDynamicReceiptStatus(p) === "partial").length;
                        const discrepancyCount = pos.filter(p => {
                            const lbl = apMap[p.orderId]?.label || "";
                            return lbl === "RECONCILED ±";
                        }).length;
                        const pendingCount = pos.filter(p => {
                            const lbl = apMap[p.orderId]?.label || "";
                            return lbl === "PENDING";
                        }).length;
                        return (
                            <div className="px-4 py-1.5 flex flex-wrap items-center gap-1.5 border-b border-zinc-800/40 bg-zinc-900/30">
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-400">
                                    {pos.length} Received
                                </span>
                                {unmatched > 0 && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-400">
                                        <span className="text-rose-400 font-semibold">{unmatched}</span> Unmatched
                                    </span>
                                )}
                                {partialCount > 0 && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-400">
                                        <span className="text-amber-300 font-semibold">{partialCount}</span> Partial
                                    </span>
                                )}
                                {discrepancyCount > 0 && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-400">
                                        <span className="text-blue-400 font-semibold">{discrepancyCount}</span> Discrepancy
                                    </span>
                                )}
                                {pendingCount > 0 && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-400">
                                        <span className="text-amber-300 font-semibold">{pendingCount}</span> Pending Approval
                                    </span>
                                )}
                            </div>
                        );
                    })()}
                    {loading ? (
                        <div className="px-4 py-3 space-y-2.5">
                            <div className="text-[10px] font-mono text-zinc-600 mb-1.5 animate-pulse">Loading received POs...</div>
                            {[1, 2, 3].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="skeleton-shimmer h-3" style={{ width: `${20 + i * 8}%` }} />
                                    <div className="skeleton-shimmer h-3 w-12 ml-auto" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-rose-400">{error}</span></div>
                    ) : pos.length === 0 ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-zinc-500">No receipts in the last 30 days — all received POs have been processed</span></div>
                    ) : (
                        <div
                            className={`overflow-y-auto border-t border-zinc-800/60 ${embedded ? "flex-1 min-h-0" : ""}`}
                            style={embedded ? undefined : { height: bodyHeight }}
                        >
                            {todaySummary && (
                                <div className="px-4 py-3 border-b border-cyan-500/20 bg-cyan-500/5">
                                    <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-300/80">
                                        Shipping Today
                                    </div>
                                    <div className="mt-1 text-sm font-semibold text-cyan-100">
                                        {todaySummary.headline}
                                    </div>
                                    <div className="mt-2 space-y-1">
                                        {todaySummary.lines.map((line) => {
                                            const isValidated = line.includes('✓ validated');
                                            return (
                                                <div key={line} className={`text-[11px] font-mono ${isValidated ? 'text-emerald-300' : 'text-cyan-200/85'}`}>
                                                    {line}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* ── Split-panel Invoice → PO Matcher ── */}
                            <InvoicePOMatcher
                                suggestions={matchSuggestions.filter(s =>
                                    s.candidates.every(c => !/DropshipPO/i.test(String(c.orderId || "")))
                                )}
                                receivedPOs={pos}
                                onMatch={handleMatchInvoice}
                                onManualMatch={handleManualMatch}
                                onApproveReconciliation={approveReconciliation}
                                approvingReconcile={approvingReconcile}
                                manuallyMatching={manuallyMatching}
                                onManualInputChange={handleManualInputChange}
                            />

                            {/* ── Received POs toggle ── */}
                            {matchSuggestions.length > 0 && (
                                <button
                                    onClick={() => setShowReceivedPOs(!showReceivedPOs)}
                                    className="w-full px-4 py-1.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 border-b border-zinc-800/40 transition-colors text-left flex items-center gap-1.5"
                                >
                                    <span>{showReceivedPOs ? "▼" : "▶"}</span>
                                    <span>Received POs ({pos.length})</span>
                                    {needsReviewCount > 0 && (
                                        <span className="text-rose-400/70">· {needsReviewCount} need review</span>
                                    )}
                                </button>
                            )}
                            {(!matchSuggestions.length || showReceivedPOs) && (
                            <div>

                            {/* ── Unmatched POs Check ── */}
                            <div className="border-b border-zinc-800/40">
                                <div className="px-4 py-2 flex items-center gap-2">
                                    <span className="text-[10px] font-mono text-zinc-500">
                                        {unmatchedData
                                            ? `${unmatchedData.unmatchedPos.length + unmatchedData.unreconciledPos.length} POs need review`
                                            : `PO-invoice match status unknown`}
                                    </span>
                                    <div className="flex-1" />
                                    <button
                                        onClick={e => { e.stopPropagation(); checkUnmatchedPOs(); }}
                                        disabled={unmatchedLoading}
                                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-40"
                                    >
                                        {unmatchedLoading ? "checking..." : "Check Match Status"}
                                    </button>
                                </div>
                                {unmatchedData && (unmatchedData.unmatchedPos.length > 0 || unmatchedData.unreconciledPos.length > 0) && (
                                    <div className="px-4 py-1.5 space-y-1 pb-2">
                                        {unmatchedData.unmatchedPos.map(po => (
                                            <div key={`u-${po.orderId}`} className="flex items-center gap-2 text-[10px] font-mono text-rose-300">
                                                <span className="w-1 h-1 rounded-full bg-rose-500 shrink-0" />
                                                <span className="font-semibold">{po.orderId}</span>
                                                <span className="text-zinc-400 truncate">{po.vendorName}</span>
                                                <span className="text-zinc-600">· no invoice</span>
                                                <span className="ml-auto text-zinc-500">{po.date ? new Date(po.date).toLocaleDateString() : ''}</span>
                                            </div>
                                        ))}
                                        {unmatchedData.unreconciledPos.slice(0, 10).map(po => (
                                            <div key={`r-${po.orderId}`} className="flex items-center gap-2 text-[10px] font-mono text-amber-300">
                                                <span className="w-1 h-1 rounded-full bg-amber-500 shrink-0" />
                                                <span className="font-semibold">{po.orderId}</span>
                                                <span className="text-zinc-400 truncate">{po.vendorName}</span>
                                                <span className="text-zinc-600">· {po.lifecycleState || 'unknown'}</span>
                                                <span className="ml-auto text-zinc-500">{po.date ? new Date(po.date).toLocaleDateString() : ''}</span>
                                            </div>
                                        ))}
                                        {(unmatchedData.unreconciledPos.length > 10) && (
                                            <div className="text-[10px] font-mono text-zinc-600 pl-3">
                                                +{unmatchedData.unreconciledPos.length - 10} more
                                            </div>
                                        )}
                                    </div>
                                )}
                                {unmatchedData && unmatchedData.unmatchedPos.length === 0 && unmatchedData.unreconciledPos.length === 0 && (
                                    <div className="px-4 py-1.5 text-[10px] font-mono text-emerald-400/70 pb-2">
                                        ✅ All POs have matched invoices or are reconciled
                                    </div>
                                )}
                            </div>

                            {/* ── Needs Review / All Received split ── */}
                            {needsReviewCount > 0 && (
                                <div className="px-4 py-1.5 border-b border-rose-500/20 bg-rose-500/5 flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                                    <span className="text-[10px] font-mono text-rose-300/90 uppercase tracking-wider">
                                        {needsReviewCount} need{needsReviewCount > 1 ? "" : "s"} review
                                    </span>
                                    <div className="flex-1" />
                                    <span className="text-[9px] font-mono text-zinc-600">
                                        {pos.length - needsReviewCount} auto-processed
                                    </span>
                                </div>
                            )}
                            {pos.length > needsReviewCount && (
                                <button
                                    onClick={() => setShowAllReceived(!showAllReceived)}
                                    className="w-full px-4 py-1 text-[10px] font-mono text-zinc-600 hover:text-zinc-400 border-b border-zinc-800/40 transition-colors text-left flex items-center gap-1"
                                >
                                    {showAllReceived ? "−" : "+"}
                                    <span>{showAllReceived ? "Show only items needing review" : `Show all ${pos.length} received POs`}</span>
                                </button>
                            )}

                            {/* ── Auto-processed summary — full trail in Activity tab ── */}
                            {recentAutoCompletions.length > 0 && !showAllReceived && (
                                <div className="px-4 py-1.5 border-b border-zinc-800/30 flex items-center gap-2">
                                    <span className="text-[10px] font-mono text-emerald-500/50">●</span>
                                    <span className="text-[10px] font-mono text-zinc-600">
                                        {recentAutoCompletions.length} auto-completed
                                    </span>
                                    <button
                                        onClick={() => document.querySelector('[role="tab"][aria-label="Activity"]')?.click()}
                                        className="text-[9px] font-mono text-blue-500/50 hover:text-blue-400 underline underline-offset-2 decoration-blue-500/20 transition-colors"
                                    >
                                        view in Activity
                                    </button>
                                </div>
                            )}
                            {pos
                                .filter(po => {
                                    if (showAllReceived) return true;
                                    const lbl = apMap[po.orderId]?.label || "";
                                    // Always show POs with match data so line-item/charges comparison is visible
                                    const recStatus = (po as any)._reconciliation?.matchStatus;
                                    if (recStatus === "match" || recStatus === "possible_match") return true;
                                    return lbl === "RECONCILED ±" || lbl === "PENDING" || lbl === "UNMATCHED" || lbl === "";
                                })
                                .map(po => {
                                const apStatus = apMap[po.orderId];
                                const dollars = fmtDollars(po.total);
                                const discrepancy = partialDiscrepancy(po);
                                const poProductIds = po.items.map(item => item.productId);
                                const rcvMatch = lifecycle.checkMatchDetails({
                                    vendorName: po.supplier,
                                    orderId: po.orderId,
                                    productIds: poProductIds,
                                });
                                const rcvBg = rcvMatch.isLockedDirect
                                    ? "bg-amber-500/10 ring-2 ring-inset ring-amber-500/50"
                                    : rcvMatch.isLockedBom
                                    ? "bg-amber-500/5 ring-1 ring-dashed ring-amber-500/30"
                                    : rcvMatch.isDirect
                                    ? "bg-cyan-500/8 ring-1 ring-inset ring-cyan-500/35"
                                    : rcvMatch.isBom
                                    ? "bg-cyan-500/4 ring-1 ring-dashed ring-cyan-500/25"
                                    : "";
                                return (
                                    <div
                                        key={po.orderId}
                                        onClick={(e) => {
                                            const target = e.target as HTMLElement;
                                            if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) return;
                                            lifecycle.setLockedFocus({ source: "rcv", vendorName: po.supplier, orderId: po.orderId, productIds: poProductIds });
                                        }}
                                        className={`px-4 py-2.5 border-b border-zinc-800/40 cursor-pointer transition-colors ${rcvBg ? rcvBg : "hover:bg-zinc-800/20"}`}
                                    >
                                        {/* Line 1: date · vendor · AP status · total */}
                                        <div className="flex items-center gap-2 min-w-0">
                                                                                    <span className="text-xs font-mono text-[var(--dash-ts)] shrink-0">{fmtDateTime(po.receiveDateTime || po.receiveDate)}</span>
                                                                                    {(() => {
                                                                                        const rcvDays = daysSince(po.receiveDateTime || po.receiveDate);
                                                                                        const ordDays = daysSince(po.orderDate);
                                                                                        const chips: string[] = [];
                                                                                        if (rcvDays !== null) chips.push(`rcv ${rcvDays}d`);
                                                                                        if (ordDays !== null) chips.push(`ord ${ordDays}d`);
                                                                                        if (chips.length === 0) return null;
                                                                                        return (
                                                                                            <span className="text-[10px] font-mono text-zinc-600 shrink-0">
                                                                                                · {chips.join(" · ")}
                                                                                            </span>
                                                                                        );
                                                                                    })()}
                                                                                    <span className="text-sm font-semibold text-zinc-100 truncate">{po.supplier}</span>
                                            {receiptBadge(po) && (
                                                                                            <span className={`text-[10px] font-mono px-1 py-px rounded border shrink-0 ${receiptBadge(po)!.cls}`}>
                                                                                                {receiptBadge(po)!.label}
                                                                                            </span>
                                                                                        )}
                                                                                        {(() => {
                                                                                            const ms = computeMatchStatus(apStatus?.label || "");
                                                                                            const mc = matchStatusConfig[ms];
                                                                                            return (
                                                                                                <span className={`text-[10px] font-mono px-1 py-px rounded border shrink-0 ${mc.cls}`}
                                                                                                    title={mc.label}>
                                                                                                    {mc.label}
                                                                                                </span>
                                                                                            );
                                                                                        })()}
                                                                                        {dollars && <span className="text-xs font-mono text-emerald-400 shrink-0 ml-auto">{dollars}</span>}
                                        </div>
                                        {/* Line 2: PO# + SKUs */}
                                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                            <a href={po.finaleUrl} target="_blank" rel="noopener noreferrer"
                                                className="text-xs font-mono text-blue-500 hover:text-blue-300 transition-colors shrink-0">
                                                {po.orderId}
                                            </a>
                                            {po.receivedBy && (
                                                <>
                                                    <span className="text-zinc-700 text-xs">·</span>
                                                    <span className="text-[10px] font-mono text-cyan-300/80">rcvd by {po.receivedBy}</span>
                                                </>
                                            )}
                                            {discrepancy && (
                                                <>
                                                    <span className="text-zinc-700 text-xs">·</span>
                                                    <span className="text-[10px] font-mono text-amber-300/80">{discrepancy}</span>
                                                </>
                                            )}
                                            <span className="text-zinc-700 text-xs">·</span>
                                            {po.items.map((item, index) => {
                                                const badgeMatch = lifecycle.checkMatchDetails({ productIds: [item.productId] });
                                                const badgeColor = badgeMatch.isLockedDirect
                                                    ? "text-amber-300 font-bold"
                                                    : badgeMatch.isLockedBom
                                                    ? "text-amber-400/90 font-semibold"
                                                    : badgeMatch.isDirect
                                                    ? "text-cyan-300 font-semibold"
                                                    : badgeMatch.isBom
                                                    ? "text-cyan-400/90 font-medium"
                                                    : "text-zinc-200";
                                                const displayQty = item.receivedInWindow !== undefined ? item.receivedInWindow : (item.receivedQuantity ?? item.quantity);
                                                return (
                                                    <span key={`${item.productId}-${index}`} className={`text-sm font-mono ${badgeColor}`}>
                                                        {item.productId}
                                                        <span className="text-zinc-400 ml-0.5">×{displayQty.toLocaleString()}</span>
                                                    </span>
                                                );
                                            })}
                                        </div>
                                        {/* For PARTIAL receipts: show per-item detail breakdown */}
                                        {getDynamicReceiptStatus(po) === "partial" && po.items.length > 0 && (
                                            <div className="mt-1.5 space-y-0.5">
                                                {po.items.map((item) => {
                                                    const ordered = item.orderedQuantity ?? item.quantity;
                                                    const received = item.receivedQuantity;
                                                    const open = item.openQuantity;
                                                    const hasReceivedData = received !== undefined;
                                                    return (
                                                        <div key={`${po.orderId}-${item.productId}-detail`} className="text-[10.5px] font-mono">
                                                            <span className="text-zinc-200">{item.productId}</span>
                                                            <span className="text-zinc-500"> ordered </span>
                                                            <span className="text-zinc-300">{fmtQty(ordered)}</span>
                                                            {hasReceivedData ? (
                                                                <>
                                                                    <span className="text-zinc-500"> · received </span>
                                                                    <span className="text-cyan-300">{fmtQty(received)}</span>
                                                                    {(open ?? 0) > 0 && (
                                                                        <>
                                                                            <span className="text-zinc-500"> · </span>
                                                                            <span className="text-rose-300">short {fmtQty(open)}</span>
                                                                        </>
                                                                    )}
                                                                </>
                                                            ) : (
                                                                <span className="text-zinc-600"> · received unknown</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        {po.receiptHistory && po.receiptHistory.length > 0 && (
                                            <div className="mt-1 space-y-0.5 border-l border-amber-500/30 pl-2">
                                                {po.receiptHistory.map((receipt, index) => (
                                                    <div key={`${po.orderId}-${receipt.shipmentId || index}`} className="text-[10.5px] font-mono text-zinc-400">
                                                        <span className="text-amber-300">rcv{index + 1} {fmtDateTime(receipt.receiveDateTime || receipt.receiveDate)}</span>
                                                        {receipt.receivedBy && <span className="text-cyan-300/70"> by {receipt.receivedBy}</span>}
                                                        <span className="text-zinc-600"> · </span>
                                                        <span className="text-zinc-300">{receiptItemsText(receipt.items)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {/* ── Pre-completion Match Comparison View ── */}
                                                                                <div className="mt-2.5 pt-2 border-t border-zinc-800/50 bg-zinc-900/10 px-2.5 py-2 rounded">
                                                                                    {/* Document Reference Links */}
                                                                                    {(() => {
                                                                                        const rec = po._reconciliation;
                                                                                        const apLabel = apStatus?.label || "";
                                                                                        const isComplete = apLabel === "RECONCILED" && getDynamicReceiptStatus(po) === "full";
                                                                                        return (
                                                                                            <>
                                                                                                {rec?.matchedInvoice && !isComplete && (
                                                                                                    <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono mb-2">
                                                                                                        <span className="text-zinc-600">📎</span>
                                                                                                        <span className="text-zinc-500">{rec.matchedInvoice.invoice_number}</span>
                                                                                                        {rec.matchedInvoice.pdf_storage_path && (
                                                                                                            <a
                                                                                                                href={`/api/storage/invoice-pdf?id=${encodeURIComponent(rec.matchedInvoice.invoice_number)}`}
                                                                                                                target="_blank"
                                                                                                                rel="noopener noreferrer"
                                                                                                                onClick={e => e.stopPropagation()}
                                                                                                                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-500/30"
                                                                                                            >
                                                                                                                View Invoice PDF
                                                                                                            </a>
                                                                                                        )}
                                                                                                        {rec.matchedInvoice.source_ref && (
                                                                                                            <a
                                                                                                                href={`https://mail.google.com/mail/u/0/#inbox/${rec.matchedInvoice.source_ref}`}
                                                                                                                target="_blank"
                                                                                                                rel="noopener noreferrer"
                                                                                                                onClick={e => e.stopPropagation()}
                                                                                                                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-500/30"
                                                                                                            >
                                                                                                                View in Gmail
                                                                                                            </a>
                                                                                                        )}
                                                                                                        <a
                                                                                                            href={po.finaleUrl}
                                                                                                            target="_blank"
                                                                                                            rel="noopener noreferrer"
                                                                                                            onClick={e => e.stopPropagation()}
                                                                                                            className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2 decoration-emerald-500/30"
                                                                                                        >
                                                                                                            View PO in Finale
                                                                                                        </a>
                                                                                                    </div>
                                                                                                )}

                                                                                                {/* Next-action badge */}
                                                                                                {!isComplete && (
                                                                                                    <div className="mb-2">
                                                                                                        <span className="text-[10px] font-mono text-zinc-500">
                                                                                                            {getNextActionText(po, apLabel)}
                                                                                                        </span>
                                                                                                    </div>
                                                                                                )}
                                                                                            </>
                                                                                        );
                                                                                    })()}

                                                                                    {/* MatchComparisonView */}
                                                                                    <MatchComparisonView
                                                                                        po={po}
                                                                                        apLabel={apStatus?.label || ""}
                                                                                        diff={comparisonPO.has(po.orderId) ? modifyingPO.get(po.orderId)?.diff : undefined}
                                                                                        loading={comparisonPO.has(po.orderId) && (modifyingPO.get(po.orderId)?.loading ?? false)}
                                                                                        error={comparisonPO.has(po.orderId) ? modifyingPO.get(po.orderId)?.error : undefined}
                                                                                        saving={modifyingPO.get(po.orderId)?.saving ?? false}
                                                                                        onToggle={() => toggleComparison(po.orderId)}
                                                                                        onComplete={() => handleCompletePO(po.orderId, po.supplier)}
                                                                                        onApply={(adjustments, freight) => {
                                                                                            applyPOInvoiceModification(po.orderId, adjustments, freight);
                                                                                        }}
                                                                                    />
                                                                                </div>

                                                                                {/* ── Gate Refusal Banner ── */}
                                                                                {gateBlockReason.has(po.orderId) && (() => {
                                                                                    const reason = gateBlockReason.get(po.orderId)!;
                                                                                    return (
                                                                                        <div className="mt-2 px-3 py-2.5 border border-rose-500/30 bg-rose-950/15 rounded flex items-start gap-2">
                                                                                            <span className="text-rose-400 text-[11px] mt-0.5 shrink-0">🚫</span>
                                                                                            <div className="flex-1 min-w-0">
                                                                                                <div className="text-[10px] font-mono text-rose-400 font-semibold uppercase tracking-wider mb-0.5">3-Way Match Gate Refused</div>
                                                                                                <div className="text-[11px] font-mono text-rose-200/90 leading-relaxed">{reason}</div>
                                                                                            </div>
                                                                                            <button
                                                                                                onClick={() => setGateBlockReason(prev => { const next = new Map(prev); next.delete(po.orderId); return next; })}
                                                                                                className="text-rose-400/40 hover:text-rose-300 shrink-0 text-[11px]"
                                                                                            >✕</button>
                                                                                        </div>
                                                                                    );
                                                                                })()}

                                                                                                {/* ── PO Modifier Inline Expansion ── */}
                                                        {modifyingPO.has(po.orderId) && (() => {
                                                        const m = modifyingPO.get(po.orderId)!;
                                                        if (m.loading) {
                                                        return (
                                                            <div className="mt-2 px-3 py-3 border border-cyan-500/20 bg-cyan-950/10 rounded">
                                                                <span className="text-[11px] font-mono text-cyan-300/70 animate-pulse">Loading invoice-PO diff...</span>
                                                            </div>
                                                        );
                                                        }
                                                        if (m.error) {
                                                        return (
                                                            <div className="mt-2 px-3 py-3 border border-rose-500/30 bg-rose-950/10 rounded">
                                                                <span className="text-[11px] font-mono text-rose-400">⚠ {m.error}</span>
                                                                <button onClick={() => toggleModifier(po.orderId)} className="ml-2 text-[10px] font-mono text-zinc-500 hover:text-zinc-300">Close</button>
                                                            </div>
                                                        );
                                                        }
                                                        const diff = m.diff;
                                                        if (!diff || !diff.hasChanges) {
                                                        return (
                                                            <div className="mt-2 px-3 py-3 border border-emerald-500/20 bg-emerald-950/10 rounded">
                                                                <div className="flex items-center justify-between">
                                                                    <span className="text-[11px] font-mono text-emerald-400">✅ PO matches invoice — no adjustments needed</span>
                                                                    <div className="flex items-center gap-2">
                                                                                                                                                <button
                                                                                                                                                    onClick={e => {
                                                                                                                                                        e.stopPropagation();
                                                                                                                                                        handleCompletePO(po.orderId, po.supplier);
                                                                                                                                                    }}
                                                                                                                                                    className="px-2 py-1 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer transition-colors"
                                                                                                                                                >
                                                                                                                                                    Complete PO
                                                                                                                                                </button>
                                                                        <button onClick={() => toggleModifier(po.orderId)} className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300">Close</button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                        }
                                                        // Has changes: show diff table + apply button
                                                        const hasVerifiedStep = diff.totalDiff != null && Math.abs(diff.totalDiff) < 0.01;
                                                        return (
                                                        <div className="mt-2 border border-amber-500/30 bg-amber-950/10 rounded overflow-hidden">
                                                            <div className="px-3 py-2 border-b border-amber-500/20 flex items-center justify-between">
                                                                <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300/80">PO-Invoice Variance</span>
                                                                <span className="text-[10px] font-mono text-zinc-500">
                                                                    Total: PO ${diff.poTotal.toFixed(2)} → Invoice ${(diff.invoiceTotal ?? diff.poTotal).toFixed(2)}
                                                                    {diff.totalDiff != null && (
                                                                        <span className={`ml-1 ${diff.totalDiff > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                                                            ({diff.totalDiff > 0 ? '+' : ''}{diff.totalDiff.toFixed(2)})
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            </div>
                                                            {/* Per-line-item diff table */}
                                                            <div className="px-3 py-2 space-y-1.5">
                                                                {diff.lineItems.filter((li: any) => li.quantityDiff !== null || li.priceDiff !== null).map((li: any) => (
                                                                    <div key={li.productId} className="flex items-center gap-2 text-[10px] font-mono">
                                                                        <span className="w-16 truncate text-zinc-200 font-semibold">{li.productId}</span>
                                                                        {li.quantityDiff !== null && (
                                                                            <span className={li.quantityDiff > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                                                                                qty: {li.poQuantity} → {li.invoiceQuantity}
                                                                                <span className="text-zinc-600 ml-0.5">({li.quantityDiff > 0 ? '+' : ''}{li.quantityDiff})</span>
                                                                            </span>
                                                                        )}
                                                                        {li.priceDiff !== null && (
                                                                            <span className={li.priceDiff > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                                                                                ${li.poUnitPrice.toFixed(2)} → ${li.invoiceUnitPrice?.toFixed(2)}
                                                                                <span className="text-zinc-600 ml-0.5">({li.priceDiff > 0 ? '+' : ''}${li.priceDiff.toFixed(2)})</span>
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                                {diff.freightDiff != null && (
                                                                    <div className="flex items-center gap-2 text-[10px] font-mono pt-1 border-t border-zinc-700/40">
                                                                        <span className="text-zinc-400">Freight</span>
                                                                        <span className={diff.freightDiff > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                                                                            ${diff.poFreight.toFixed(2)} → ${(diff.invoiceFreight ?? 0).toFixed(2)}
                                                                            <span className="text-zinc-600 ml-0.5">({diff.freightDiff > 0 ? '+' : ''}${diff.freightDiff.toFixed(2)})</span>
                                                                        </span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {/* Apply / Cancel buttons */}
                                                            <div className="px-3 py-2 border-t border-amber-500/20 flex items-center gap-2 justify-end">
                                                                <button
                                                                    onClick={() => toggleModifier(po.orderId)}
                                                                    className="px-2 py-1 rounded text-[10px] font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-700/40 hover:border-zinc-600 transition-colors"
                                                                >
                                                                    Cancel
                                                                </button>
                                                                <button
                                                                    onClick={e => {
                                                                        e.stopPropagation();
                                                                        const adjustments = diff.lineItems
                                                                            .filter((li: any) => li.quantityDiff !== null || li.priceDiff !== null)
                                                                            .map((li: any) => ({
                                                                                productId: li.productId,
                                                                                newQuantity: li.invoiceQuantity ?? undefined,
                                                                                newUnitPrice: li.invoiceUnitPrice ?? undefined,
                                                                            }));
                                                                        applyPOInvoiceModification(po.orderId, adjustments, diff.invoiceFreight != null ? diff.invoiceFreight : null);
                                                                        }}
                                                                        disabled={m.saving}
                                                                        className={`px-3 py-1 rounded text-[10px] font-mono font-semibold transition-colors ${m.saving
                                                                            ? 'bg-amber-500/10 text-amber-400/50 border border-amber-500/30 cursor-wait'
                                                                            : 'bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 cursor-pointer'
                                                                        }`}
                                                                        >
                                                                        {m.saving ? 'Applying...' : 'Apply Changes to PO'}
                                                                        </button>
                                                                        /* Apply & Complete — apply modifications, then complete through gate-checked API */
                                                                                                                                                <button
                                                                                                                                                onClick={e => {
                                                                                                                                                    e.stopPropagation();
                                                                                                                                                    const adjustments = diff.lineItems
                                                                                                                                                        .filter((li: any) => li.quantityDiff !== null || li.priceDiff !== null)
                                                                                                                                                        .map((li: any) => ({
                                                                                                                                                            productId: li.productId,
                                                                                                                                                            newQuantity: li.invoiceQuantity ?? undefined,
                                                                                                                                                            newUnitPrice: li.invoiceUnitPrice ?? undefined,
                                                                                                                                                        }));
                                                                                                                                                    // Apply modifications first, then complete through gate
                                                                                                                                                    applyPOInvoiceModification(po.orderId, adjustments, diff.invoiceFreight != null ? diff.invoiceFreight : null)
                                                                                                                                                        .then(() => {
                                                                                                                                                            handleCompletePO(po.orderId, po.supplier);
                                                                                                                                                        });
                                                                                                                                                }}
                                                                        disabled={m.saving}
                                                                        className="px-3 py-1 rounded text-[10px] font-mono font-semibold transition-colors bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
                                                                        >
                                                                        Apply & Complete PO
                                                                        </button>
                                                            </div>
                                                        </div>
                                                        );
                                                        })()}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {!embedded && !loading && !error && pos.length > 0 && (
                        <div onMouseDown={startResize}
                            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60" />
                    )}
                            </div>
                            )}
                </div>
            )}
        </div>
    );
}
