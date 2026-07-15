"use client";

import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown } from "lucide-react";
import { createClient as createBrowserClient } from "@/lib/db";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import POFlowStepper from "./POFlowStepper";
import type { POFlowStep } from "./POFlowStepper";

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
    /** Computed: count of POs needing human attention */
    const needsReviewCount = pos.filter(p => {
        const lbl = apMap[p.orderId]?.label || "";
        return lbl === "RECONCILED ±" || lbl === "PENDING" || lbl === "UNMATCHED" || lbl === "";
    }).length;
    /** Manual match state: invoiceId → manual PO input */
    const [manuallyMatching, setManuallyMatching] = useState<Map<string, { poNumber: string; loading: boolean }>>(new Map());

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
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
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
                                        const mm = manuallyMatching.get(s.invoiceId);
                                        const hasCandidates = s.candidates.length > 0;
                                        return (
                                            <div key={s.invoiceId} className="px-4 py-2 border-t border-amber-500/10 hover:bg-amber-500/5 transition-colors">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-mono text-zinc-200 font-semibold">{s.invoiceNumber}</span>
                                                    <span className="text-[10px] font-mono text-zinc-500">{s.vendorName}</span>
                                                    {s.invoiceDate && <span className="text-[9px] font-mono text-zinc-600">{s.invoiceDate}</span>}
                                                    <span className="text-[10px] font-mono text-zinc-400 ml-auto">
                                                        ${Number(s.invoiceTotal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                    </span>
                                                </div>

                                                {hasCandidates ? (
                                                    /* ── Auto-suggested candidate(s) ── */
                                                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                                                        {(() => {
                                                            const scoreColor = best.score >= 80 ? "text-emerald-400" : best.score >= 60 ? "text-amber-400" : "text-zinc-400";
                                                            return (
                                                                <>
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
                                                                </>
                                                            );
                                                        })()}
                                                    </div>
                                                ) : (
                                                    /* ── No auto-match found → manual matching ── */
                                                    <div className="mt-1.5 flex items-center gap-2">
                                                        <span className="text-[10px] font-mono text-zinc-500">No auto-match found —</span>
                                                        <input
                                                            type="text"
                                                            placeholder="Enter PO #..."
                                                            value={mm?.poNumber || ""}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                setManuallyMatching(prev => {
                                                                    const next = new Map(prev);
                                                                    next.set(s.invoiceId, { poNumber: val, loading: false });
                                                                    return next;
                                                                });
                                                            }}
                                                            onClick={e => e.stopPropagation()}
                                                            className="w-28 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50"
                                                        />
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleManualMatch(s.invoiceId); }}
                                                            disabled={!mm?.poNumber.trim() || mm?.loading}
                                                            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${mm?.loading ? "opacity-50 cursor-wait" : ""} border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20`}
                                                        >
                                                            {mm?.loading ? "Matching..." : "Manual Match"}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

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
                                    className="w-full px-4 py-1 text-[10px] font-mono text-zinc-600 hover:text-zinc-400 border-b border-zinc-800/40 transition-colors text-left"
                                >
                                    {showAllReceived ? "− Show only items needing review" : `+ Show all ${pos.length} received POs`}
                                </button>
                            )}
                            {pos
                                .filter(po => {
                                    if (showAllReceived) return true;
                                    const lbl = apMap[po.orderId]?.label || "";
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
                                        {/* ── PO Lifecycle State: 3-step flow + action ── */}
                                        <div className="mt-2.5 pt-2 border-t border-zinc-800/50 bg-zinc-900/10 px-2.5 py-2 rounded">
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

                                                // ── Build 3-step flow ──
                                                // Step 1: Received (always done if we're in Receivings)
                                                // Step 2: Invoice Matched
                                                // Step 3: Complete PO

                                                const steps: POFlowStep[] = [
                                                    { label: "Received", emoji: "📦", state: "done" },
                                                ];

                                                // Determine Step 2 and Step 3 states
                                                if (rec?.hasAutoApplied && rec?.matchedInvoice) {
                                                    // Fully applied — all done
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done" });
                                                    steps.push({ label: "Complete", emoji: "🔒", state: "done" });
                                                } else if (rec?.hasPendingApproval && rec?.matchedInvoice) {
                                                    // Invoice matched, pending approval → need to complete
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done" });
                                                    steps.push({
                                                        label: "Complete", emoji: "🔒", state: "active",
                                                        action: `Invoice ${rec.matchedInvoice.invoice_number}: $${rec.matchedInvoice.total?.toFixed(2)} vs PO $${po.total?.toLocaleString()}`,
                                                        actionButton: {
                                                            text: "Approve & Complete",
                                                            onClick: () => approveReconciliation(po.orderId, rec!.matchedInvoice!.invoice_number),
                                                            loading: approvingReconcile.has(po.orderId),
                                                            tone: "warning",
                                                        },
                                                    });
                                                } else if (rec?.matchedInvoice) {
                                                    // Invoice matched, no pending action → ready to complete
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done",
                                                        action: `Invoice ${rec.matchedInvoice.invoice_number} $${rec.matchedInvoice.total?.toFixed(2)}` });
                                                    steps.push({
                                                        label: "Complete", emoji: "🔒", state: "active",
                                                        action: "Verify invoice matches PO qty & price, then complete",
                                                        actionButton: {
                                                            text: "Complete PO",
                                                            onClick: () => toggleModifier(po.orderId, rec!.matchedInvoice!.invoice_number),
                                                            tone: "success",
                                                        },
                                                    });
                                                } else if (isComplete) {
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done" });
                                                    steps.push({ label: "Complete", emoji: "🔒", state: "done" });
                                                } else if (hasDiscrepancy && isReconciled) {
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done" });
                                                    steps.push({
                                                        label: "Complete", emoji: "🔒", state: "issue",
                                                        action: "Reconciled with pricing differences — verify final amounts",
                                                        actionButton: {
                                                            text: "Review Diff",
                                                            onClick: () => toggleModifier(po.orderId, rec?.matchedInvoice?.invoice_number),
                                                            tone: "warning",
                                                        },
                                                    });
                                                } else if (hasDiscrepancy) {
                                                    steps.push({
                                                        label: "Invoice", emoji: "📄", state: "issue",
                                                        action: "Invoice $ differs from PO $ — resolve with vendor",
                                                        actionButton: {
                                                            text: "Modify PO",
                                                            onClick: () => toggleModifier(po.orderId, rec?.matchedInvoice?.invoice_number),
                                                            tone: "danger",
                                                        },
                                                    });
                                                    steps.push({ label: "Complete", emoji: "🔒", state: "pending" });
                                                } else if (isPendingReview || isPartial) {
                                                    // Invoice matched but needs review, OR partial receipt awaiting rest
                                                    steps.push({
                                                        label: "Invoice", emoji: "📄", state: isPendingReview ? "active" : "done",
                                                        action: isPendingReview
                                                            ? "Invoice matched — review line items and approve"
                                                            : "Partial receipt — backorder remains",
                                                        actionButton: isPendingReview ? {
                                                            text: "Approve",
                                                            onClick: () => approveReconciliation(po.orderId),
                                                            loading: approvingReconcile.has(po.orderId),
                                                            tone: "warning",
                                                        } : undefined,
                                                    });
                                                    steps.push({ label: "Complete", emoji: "🔒", state: isPendingReview ? "active" : "pending" });
                                                } else if (hasInvoice) {
                                                    // Invoice exists but not in a known state → verify
                                                    steps.push({ label: "Invoice", emoji: "📄", state: "done" });
                                                    steps.push({
                                                        label: "Complete", emoji: "🔒", state: "active",
                                                        action: "Received in full — verify invoice matches PO qty & price",
                                                        actionButton: {
                                                            text: "Verify & Complete",
                                                            onClick: () => toggleModifier(po.orderId),
                                                            tone: "success",
                                                        },
                                                    });
                                                } else {
                                                    // No invoice yet
                                                    steps.push({
                                                        label: "Invoice", emoji: "📄", state: "active",
                                                        action: "Receipt recorded — awaiting invoice match",
                                                    });
                                                    steps.push({ label: "Complete", emoji: "🔒", state: "pending" });
                                                }

                                                return (
                                                    <>
                                                        <div className="w-full">
                                                            <POFlowStepper steps={steps} compact />
                                                        </div>

                                                        {/* Expanded approval card — shows exactly what's being approved */}
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
                                                            </div>
                                                        )}

                                                        {/* ── Document Reference Links ── */}
                                                        {rec?.matchedInvoice && (
                                                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-mono">
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
                                                    </>
                                                );
                                            })()}
                                        </div>

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
                                                                                fetch('/api/dashboard/po-modify', {
                                                                                    method: 'POST',
                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                    body: JSON.stringify({
                                                                                        action: 'verify_and_complete',
                                                                                        orderId: po.orderId,
                                                                                        invoiceId: rec?.matchedInvoice?.invoice_number,
                                                                                    }),
                                                                                })
                                                                                .then(r => r.json())
                                                                                .then(result => {
                                                                                    if (result.success) {
                                                                                        setModifySuccess(`PO ${po.orderId} completed ✅`);
                                                                                        toggleModifier(po.orderId);
                                                                                        setTimeout(() => fetchReceivings(true), 1500);
                                                                                    }
                                                                                })
                                                                                .catch(() => {});
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
                                                                        {/* Verify & Complete — PO totals match invoice, ready to close */}
                                                                        <button
                                                                        onClick={e => {
                                                                            e.stopPropagation();
                                                                            // First apply modifications, then verify & complete
                                                                            const adjustments = diff.lineItems
                                                                                .filter((li: any) => li.quantityDiff !== null || li.priceDiff !== null)
                                                                                .map((li: any) => ({
                                                                                    productId: li.productId,
                                                                                    newQuantity: li.invoiceQuantity ?? undefined,
                                                                                    newUnitPrice: li.invoiceUnitPrice ?? undefined,
                                                                                }));
                                                                            // Apply modifications first
                                                                            applyPOInvoiceModification(po.orderId, adjustments, diff.invoiceFreight != null ? diff.invoiceFreight : null)
                                                                                .then(() => {
                                                                                    // Then verify & complete
                                                                                    fetch('/api/dashboard/po-modify', {
                                                                                        method: 'POST',
                                                                                        headers: { 'Content-Type': 'application/json' },
                                                                                        body: JSON.stringify({
                                                                                            action: 'verify_and_complete',
                                                                                            orderId: po.orderId,
                                                                                            invoiceId: rec?.matchedInvoice?.invoice_number,
                                                                                        }),
                                                                                    })
                                                                                    .then(r => r.json())
                                                                                    .then(result => {
                                                                                        if (result.success) {
                                                                                            setModifySuccess(`PO ${po.orderId} modified and completed ✅`);
                                                                                            setTimeout(() => fetchReceivings(true), 1500);
                                                                                        }
                                                                                    })
                                                                                    .catch(() => {});
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

                    {!loading && !error && pos.length > 0 && (
                        <div onMouseDown={startResize}
                            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60" />
                    )}
                </>
            )}
        </div>
    );
}
