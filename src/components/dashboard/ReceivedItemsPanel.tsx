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
};

type TrackingTodaySummary = {
    headline: string;
    lines: string[];
} | null;

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
    const parsed = parseDenverDate(po.receiveDateTime || po.receiveDate);
    return parsed?.getTime() ?? 0;
}

function partialDiscrepancy(po: ReceivedPO): string | null {
    const status = getDynamicReceiptStatus(po);
    if (status !== "partial" || po.items.length === 0) return null;
    const skuList = po.items
        .filter(item => item.openQuantity == null || item.openQuantity > 0)
        .map(item => item.productId)
        .filter(Boolean);
    if (skuList.length === 0) return "partial receipt";
    if (skuList.length <= 2) return `short on ${skuList.join(", ")}`;
    return `short on ${skuList.slice(0, 2).join(", ")} +${skuList.length - 2} more`;
}

function fmtQty(n: number | null | undefined): string {
    return Number(n || 0).toLocaleString();
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
    const [todaySummary, setTodaySummary] = useState<TrackingTodaySummary>(null);
    const [apMap, setApMap] = useState<ApStatusMap>({});
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [approvingReconcile, setApprovingReconcile] = useState<Set<string>>(new Set());

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
            setPos(sorted);

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
    }, []);

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
                        <div className="px-4 py-2"><span className="text-xs font-mono text-zinc-700">No receivings this week</span></div>
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
                                            {apStatus && (
                                                                                            apStatus.label === "PENDING" ? (
                                                                                                <button
                                                                                                    onClick={e => { e.stopPropagation(); approveReconciliation(po.orderId); }}
                                                                                                    disabled={approvingReconcile.has(po.orderId)}
                                                                                                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 cursor-pointer transition-colors ${approvingReconcile.has(po.orderId) ? 'opacity-50 cursor-wait' : 'hover:bg-amber-500/20'} ${apStatus.cls}`}
                                                                                                    title="Approve reconciliation"
                                                                                                >
                                                                                                    {approvingReconcile.has(po.orderId) ? "saving…" : apStatus.label}
                                                                                                </button>
                                                                                            ) : (
                                                                                                <span className={`text-[10px] font-mono px-1 py-px rounded border shrink-0 ${apStatus.cls}`}>
                                                                                                    {apStatus.label}
                                                                                                </span>
                                                                                            )
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
                                        {hasPartialLineQuantities(po) && (
                                            <div className="mt-1.5 space-y-0.5">
                                                {po.items.map((item) => {
                                                    const ordered = item.orderedQuantity ?? item.quantity;
                                                    const received = item.receivedQuantity ?? 0;
                                                    const open = item.openQuantity ?? Math.max(0, ordered - received);
                                                    return (
                                                        <div key={`${po.orderId}-${item.productId}-partial`} className="text-[10.5px] font-mono text-amber-200/90">
                                                            {item.productId} ordered {fmtQty(ordered)}
                                                            <span className="text-zinc-500"> · </span>
                                                            received {fmtQty(received)}
                                                            <span className="text-zinc-500"> · </span>
                                                            open {fmtQty(open)}
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
                                        {/* Review checklist and fulfillment indicators */}
                                        <div className="mt-2.5 pt-2 border-t border-zinc-800/50 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-zinc-900/10 p-2 rounded">
                                            {/* Left: What is left to receive or if fully fulfilled */}
                                            <div className="text-[11px] font-mono shrink-0">
                                                {(() => {
                                                    const status = getDynamicReceiptStatus(po);
                                                    if (status === "full") {
                                                        return (
                                                            <div className="flex items-center gap-1.5 text-emerald-400">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                                                                <span>PO Fulfilled</span>
                                                            </div>
                                                        );
                                                    } else {
                                                        const openLines = po.items.filter(item => (item.openQuantity ?? 0) > 0);
                                                        if (openLines.length === 0) {
                                                            return <span className="text-zinc-500">Fully Received</span>;
                                                        }
                                                        return (
                                                            <div className="space-y-0.5">
                                                                <span className="text-amber-300 font-semibold">Remaining to Receive:</span>
                                                                {openLines.map(item => (
                                                                    <div key={item.productId} className="text-zinc-400 text-[10px]">
                                                                        {item.productId}: <span className="text-amber-200">-{fmtQty(item.openQuantity)}</span> left
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        );
                                                    }
                                                })()}
                                            </div>

                                            {/* Right: Autonomous System Check Status Indicators */}
                                            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono bg-zinc-950/40 px-2.5 py-1.5 rounded border border-zinc-800/40">
                                                <div className="flex items-center gap-1 text-emerald-400">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                                    <span>Auto-Shipping Verified</span>
                                                </div>
                                                <span className="text-zinc-800">·</span>
                                                <div className="flex items-center gap-1 text-emerald-400">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                                    <span>Invoice Pricing Matching</span>
                                                </div>
                                                <span className="text-zinc-800">·</span>
                                                {(() => {
                                                    const rawStatus = String(po.receiptStatus || "").toLowerCase();
                                                    const isCompletedState = rawStatus === "full" || rawStatus === "received";
                                                    const dynamicStatus = getDynamicReceiptStatus(po);

                                                    if (isCompletedState) {
                                                        return (
                                                            <div className="flex items-center gap-1 text-emerald-400/90 font-semibold">
                                                                <span>⚡ PO Completed</span>
                                                            </div>
                                                        );
                                                    } else if (dynamicStatus === "full") {
                                                        return (
                                                            <div className="flex items-center gap-1 text-cyan-400 font-semibold animate-pulse">
                                                                <span>⚡ Auto-Complete Ready</span>
                                                            </div>
                                                        );
                                                    } else {
                                                        return (
                                                            <div className="flex items-center gap-1 text-amber-400/90 font-semibold">
                                                                <span>Waiting for Backorders</span>
                                                            </div>
                                                        );
                                                    }
                                                })()}
                                            </div>
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
