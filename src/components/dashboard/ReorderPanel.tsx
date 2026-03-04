"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShoppingCart, RefreshCw, ChevronDown, Plus, ExternalLink } from "lucide-react";

type ReorderItem = {
    productId: string;
    stockoutDays: number | null;
    reorderQty: number | null;
    consumptionQty: number;
    supplierPartyId: string | null;
    supplierName: string;
    unitPrice: number;
};

type ReorderGroup = {
    vendorName: string;
    vendorPartyId: string;
    urgency: "critical" | "warning" | "reorder_flagged";
    items: ReorderItem[];
};

type AssessmentData = {
    groups: ReorderGroup[];
    cachedAt: string;
};

type POResult = { orderId: string; finaleUrl: string };

const URGENCY = {
    critical: {
        badge: "bg-rose-500/20 text-rose-300 border-rose-500/40",
        dot: "bg-rose-500",
        label: "CRIT",
        row: "border-rose-500/10",
    },
    warning: {
        badge: "bg-amber-500/20 text-amber-300 border-amber-500/40",
        dot: "bg-amber-400",
        label: "WARN",
        row: "border-zinc-800/40",
    },
    reorder_flagged: {
        badge: "bg-zinc-700/50 text-zinc-400 border-zinc-600/40",
        dot: "bg-zinc-500",
        label: "FLAG",
        row: "border-zinc-800/40",
    },
} as const;

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

