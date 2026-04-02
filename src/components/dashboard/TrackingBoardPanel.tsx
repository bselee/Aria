"use client";

import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Search, Truck } from "lucide-react";

type ShipmentRollup = {
    id: string;
    poNumbers: string[];
    vendorNames: string[];
    trackingNumber: string;
    carrierName: string | null;
    statusCategory: string;
    statusDisplay: string;
    estimatedDeliveryAt: string | null;
    deliveredAt: string | null;
    publicTrackingUrl: string | null;
    freshnessMinutes: number | null;
};

type TrackingApiResponse = {
    board: {
        arrivingToday: ShipmentRollup[];
        outForDelivery: ShipmentRollup[];
        deliveredAwaitingReceipt: ShipmentRollup[];
        exceptions: ShipmentRollup[];
        stale: ShipmentRollup[];
        recentlyDelivered: ShipmentRollup[];
    };
    shipments: ShipmentRollup[];
    asOf: string;
    answer?: {
        primaryLine: string;
        metaLine: string;
    } | null;
    error?: string;
};

function fmtEta(value: string | null | undefined): string {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function freshnessLabel(minutes: number | null | undefined): string {
    if (minutes == null) return "freshness unknown";
    if (minutes < 60) return `fresh ${minutes}m ago`;
    if (minutes < 24 * 60) return `fresh ${Math.round(minutes / 60)}h ago`;
    return `fresh ${Math.round(minutes / (24 * 60))}d ago`;
}

function ShipmentBucket({
    title,
    shipments,
}: {
    title: string;
    shipments: ShipmentRollup[];
}) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500">{title}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
                    {shipments.length}
                </span>
            </div>
            {shipments.length === 0 ? (
                <div className="text-[11px] font-mono text-zinc-600 border border-zinc-800 rounded px-2.5 py-2">
                    none
                </div>
            ) : (
                shipments.map((shipment) => (
                    <div key={shipment.id} className="border border-zinc-800 rounded bg-zinc-900/40 px-2.5 py-2 space-y-1">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-zinc-100 truncate">
                                {shipment.poNumbers[0] || shipment.trackingNumber}
                            </span>
                            <span className="ml-auto text-[10px] font-mono text-zinc-500">
                                {shipment.carrierName || "Carrier"}
                            </span>
                        </div>
                        <div className="text-[11px] text-zinc-300">
                            {shipment.vendorNames[0] || "Unknown vendor"} • {shipment.statusDisplay}
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500">
                            {shipment.estimatedDeliveryAt ? `ETA ${fmtEta(shipment.estimatedDeliveryAt)} • ` : ""}
                            {freshnessLabel(shipment.freshnessMinutes)}
                        </div>
                        {shipment.publicTrackingUrl && (
                            <a
                                href={shipment.publicTrackingUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] font-mono text-blue-400 hover:text-blue-300"
                            >
                                {shipment.trackingNumber}
                            </a>
                        )}
                    </div>
                ))
            )}
        </div>
    );
}

