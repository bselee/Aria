"use client";

import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase";

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    receiveDate: string;
    receiveDateTime?: string;
    receiptStatus?: "full" | "partial" | "received";
    supplier: string;
    total: number;
    items: Array<{ productId: string; quantity: number }>;
    finaleUrl: string;
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
    const today = new Date(), yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    const dStr = d.toLocaleDateString('en-CA', { ...opts });
    const todayStr = today.toLocaleDateString('en-CA', { ...opts });
    const yesterdayStr = yest.toLocaleDateString('en-CA', { ...opts });
    let datePart: string;
    if (dStr === todayStr) datePart = 'Today';
    else if (dStr === yesterdayStr) datePart = 'Yest';
    else datePart = d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' });
    if (isDateOnly) return datePart;
    const timePart = d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
}

function fmtDollars(n: number): string {
    if (!n || n <= 1) return '';   // skip $0 and $1 placeholder totals
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function receiptBadge(po: ReceivedPO): { label: string; cls: string } | null {
    if (po.receiptStatus === "full") {
        return { label: "FULL", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" };
    }
    if (po.receiptStatus === "partial") {
        return { label: "PARTIAL", cls: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
    }
    return null;
}

function receiveSortValue(po: ReceivedPO): number {
    const parsed = parseDenverDate(po.receiveDateTime || po.receiveDate);
    return parsed?.getTime() ?? 0;
}

function partialDiscrepancy(po: ReceivedPO): string | null {
    if (po.receiptStatus !== "partial" || po.items.length === 0) return null;
    const skuList = po.items.map(item => item.productId).filter(Boolean);
    if (skuList.length === 0) return "partial receipt";
    if (skuList.length <= 2) return `short on ${skuList.join(", ")}`;
    return `short on ${skuList.slice(0, 2).join(", ")} +${skuList.length - 2} more`;
}

export default function ReceivedItemsPanel() {
    const [pos, setPos] = useState<ReceivedPO[]>([]);
    const [apMap, setApMap] = useState<ApStatusMap>({});
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    const fetch14d = useCallback(async (silent = false) => {
        silent ? setRefreshing(true) : setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/dashboard/receivings?days=14');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const sorted = [...(data.received || [])].sort((a, b) => receiveSortValue(b) - receiveSortValue(a));
            setPos(sorted);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetch14d();
        const t = setInterval(() => fetch14d(true), 10 * 60 * 1000);
        return () => clearInterval(t);
    }, [fetch14d]);

    return (
        <div className="border-b border-zinc-800 shrink-0" ref={containerRef}>
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Receivings</span>
                <span className="text-[10px] text-[var(--dash-ts)] font-mono">14d</span>
                <div className="flex-1" />
                {!loading && pos.length > 0 && (
                    <span className="text-xs font-mono text-zinc-500">{pos.length} POs</span>
                )}
                <button onClick={() => fetch14d(true)} disabled={refreshing}
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
                        <div className="px-4 py-2"><span className="text-xs font-mono text-zinc-700">No receivings in the last 14 days</span></div>
                    ) : (
                        <div className="overflow-y-auto border-t border-zinc-800/60" style={{ height: bodyHeight }}>
                            {pos.map(po => {
                                const apStatus = apMap[po.orderId];
                                const dollars = fmtDollars(po.total);
                                const discrepancy = partialDiscrepancy(po);
                                return (
                                    <div key={po.orderId} className="px-4 py-2.5 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
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
                                                <span className={`text-[10px] font-mono px-1 py-px rounded border shrink-0 ${apStatus.cls}`}>
                                                    {apStatus.label}
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
                                            {discrepancy && (
                                                <>
                                                    <span className="text-zinc-700 text-xs">·</span>
                                                    <span className="text-[10px] font-mono text-amber-300/80">{discrepancy}</span>
                                                </>
                                            )}
                                            <span className="text-zinc-700 text-xs">·</span>
                                            {po.items.map(item => (
                                                <span key={item.productId} className="text-sm font-mono text-zinc-200">
                                                    {item.productId}
                                                    <span className="text-zinc-400 ml-0.5">×{item.quantity.toLocaleString()}</span>
                                                </span>
                                            ))}
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