export default function ReorderPanel() {
    const [data, setData] = useState<AssessmentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Per-vendor PO creation state
    const [creatingPO, setCreatingPO] = useState<string | null>(null);
    const [createdPOs, setCreatedPOs] = useState<Record<string, POResult>>({});

    // Expanded vendor rows
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Panel collapse — persisted
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-reorder-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => {
        localStorage.setItem("aria-dash-reorder-collapsed", String(isCollapsed));
    }, [isCollapsed]);

    // Resizable height — persisted
    const [bodyHeight, setBodyHeight] = useState(240);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-reorder-h");
        if (s) setBodyHeight(Math.max(80, Math.min(600, parseInt(s))));
    }, []);
    useEffect(() => {
        localStorage.setItem("aria-dash-reorder-h", String(bodyHeight));
    }, [bodyHeight]);
    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(80, Math.min(600, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    async function load(bust = false) {
        if (bust) setScanning(true);
        else setLoading(true);
        setError(null);
        try {
            const url = bust ? "/api/dashboard/reorder?bust=1" : "/api/dashboard/reorder";
            const res = await fetch(url);
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Failed");
            setData(json);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
            setScanning(false);
        }
    }

    useEffect(() => { load(); }, []);

    function toggleExpand(partyId: string) {
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(partyId) ? next.delete(partyId) : next.add(partyId);
            return next;
        });
    }

    async function createPO(group: ReorderGroup) {
        setCreatingPO(group.vendorPartyId);
        try {
            const items = group.items.map(i => ({
                productId: i.productId,
                quantity: i.reorderQty ?? Math.max(1, Math.ceil((i.consumptionQty / 90) * 30)),
                unitPrice: i.unitPrice,
            }));
            const res = await fetch("/api/dashboard/reorder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    vendorPartyId: group.vendorPartyId,
                    items,
                    memo: "Auto-generated draft — review and commit in Finale",
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Failed");
            setCreatedPOs(prev => ({ ...prev, [group.vendorPartyId]: json }));
        } catch (e: any) {
            setError(`PO failed for ${group.vendorName}: ${e.message}`);
        } finally {
            setCreatingPO(null);
        }
    }

    const critical = data?.groups.filter(g => g.urgency === "critical").length ?? 0;
    const warning = data?.groups.filter(g => g.urgency === "warning").length ?? 0;
    const flagged = data?.groups.filter(g => g.urgency === "reorder_flagged").length ?? 0;
    const isLoading = loading || scanning;

    return (
        <div className="border-b border-zinc-800 shrink-0">
            {/* Header */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50">
                <ShoppingCart className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Reorder</span>
                {data && !scanning && (
                    <span className="text-xs text-zinc-700">{timeAgo(data.cachedAt)}</span>
                )}
                {scanning && (
                    <span className="text-xs text-zinc-600 font-mono">scanning…</span>
                )}
                <div className="flex-1" />

                {/* Urgency badges */}
                {critical > 0 && (
                    <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-rose-500/20 text-rose-300 border-rose-500/40">
                        {critical} CRIT
                    </span>
                )}
                {warning > 0 && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40">
                        {warning} WARN
                    </span>
                )}
                {flagged > 0 && !critical && !warning && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-zinc-700/50 text-zinc-400 border-zinc-600/40">
                        {flagged} FLAG
                    </span>
                )}
                {!isLoading && data?.groups.length === 0 && (
                    <span className="text-xs font-mono text-zinc-600">all clear</span>
                )}

                <button
                    onClick={() => load(true)}
                    disabled={isLoading}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                    title="Re-scan Finale"
                >
                    <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </button>
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {/* Loading skeleton */}
                    {isLoading && !data && (
                        <div className="px-4 py-3 flex items-center gap-2 border-t border-zinc-800/60 text-zinc-700">
                            <div className="w-3 h-3 border border-zinc-700 border-t-transparent rounded-full animate-spin shrink-0" />
                            <span className="text-xs font-mono">Scanning Finale inventory…</span>
                        </div>
                    )}

                    {/* Error state */}
                    {error && (
                        <div className="px-4 py-2 border-t border-zinc-800/60 text-xs font-mono text-rose-400/80">
                            {error}
                        </div>
                    )}

                    {/* Vendor list */}
                    {data && data.groups.length > 0 && (
                        <>
                            <div
                                className="overflow-y-auto border-t border-zinc-800/60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full"
                                style={{ height: bodyHeight }}
                            >
                                {data.groups.map(group => {
                                    const cfg = URGENCY[group.urgency];
                                    const isExpanded = expanded.has(group.vendorPartyId);
                                    const isCreating = creatingPO === group.vendorPartyId;
                                    const po = createdPOs[group.vendorPartyId];

                                    return (
                                        <div key={group.vendorPartyId} className={`border-b ${cfg.row}`}>
                                            {/* Vendor row */}
                                            <div className="flex items-center gap-2 px-4 py-2 hover:bg-zinc-800/20 transition-colors">
                                                <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />

                                                {/* Vendor name + item count — click to expand */}
                                                <button
                                                    onClick={() => toggleExpand(group.vendorPartyId)}
                                                    className="flex-1 text-left flex items-center gap-2 min-w-0"
                                                >
                                                    <span className="text-sm font-mono font-semibold text-zinc-100 truncate">
                                                        {group.vendorName}
                                                    </span>
                                                    <span className="text-[11px] font-mono text-zinc-600 shrink-0">
                                                        {group.items.length} SKU{group.items.length !== 1 ? "s" : ""}
                                                    </span>
                                                </button>

                                                {/* Urgency badge */}
                                                <span className={`text-[10px] font-mono px-1 py-0.5 rounded border shrink-0 ${cfg.badge}`}>
                                                    {cfg.label}
                                                </span>

                                                {/* PO result or create button */}
                                                {po ? (
                                                    <a
                                                        href={po.finaleUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 hover:text-emerald-300 shrink-0"
                                                        title="Open in Finale"
                                                    >
                                                        PO #{po.orderId}
                                                        <ExternalLink className="w-2.5 h-2.5" />
                                                    </a>
                                                ) : (
                                                    <button
                                                        onClick={() => createPO(group)}
                                                        disabled={isCreating || !!creatingPO}
                                                        className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition-colors disabled:opacity-40 shrink-0"
                                                        title="Create draft PO in Finale"
                                                    >
                                                        {isCreating
                                                            ? <div className="w-2 h-2 border border-zinc-600 border-t-transparent rounded-full animate-spin" />
                                                            : <Plus className="w-2.5 h-2.5" />
                                                        }
                                                        Draft PO
                                                    </button>
                                                )}

                                                <ChevronDown
                                                    className={`w-3.5 h-3.5 text-zinc-700 transition-transform shrink-0 ${isExpanded ? "" : "-rotate-90"}`}
                                                />
                                            </div>

                                            {/* Expanded SKU rows */}
                                            {isExpanded && (
                                                <div className="bg-zinc-950/40 border-t border-zinc-800/30">
                                                    {group.items.map(item => {
                                                        const urgDot =
                                                            item.stockoutDays !== null && item.stockoutDays < 14
                                                                ? "bg-rose-500"
                                                                : item.stockoutDays !== null && item.stockoutDays < 45
                                                                    ? "bg-amber-400"
                                                                    : "bg-zinc-600";
                                                        const orderedQty = item.reorderQty ?? Math.max(1, Math.ceil((item.consumptionQty / 90) * 30));
                                                        return (
                                                            <div
                                                                key={item.productId}
                                                                className="flex items-center gap-2 px-7 py-1.5 border-b border-zinc-800/20 last:border-0 text-xs font-mono"
                                                            >
                                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${urgDot}`} />
                                                                <span className="text-zinc-200 flex-1 truncate">{item.productId}</span>
                                                                <span className="text-zinc-600 shrink-0">
                                                                    out: {item.stockoutDays !== null ? `${item.stockoutDays}d` : "—"}
                                                                </span>
                                                                <span className="text-zinc-500 shrink-0">
                                                                    qty: {orderedQty}
                                                                </span>
                                                                {item.unitPrice > 0 && (
                                                                    <span className="text-zinc-700 shrink-0">
                                                                        ${item.unitPrice.toFixed(2)}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Resize handle */}
                            <div
                                onMouseDown={startResize}
                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                title="Drag to resize"
                            />
                        </>
                    )}

                    {/* All clear */}
                    {!isLoading && data?.groups.length === 0 && (
                        <div className="px-4 py-3 border-t border-zinc-800/60 text-xs font-mono text-zinc-600">
                            All stocking items are within safe levels.
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
