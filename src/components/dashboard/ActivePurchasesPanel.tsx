"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, RefreshCw, ChevronDown, ExternalLink, X } from "lucide-react";

type ActivePurchase = {
    orderId: string;
    vendorName: string;
    status: string;
    orderDate: string;
    expectedDate: string;
    receiveDate: string | null;
    total: number;
    items: Array<{ productId: string; quantity: number }>;
    finaleUrl: string;
    leadProvenance: string;
    trackingNumbers?: string[];
};

type ApiResponse = {
    purchases: ActivePurchase[];
    cachedAt: string;
    error?: string;
};

// Returns e.g. "Mar 3, 2026"
function fmtDate(dateStr: string | null | undefined): string {
    if (!dateStr) return "Unknown";
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function timeAgo(iso: string) {
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return "";
    const m = Math.floor(ms / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default function ActivePurchasesPanel() {
    const [purchases, setPurchases] = useState<ActivePurchase[]>([]);
    const [cachedAt, setCachedAt] = useState("");
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Dismissal state
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    useEffect(() => {
        const stored = localStorage.getItem("aria-dash-purchases-dismissed");
        if (stored) {
            try {
                setDismissed(new Set(JSON.parse(stored)));
            } catch (e) { }
        }
    }, []);

    const dismissPurchase = (orderId: string) => {
        setDismissed((prev) => {
            const next = new Set(prev);
            next.add(orderId);
            localStorage.setItem("aria-dash-purchases-dismissed", JSON.stringify(Array.from(next)));
            return next;
        });
    };

    // Resizable height — persisted
    const containerRef = useRef<HTMLDivElement>(null);
    const [bodyHeight, setBodyHeight] = useState(300);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);

    useEffect(() => {
        const s = localStorage.getItem("aria-dash-apch-h");
        if (s) setBodyHeight(Math.max(80, Math.min(800, parseInt(s))));
    }, []);

    useEffect(() => {
        localStorage.setItem("aria-dash-apch-h", String(bodyHeight));
    }, [bodyHeight]);

    // Collapse state
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-apch-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => {
        localStorage.setItem("aria-dash-apch-collapsed", String(isCollapsed));
    }, [isCollapsed]);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(80, Math.min(800, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    const fetchPurchases = useCallback(async (silent = false) => {
        silent ? setRefreshing(true) : setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/dashboard/active-purchases");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: ApiResponse = await res.json();
            if (data.error) throw new Error(data.error);
            setPurchases(data.purchases || []);
            setCachedAt(data.cachedAt || "");
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchPurchases();
        const t = setInterval(() => fetchPurchases(true), 15 * 60 * 1000); // 15m
        return () => clearInterval(t);
    }, [fetchPurchases]);

    const visiblePurchases = purchases.filter((po) => !dismissed.has(po.orderId));

    return (
        <div className="border-b border-zinc-800 shrink-0" ref={containerRef}>
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50">
                <ListChecks className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Active Purchases</span>
                {cachedAt && !refreshing && <span className="text-xs text-zinc-700">{timeAgo(cachedAt)}</span>}
                {refreshing && <span className="text-xs text-zinc-600 font-mono">refreshing…</span>}
                <div className="flex-1" />

                {!loading && visiblePurchases.length > 0 && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-blue-500/10 text-blue-400 border-blue-500/20">
                        {visiblePurchases.length} POs
                    </span>
                )}

                {dismissed.size > 0 && (
                    <button
                        onClick={() => {
                            localStorage.removeItem("aria-dash-purchases-dismissed");
                            setDismissed(new Set());
                        }}
                        className="text-[10px] font-mono text-zinc-600 hover:text-red-400 px-1.5 ml-1 transition-colors"
                        title="Clear dismissed"
                    >
                        clear dismissed ({dismissed.size})
                    </button>
                )}

                <button onClick={() => fetchPurchases(true)} disabled={refreshing}
                    className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
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
                        <div className="px-4 py-3 flex items-center gap-2 text-zinc-700">
                            <div className="w-3 h-3 border border-zinc-700 border-t-transparent rounded-full animate-spin shrink-0" />
                            <span className="text-xs font-mono">Loading active POs...</span>
                        </div>
                    ) : error ? (
                        <div className="px-4 py-3 border-t border-zinc-800/60"><span className="text-xs font-mono text-rose-400">{error}</span></div>
                    ) : visiblePurchases.length === 0 ? (
                        <div className="px-4 py-3 border-t border-zinc-800/60"><span className="text-xs font-mono text-zinc-600">No active purchases.</span></div>
                    ) : (
                        <div className="overflow-y-auto border-t border-zinc-800/60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50" style={{ height: bodyHeight }}>
                            {visiblePurchases.map(po => {
                                const isReceived = po.status.toLowerCase() === "completed";
                                const isCancelled = po.status.toLowerCase() === "cancelled";

                                let statusLabel = "In Transit";
                                let statusColor = "text-blue-400 bg-blue-500/10 border-blue-500/30";

                                if (isReceived) {
                                    statusLabel = "Received";
                                    statusColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
                                } else if (isCancelled) {
                                    statusLabel = "Cancelled";
                                    statusColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
                                }

                                return (
                                    <div key={po.orderId} className="px-4 py-3 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors group relative">
                                        {/* Dismiss Button */}
                                        <button
                                            onClick={() => dismissPurchase(po.orderId)}
                                            className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 p-1 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 rounded transition-all"
                                            title="Dismiss PO"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>

                                        {/* Line 1: Vendor, Date, Tags */}
                                        <div className="flex items-center gap-2 min-w-0 pr-8">
                                            <span className="text-sm font-semibold text-zinc-100 truncate">{po.vendorName}</span>
                                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${statusColor}`}>
                                                {statusLabel}
                                            </span>
                                            {po.total > 0 && (
                                                <span className="text-xs font-mono text-zinc-400 shrink-0 ml-auto mr-1">
                                                    ${po.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                </span>
                                            )}
                                        </div>

                                        {/* Line 2: Links and Schedule text */}
                                        <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-zinc-500">
                                            <a href={po.finaleUrl} target="_blank" rel="noopener noreferrer"
                                                className="text-blue-500 hover:text-blue-400 transition-colors inline-flex items-center gap-1 shrink-0">
                                                {po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                            </a>
                                            <span className="text-zinc-700">·</span>

                                            {isReceived && po.receiveDate ? (
                                                <span>Rcvd {fmtDate(po.receiveDate)}</span>
                                            ) : (
                                                <span>Exp: <span className="text-zinc-300">{fmtDate(po.expectedDate)}</span> <span className="opacity-50">({po.leadProvenance})</span></span>
                                            )}

                                            {po.trackingNumbers && po.trackingNumbers.length > 0 && (
                                                <>
                                                    <span className="text-zinc-700">·</span>
                                                    <span className="text-zinc-400">Trk: {po.trackingNumbers.map(t => {
                                                        const dt = t.includes(":::") ? t.split(":::")[1] : t;
                                                        return dt;
                                                    }).join(", ")}</span>
                                                </>
                                            )}
                                        </div>

                                        {/* Line 3: Line Items */}
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                                            {po.items.map((item, idx) => (
                                                <span key={item.productId + idx} className="text-[11px] font-mono text-zinc-300 bg-zinc-800/40 px-1.5 py-px rounded border border-zinc-700/50">
                                                    {item.productId} <span className="text-zinc-500">×{item.quantity.toLocaleString()}</span>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {!loading && !error && visiblePurchases.length > 0 && (
                        <div onMouseDown={startResize}
                            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60" />
                    )}
                </>
            )}
        </div>
    );
}
