"use client";

import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";

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
        matchedInvoice: { invoice_number: string; subtotal: number; freight: number; tax: number; total: number; status: string } | null;
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

function hasPartialLineQuantities(po: ReceivedPO): boolean {
    return po.items.some(item => item.receivedQuantity !== undefined || item.receivedInWindow !== undefined);
}

function receiptItemsText(items: Array<{ productId: string; quantity: number }>): string {
    if (items.length === 0) return "receipt recorded; line quantities unavailable";
    return items.map(item => `${item.productId} ×${fmtQty(item.quantity)}`).join(", ");
}

export default function ReceivedItemsPanel() {
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
            if (res.ok) {
                fetchReceivings(true);
            }
        } catch (e: any) {
            console.error("Complete PO error:", e.message);
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
        silent ? setRefreshing(true) : setLoading(true);
        setError(null);
        try {
            const [receivingsRes, trackingRes] = await Promise.all([
                fetch('/api/dashboard/receivings'),
                fetch('/api/dashboard/tracking'),
            ]);

            if (!receivingsRes.ok) throw new Error(`HTTP ${receivingsRes.status}`);
            const data = await receivingsRes.json();
            if (data.error) throw new Error(data.error);
            const sorted = [...(data.received || [])].sort((a, b) => receiveSortValue(b) - receiveSortValue(a));

            // Notify Ordering when new receipt IDs appear so purchasing cache busts.
            const nextIds = sorted.map((p: ReceivedPO) => String(p.orderId)).filter(Boolean);
            const prev = knownReceiptIdsRef.current;
            if (prev.size > 0) {
                const fresh = nextIds.filter((id: string) => !prev.has(id));
                if (fresh.length > 0) {
                    lifecycle.notifyReceipt(fresh);
                }
            }
            knownReceiptIdsRef.current = new Set(nextIds);
            setPos(sorted);
            setMatchSuggestions(data.matchSuggestions || []);
            setFreightClasses(data.freightClasses || {});

            if (trackingRes.ok) {
                const trackingData = await trackingRes.json();
                setTodaySummary(trackingData.todaySummary || null);
            } else {
                setTodaySummary(null);
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [lifecycle]);

    useEffect(() => {
        fetchReceivings();
        const t = setInterval(() => fetchReceivings(true), 10 * 60 * 1000);
        return () => clearInterval(t);
    }, [fetchReceivings]);

    return (
        <div className="border-b border-zinc-800 shrink-0" ref={containerRef}>
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Receivings</span>
                <span className="text-[10px] text-[var(--dash-ts)] font-mono">WTD</span>
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
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {loading ? (
                        <div className="px-4 py-2 space-y-2.5">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="skeleton-shimmer h-3.5" style={{ width: `${30 + i * 12}%` }} />
                                    <div className="skeleton-shimmer h-3 w-16 ml-auto" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-rose-400">{error}</span></div>
                    ) : pos.length === 0 ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-zinc-700">No receivings in 30d window</span></div>
                    ) : (
                        <div className="overflow-y-auto border-t border-zinc-800/60" style={{ height: bodyHeight }}>
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

                            {/* ── Match Suggestions: unmatched invoices with PO candidates ── */}
                            {matchSuggestions.length > 0 && (
                                <div className="border-b border-amber-500/20 bg-amber-500/5">
                                    <div className="px-4 py-2 flex items-center gap-2">
                                        <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-amber-300/80">
                                            Needs PO Match
                                        </span>
                                        <span className="text-[10px] font-mono text-amber-500/60">
                                            {matchSuggestions.length} invoice{matchSuggestions.length > 1 ? "s" : ""}
                                        </span>
                                    </div>
                                    {matchSuggestions.map(s => {
                                        const best = s.candidates[0];
                                        const scoreColor = best.score >= 80 ? "text-emerald-400" : best.score >= 60 ? "text-amber-400" : "text-zinc-400";
                                        return (
                                            <div key={s.invoiceId} className="px-4 py-2 border-t border-amber-500/10 hover:bg-amber-500/5 transition-colors">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-mono text-zinc-200 font-semibold">{s.invoiceNumber}</span>
                                                    <span className="text-[10px] font-mono text-zinc-500">{s.vendorName}</span>
                                                    <span className="text-[10px] font-mono text-zinc-400 ml-auto">
                                                        ${Number(s.invoiceTotal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                    </span>
                                                </div>
                                                {best && (
                                                    <div className="mt-1.5 flex items-center gap-2">
                                                        <span className={`text-[10px] font-mono ${scoreColor}`}>
                                                            {best.score}% → PO {best.orderId}
                                                        </span>
                                                        <span className="text-[9px] font-mono text-zinc-600">
                                                            {best.reasons.slice(0, 2).join(" · ")}
                                                        </span>
                                                        <div className="flex-1" />
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleMatchInvoice(s.invoiceId, best.orderId); }}
                                                            className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                                                        >
                                                            Match
                                                        </button>
                                                        {s.candidates.length > 1 && (
                                                            <span className="text-[9px] font-mono text-zinc-600">
                                                                +{s.candidates.length - 1} alt
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {pos.map(po => {
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
                                        onMouseEnter={() => lifecycle.setFocus({ source: "rcv", vendorName: po.supplier, orderId: po.orderId, productIds: poProductIds })}
                                        onMouseLeave={lifecycle.clearFocus}
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
                                            <span className="text-sm font-semibold text-zinc-100 truncate">{po.supplier}</span>
                                            {receiptBadge(po) && (
                                                <span className={`text-[10px] font-mono px-1 py-px rounded border shrink-0 ${receiptBadge(po)!.cls}`}>
                                                    {receiptBadge(po)!.label}
                                                </span>
                                            )}
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
                                            {(() => {
                                                const apLabel = apStatus?.label || "";
                                                const txt = getNextActionText(po, apLabel);
                                                const short = txt.replace(/ —.*$/, "");
                                                return (
                                                    <span className="text-[10px] font-mono text-zinc-500 italic shrink-0">· {short}</span>
                                                );
                                            })()}
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
                                        {/* ── PO Lifecycle State: next-action guidance ── */}
                                        <div className="mt-2.5 pt-2 border-t border-zinc-800/50 flex flex-wrap items-center gap-2 bg-zinc-900/10 px-2.5 py-2 rounded">
                                            {(() => {
                                                const receiptStatus = getDynamicReceiptStatus(po);
                                                const apLabel = apStatus?.label || "";
                                                const rec = po._reconciliation;
                                                const isPartial = receiptStatus === "partial";
                                                const hasOpenQty = po.items.some(i => (i.openQuantity ?? 0) > 0);
                                                const hasInvoice = apLabel !== "UNMATCHED" && apLabel !== "";
                                                const isReconciled = apLabel === "RECONCILED" || apLabel === "RECONCILED ±" || receiptStatus === "full" && apLabel === "RECONCILED";
                                                const isPendingReview = apLabel === "PENDING";
                                                const hasDiscrepancy = apLabel === "RECONCILED ±";
                                                const isComplete = isReconciled && receiptStatus === "full" && !hasDiscrepancy;

                                                // ── State classification ──
                                                // Checks _reconciliation first (direct from API), falls back to apStatus
                                                let state: { emoji: string; label: string; tone: string; action: string } | null = null;

                                                if (rec?.hasAutoApplied && rec?.matchedInvoice) {
                                                    state = { emoji: "✅", label: "APPLIED", tone: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", action: `Invoice ${rec.matchedInvoice.invoice_number} — $${rec.matchedInvoice.total?.toFixed(2)} applied to PO` };
                                                } else if (rec?.hasPendingApproval && rec?.matchedInvoice) {
                                                    state = { emoji: "🔍", label: "PENDING APPROVAL", tone: "text-amber-300 border-amber-500/40 bg-amber-500/10", action: `Invoice ${rec.matchedInvoice.invoice_number}: $${rec.matchedInvoice.total?.toFixed(2)} vs PO $${po.total?.toLocaleString()} — review` };
                                                } else if (rec?.matchedInvoice) {
                                                    state = { emoji: "📋", label: "MATCHED", tone: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10", action: `Invoice ${rec.matchedInvoice.invoice_number} $${rec.matchedInvoice.total?.toFixed(2)} matched` };
                                                } else if (rec) {
                                                    state = { emoji: "📋", label: "AWAITING MATCH", tone: "text-zinc-400 border-zinc-600/40 bg-zinc-800/40", action: "No invoice matched yet" };
                                                } else if (isComplete) {
                                                    state = { emoji: "✅", label: "COMPLETE", tone: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", action: "PO closed — no action needed" };
                                                } else if (hasDiscrepancy && isReconciled) {
                                                    state = { emoji: "⚠️", label: "RECONCILED ±", tone: "text-blue-400 border-blue-500/30 bg-blue-500/10", action: "Reconciled with pricing differences — verify final amounts" };
                                                } else if (hasDiscrepancy) {
                                                    state = { emoji: "⚠️", label: "PRICE DISCREPANCY", tone: "text-rose-300 border-rose-500/40 bg-rose-500/10", action: "Invoice $ differs from PO $ — resolve with vendor before closing" };
                                                } else if (isPendingReview) {
                                                    state = { emoji: "🔍", label: "MATCH INVOICE", tone: "text-amber-300 border-amber-500/40 bg-amber-500/10", action: "Invoice matched — review line items and approve reconciliation" };
                                                } else if (isPartial && hasOpenQty) {
                                                    state = { emoji: "🔄", label: "PARTIAL", tone: "text-amber-300 border-amber-500/40 bg-amber-500/10", action: "Partial receipt — backorder remains. No action until remaining arrives" };
                                                } else if (hasInvoice) {
                                                    state = { emoji: "📋", label: "VERIFY RECEIPT", tone: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10", action: "Received in full — verify invoice matches PO qty & price" };
                                                } else {
                                                    state = { emoji: "📋", label: "RECEIVED", tone: "text-zinc-400 border-zinc-600/40 bg-zinc-800/40", action: "Receipt recorded — awaiting invoice match" };
                                                }

                                                return (
                                                    <>
                                                        {/* Left: State badge only (action text on Line 2) */}
                                                        <div className="flex items-center gap-2 shrink-0">
                                                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${state.tone}`} title={state.action}>
                                                                {state.emoji} {state.label}
                                                            </span>
                                                        </div>

                                                        {/* Expanded approval card — shows exactly what is being approved */}
                                                        {rec?.hasPendingApproval && rec?.matchedInvoice && (
                                                            <div className="mt-2 w-full bg-amber-500/5 border border-amber-500/20 rounded px-2.5 py-2">
                                                                <div className="text-[10px] font-mono text-amber-300/80 mb-1">Invoice {rec.matchedInvoice.invoice_number} from {po.supplier}</div>
                                                                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
                                                                    <span className="text-zinc-500">Subtotal</span>
                                                                    <span className="text-zinc-300 text-right">{rec.matchedInvoice.subtotal != null ? '$' + rec.matchedInvoice.subtotal.toFixed(2) : '—'}</span>
                                                                    <span className="text-zinc-500">Freight</span>
                                                                    <span className="text-zinc-300 text-right">+{rec.matchedInvoice.freight != null ? '$' + rec.matchedInvoice.freight.toFixed(2) : '$0.00'}</span>
                                                                    <span className="text-zinc-500">Tax</span>
                                                                    <span className="text-zinc-300 text-right">+{rec.matchedInvoice.tax != null ? '$' + rec.matchedInvoice.tax.toFixed(2) : '$0.00'}</span>
                                                                    <span className="border-t border-zinc-700/50 pt-0.5 text-zinc-400">Total</span>
                                                                    <span className="border-t border-zinc-700/50 pt-0.5 text-amber-300 text-right font-semibold">{rec.matchedInvoice.total != null ? '$' + rec.matchedInvoice.total.toFixed(2) : '—'}</span>
                                                                </div>
                                                                {rec.matchedInvoice.total != null && po.total > 0 && rec.matchedInvoice.total !== po.total && (
                                                                    <div className="mt-1 text-[10px] font-mono text-rose-400">
                                                                        {rec.matchedInvoice.total > po.total ? '+' : ''}{Math.abs(rec.matchedInvoice.total - po.total).toFixed(2)} vs PO total {po.total}
                                                                    </div>
                                                                )}
                                                                <button
                                                                    onClick={e => { e.stopPropagation(); approveReconciliation(po.orderId, rec!.matchedInvoice!.invoice_number); }}
                                                                    disabled={approvingReconcile.has(po.orderId)}
                                                                    className={`mt-2 w-full text-center text-[11px] font-mono font-semibold px-2 py-1 rounded border cursor-pointer transition-colors ${approvingReconcile.has(po.orderId) ? 'opacity-50 cursor-wait bg-amber-500/10 border-amber-500/30 text-amber-400/50' : 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'}`}
                                                                >
                                                                    {approvingReconcile.has(po.orderId) ? 'Applying...' : 'Approve & Apply to Finale'}
                                                                </button>
                                                            </div>
                                                        )}

                                                        {/* Right: Verification badges */}
                                                        <div className="flex-1" />
                                                        <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-mono shrink-0">
                                                            {po.items.some(i => (i.receivedQuantity ?? 0) > 0) && (
                                                                <span className="flex items-center gap-1 text-emerald-400/80 px-1 py-0.5 rounded bg-emerald-500/5 border border-emerald-500/20">
                                                                    <span className="w-1 h-1 rounded-full bg-emerald-500"></span>
                                                                    {po.items.reduce((s, i) => s + (i.receivedQuantity ?? 0), 0)} units rcvd
                                                                </span>
                                                            )}
                                                            {isPartial && hasOpenQty && (
                                                                <span className="text-amber-300/80 px-1 py-0.5 rounded border border-amber-500/20 bg-amber-500/5">
                                                                    {po.items.reduce((s, i) => s + (i.openQuantity ?? 0), 0)} open
                                                                </span>
                                                            )}
                                                            {hasInvoice && !isPendingReview && !hasDiscrepancy && (
                                                                <span className="flex items-center gap-1 text-emerald-400/80 px-1 py-0.5 rounded bg-emerald-500/5 border border-emerald-500/20">
                                                                    <span className="w-1 h-1 rounded-full bg-emerald-500"></span>
                                                                    Invoice Matched
                                                                </span>
                                                            )}
                                                            {isPendingReview && apStatus && (
                                                                <button
                                                                    onClick={e => { e.stopPropagation(); approveReconciliation(po.orderId); }}
                                                                    disabled={approvingReconcile.has(po.orderId)}
                                                                    className={`px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${approvingReconcile.has(po.orderId) ? 'opacity-50 cursor-wait' : 'hover:bg-amber-500/20'} ${apStatus.cls}`}
                                                                    title="Approve reconciliation"
                                                                >
                                                                    {approvingReconcile.has(po.orderId) ? "saving…" : "✓ Approve"}
                                                                </button>
                                                            )}
                                                            {rec?.hasPendingApproval && !apStatus && (
                                                                <button
                                                                    onClick={e => { e.stopPropagation(); approveReconciliation(po.orderId); }}
                                                                    disabled={approvingReconcile.has(po.orderId)}
                                                                    className={`px-1.5 py-0.5 rounded border cursor-pointer transition-colors text-amber-300 border-amber-500/40 bg-amber-500/10 ${approvingReconcile.has(po.orderId) ? 'opacity-50 cursor-wait' : 'hover:bg-amber-500/20'}`}
                                                                    title="Approve reconciliation"
                                                                >
                                                                    {approvingReconcile.has(po.orderId) ? "saving…" : "✓ Approve"}
                                                                </button>
                                                            )}
                                                            {hasDiscrepancy && (
                                                                <span className="flex items-center gap-1 text-rose-300/80 px-1 py-0.5 rounded border border-rose-500/20 bg-rose-500/5">
                                                                    ⚠️ Price mismatch
                                                                </span>
                                                            )}
                                                        </div>
                                                    </>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {!loading && !error && pos.length > 0 && (
                        <div onMouseDown={startResize}
                            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60" />
                    )}
                </>
            )}
        </div>
    );
}