export default function TrackingBoardPanel({ initialQuery = "" }: { initialQuery?: string }) {
    const [payload, setPayload] = useState<TrackingApiResponse | null>(null);
    const [query, setQuery] = useState(initialQuery);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [bodyHeight, setBodyHeight] = useState(300);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);

    useEffect(() => {
        const collapsed = localStorage.getItem("aria-dash-track-collapsed");
        const height = localStorage.getItem("aria-dash-track-h");
        if (collapsed === "true") setIsCollapsed(true);
        if (height) setBodyHeight(Math.max(160, Math.min(900, parseInt(height, 10))));
    }, []);

    useEffect(() => {
        localStorage.setItem("aria-dash-track-collapsed", String(isCollapsed));
    }, [isCollapsed]);

    useEffect(() => {
        localStorage.setItem("aria-dash-track-h", String(bodyHeight));
    }, [bodyHeight]);

    const fetchBoard = useCallback(async (silent = false, currentQuery = query) => {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError(null);
        try {
            const params = currentQuery ? `?q=${encodeURIComponent(currentQuery)}` : "";
            const res = await fetch(`/api/dashboard/tracking${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: TrackingApiResponse = await res.json();
            if (data.error) throw new Error(data.error);
            setPayload(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [query]);

    useEffect(() => {
        fetchBoard(false, initialQuery);
        const timer = setInterval(() => fetchBoard(true), 5 * 60 * 1000);
        return () => clearInterval(timer);
    }, [fetchBoard, initialQuery]);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(160, Math.min(900, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    const totalVisible = useMemo(() => {
        if (!payload) return 0;
        const { board } = payload;
        return (
            board.arrivingToday.length +
            board.outForDelivery.length +
            board.deliveredAwaitingReceipt.length +
            board.exceptions.length +
            board.stale.length +
            board.recentlyDelivered.length
        );
    }, [payload]);

    return (
        <div className="flex flex-col border border-zinc-800 rounded bg-[#0c0c0e] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-zinc-800/40 transition-colors text-left">
                <Truck className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <span className="text-[11px] font-mono tracking-wider text-zinc-300 uppercase">Tracking Board</span>
                {totalVisible > 0 && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
                        {totalVisible} active
                    </span>
                )}
                <div className="flex-1" />
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        fetchBoard(true);
                    }}
                    className="p-1 rounded hover:bg-zinc-700/50 transition-colors"
                    title="Refresh"
                >
                    <RefreshCw className={`h-3 w-3 text-zinc-500 ${refreshing ? "animate-spin" : ""}`} />
                </button>
                <button
                    onClick={() => setIsCollapsed((current) => !current)}
                    className="p-1 rounded hover:bg-zinc-700/50 transition-colors"
                    title={isCollapsed ? "Expand" : "Collapse"}
                >
                    <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    <div className="px-3 py-2 border-y border-zinc-800/60 bg-zinc-950/50">
                        <div className="flex items-center gap-2 border border-zinc-800 rounded px-2 py-1.5 bg-zinc-900/50">
                            <Search className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") fetchBoard(true, query);
                                }}
                                placeholder="PO, vendor, carrier, tracking"
                                className="bg-transparent border-0 outline-none text-xs font-mono text-zinc-200 w-full"
                            />
                        </div>
                    </div>

                    <div className="overflow-y-auto px-3 py-3 space-y-3" style={{ height: bodyHeight }}>
                        {loading ? (
                            <div className="space-y-2">
                                {[1, 2, 3].map((idx) => (
                                    <div key={idx} className="h-14 rounded bg-zinc-800/40 animate-pulse" />
                                ))}
                            </div>
                        ) : error ? (
                            <div className="text-xs font-mono text-rose-400">{error}</div>
                        ) : !payload ? (
                            <div className="text-xs font-mono text-zinc-600">No tracking data.</div>
                        ) : (
                            <>
                                {payload.answer && (
                                    <div className="border border-blue-500/30 rounded bg-blue-500/10 px-3 py-2">
                                        <div className="text-xs font-semibold text-blue-200">{payload.answer.primaryLine}</div>
                                        <div className="text-[11px] font-mono text-blue-300/80 mt-1">{payload.answer.metaLine}</div>
                                    </div>
                                )}

                                <ShipmentBucket title="Arriving Today" shipments={payload.board.arrivingToday} />
                                <ShipmentBucket title="Out For Delivery" shipments={payload.board.outForDelivery} />
                                <ShipmentBucket title="Delivered Awaiting Receipt" shipments={payload.board.deliveredAwaitingReceipt} />
                                <ShipmentBucket title="Exceptions" shipments={payload.board.exceptions} />
                                <ShipmentBucket title="Stale Shipments" shipments={payload.board.stale} />
                                <ShipmentBucket title="Recently Delivered" shipments={payload.board.recentlyDelivered} />
                            </>
                        )}
                    </div>

                    <div
                        onMouseDown={startResize}
                        className="h-2 cursor-row-resize border-t border-zinc-800 bg-zinc-900/70 hover:bg-zinc-800 transition-colors"
                    />
                </>
            )}
        </div>
    );
}
