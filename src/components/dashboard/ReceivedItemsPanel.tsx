"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase";

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    receiveDate: string;
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

export default function ReceivedItemsPanel() {
    const [pos, setPos]         = useState<ReceivedPO[]>([]);
    const [apMap, setApMap]     = useState<ApStatusMap>({});
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    // Resizable height — persisted
    const containerRef = useRef<HTMLDivElement>(null);
    const [bodyHeight, setBodyHeight] = useState(220);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-recv-h");
        if (s) setBodyHeight(Math.max(80, Math.min(600, parseInt(s))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-recv-h", String(bodyHeight)); }, [bodyHeight]);

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

    // Fetch real AP status from ap_activity_log
    useEffect(() => {
        const supabase = createBrowserClient();
        supabase
            .from("ap_activity_log")
            .select("metadata,action_taken")
            .eq("intent", "INVOICE")
            .order("created_at", { ascending: false })
            .limit(200)
            .then((res: { data: Array<{ metadata: any; action_taken: string }> | null }) => {
                const data = res.data;
                if (!data) return;
                const map: ApStatusMap = {};
                for (const row of data) {
                    const id = String(row.metadata?.orderId || "");
                    if (!id || map[id]) continue;  // first (most recent) wins
                    const a = (row.action_taken || "").toLowerCase();
                    if (a.includes("pending") || a.includes("flagged") || a.includes("approval")) {
                        map[id] = { label: "PENDING", cls: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
                    } else if (a.includes("applied") || a.includes("matched") || a.includes("reconcil")) {
                        map[id] = { label: "MATCHED", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" };
                    } else if (a.includes("forwarded") || a.includes("bill.com")) {
                        map[id] = { label: "FWDED", cls: "text-blue-400 border-blue-500/20 bg-blue-500/5" };
                    }
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
            setPos(data.received || []);
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
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Receivings</span>
                <span className="text-xs text-zinc-700">14d</span>
                <div className="flex-1" />
                {!loading && pos.length > 0 && (
                    <span className="text-xs font-mono text-zinc-500">{pos.length} POs</span>
                )}
                <button onClick={() => fetch14d(true)} disabled={refreshing}
                    className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {loading ? (
                <div className="px-4 py-2 flex items-center gap-2 text-zinc-700">
                    <div className="w-3 h-3 border border-zinc-700 border-t-transparent rounded-full animate-spin shrink-0" />
                    <span className="text-xs font-mono">Loading…</span>
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
                        return (
                            <div key={po.orderId} className="px-4 py-2.5 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
                                {/* Line 1: date · vendor · AP status · total */}
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-xs font-mono text-zinc-600 shrink-0">{fmtDateTime(po.receiveDate)}</span>
                                    <span className="text-sm font-semibold text-zinc-100 truncate">{po.supplier}</span>
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
        </div>
    );
}
