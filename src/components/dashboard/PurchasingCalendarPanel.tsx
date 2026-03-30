/**
 * @file    PurchasingCalendarPanel.tsx
 * @purpose Day-by-day view of expected PO deliveries with overdue flags
 *          and estimated ETAs for items that haven't been received.
 * @author  Will
 * @created 2026-03-25
 * @updated 2026-03-25
 * @deps    lucide-react, active-purchases API
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, RefreshCw, ChevronDown, AlertTriangle, CheckCircle2, Clock, ExternalLink, Package } from "lucide-react";
import { RECEIVED_DASHBOARD_RETENTION_DAYS } from "@/lib/purchasing/calendar-lifecycle";

// ── Types ────────────────────────────────────────────────────────
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
    isReceived: boolean;
};

type DayGroup = {
    dateKey: string;        // YYYY-MM-DD
    label: string;          // "Today", "Tomorrow", "Thu Mar 27", etc.
    isToday: boolean;
    isPast: boolean;
    purchases: ActivePurchase[];
};

// ── Helpers ──────────────────────────────────────────────────────

/** Returns "Today", "Tomorrow", "Yesterday", or "Wed Mar 26" */
function friendlyDate(dateKey: string, todayKey: string): string {
    const d = new Date(dateKey + "T12:00:00");
    const today = new Date(todayKey + "T12:00:00");
    const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Format a date string as "Mar 25" */
function shortDate(dateStr: string | null): string {
    if (!dateStr) return "??";
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days between two YYYY-MM-DD dates (positive = future, negative = past) */
function daysDiff(from: string, to: string): number {
    const a = new Date(from + "T12:00:00").getTime();
    const b = new Date(to + "T12:00:00").getTime();
    return Math.round((b - a) / 86_400_000);
}

function todayKey(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

/** Build clickable carrier tracking URL */
function carrierUrl(trackingNumber: string): string {
    const raw = trackingNumber.includes(":::") ? trackingNumber.split(":::")[1] : trackingNumber;
    const carrier = trackingNumber.includes(":::") ? trackingNumber.split(":::")[0].toLowerCase() : "";

    if (carrier.includes("old dominion") || carrier.includes("odfl")) return `https://www.odfl.com/trace/Trace.jsp?pro=${raw}`;
    if (carrier.includes("saia")) return `https://www.saia.com/tracking?pro=${raw}`;
    if (carrier.includes("estes")) return `https://www.estes-express.com/tracking?pro=${raw}`;
    if (carrier.includes("xpo")) return `https://app.xpo.com/track/pro/${raw}`;
    if (carrier.includes("dayton")) return `https://www.daytonfreight.com/tracking/?pro=${raw}`;
    if (carrier.includes("fedex freight")) return `https://www.fedex.com/fedextrack/?tracknumbers=${raw}`;
    if (carrier.includes("r&l") || carrier.includes("r+l")) return `https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro=${raw}`;

    if (/^1Z[A-Z0-9]{16}$/i.test(raw)) return `https://www.ups.com/track?tracknum=${raw}`;
    if (/^(94|92|93|95)\d{20}$/.test(raw)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${raw}`;
    if (/^(96\d{18}|\d{15}|\d{12})$/.test(raw)) return `https://www.fedex.com/fedextrack/?tracknumbers=${raw}`;
    if (/^JD\d{18}$/i.test(raw)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${raw}`;

    return `https://parcelsapp.com/en/tracking/${raw}`;
}

// ── Component ────────────────────────────────────────────────────
export default function PurchasingCalendarPanel() {
    const [purchases, setPurchases] = useState<ActivePurchase[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [bodyHeight, setBodyHeight] = useState(400);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);

    // ── Persistence ──
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-pcal-collapsed");
        if (s === "true") setIsCollapsed(true);
        const h = localStorage.getItem("aria-dash-pcal-h");
        if (h) setBodyHeight(Math.max(120, Math.min(800, parseInt(h))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-pcal-collapsed", String(isCollapsed)); }, [isCollapsed]);
    useEffect(() => { localStorage.setItem("aria-dash-pcal-h", String(bodyHeight)); }, [bodyHeight]);

    // ── Resize handle ──
    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = ev.clientY - dragRef.current.startY;
            setBodyHeight(Math.max(120, Math.min(800, dragRef.current.startH + delta)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    // ── Fetch data ──
    const fetchData = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true); else setLoading(true);
        setError(null);
        try {
            const resp = await fetch("/api/dashboard/active-purchases");
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            setPurchases(data.purchases || []);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);
    // Auto-refresh every 5 minutes
    useEffect(() => {
        const id = setInterval(() => fetchData(true), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, [fetchData]);

    // ── Build day groups ──
    const today = todayKey();

    // Only unreceived committed POs
    const pending = purchases.filter(p => !p.isReceived);

    // Group by expected date
    const grouped = new Map<string, ActivePurchase[]>();
    for (const po of pending) {
        const key = po.expectedDate || today;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(po);
    }

    // Sort date keys chronologically
    const sortedKeys = Array.from(grouped.keys()).sort();

    // Build day groups
    const dayGroups: DayGroup[] = sortedKeys.map(dateKey => ({
        dateKey,
        label: friendlyDate(dateKey, today),
        isToday: dateKey === today,
        isPast: dateKey < today,
        purchases: grouped.get(dateKey)!,
    }));

    // Separate overdue vs today vs upcoming
    const overdue = dayGroups.filter(g => g.isPast);
    const todayGroup = dayGroups.find(g => g.isToday);
    const upcoming = dayGroups.filter(g => !g.isPast && !g.isToday);

    const overdueCount = overdue.reduce((s, g) => s + g.purchases.length, 0);
    const todayCount = todayGroup?.purchases.length || 0;

    // Recently received (last few days, aligned with server retention)
    const recentlyReceived = purchases.filter(p => {
        if (!p.isReceived || !p.receiveDate) return false;
        const diff = daysDiff(p.receiveDate.split("T")[0], today);
        return diff >= 0 && diff <= RECEIVED_DASHBOARD_RETENTION_DAYS;
    });

    // ── Render ──
    return (
        <div className="flex flex-col border border-zinc-800 rounded bg-[#0c0c0e] overflow-hidden">
            {/* Header */}
            <button
                onClick={() => setIsCollapsed(c => !c)}
                className="flex items-center gap-2 px-3 py-2.5 bg-[#0c0c0e] hover:bg-zinc-800/40 transition-colors w-full text-left group"
            >
                <Calendar className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <span className="text-[11px] font-mono tracking-wider text-zinc-300 uppercase">
                    Purchasing Calendar
                </span>

                {overdueCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-red-500/20 text-red-400 border border-red-500/30 rounded leading-none animate-pulse">
                        {overdueCount} OVERDUE
                    </span>
                )}

                {todayCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded leading-none">
                        {todayCount} TODAY
                    </span>
                )}

                <span className="flex-1" />

                <button
                    onClick={e => { e.stopPropagation(); fetchData(true); }}
                    className="p-1 rounded hover:bg-zinc-700/50 transition-colors"
                    title="Refresh"
                >
                    <RefreshCw className={`h-3 w-3 text-zinc-500 ${refreshing ? "animate-spin" : ""}`} />
                </button>

                <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
            </button>

            {/* Body */}
            {!isCollapsed && (
                <>
                    <div
                        className="overflow-y-auto overflow-x-hidden px-3 py-2 space-y-3"
                        style={{ maxHeight: bodyHeight }}
                    >
                        {loading ? (
                            <div className="space-y-2">
                                {[...Array(4)].map((_, i) => (
                                    <div key={i} className="h-12 rounded bg-zinc-800/40 animate-pulse" />
                                ))}
                            </div>
                        ) : error ? (
                            <p className="text-xs text-red-400 py-4 text-center">{error}</p>
                        ) : pending.length === 0 ? (
                            <div className="flex flex-col items-center py-6 text-zinc-500 text-xs">
                                <CheckCircle2 className="h-6 w-6 mb-2 text-emerald-500/60" />
                                <span>All POs received — nothing pending.</span>
                            </div>
                        ) : (
                            <>
                                {/* ── OVERDUE ── */}
                                {overdue.length > 0 && (
                                    <DaySection
                                        title={`⚠️ OVERDUE — ${overdueCount} PO${overdueCount !== 1 ? "s" : ""}`}
                                        groups={overdue}
                                        variant="overdue"
                                        today={today}
                                    />
                                )}

                                {/* ── TODAY ── */}
                                {todayGroup && (
                                    <DaySection
                                        title={`📦 TODAY — ${todayCount} expected`}
                                        groups={[todayGroup]}
                                        variant="today"
                                        today={today}
                                    />
                                )}

                                {/* ── UPCOMING ── */}
                                {upcoming.length > 0 && (
                                    <DaySection
                                        title="📅 UPCOMING"
                                        groups={upcoming}
                                        variant="upcoming"
                                        today={today}
                                    />
                                )}

                                {/* ── RECENTLY RECEIVED ── */}
                                {recentlyReceived.length > 0 && (
                                    <div className="border-t border-zinc-800/50 pt-2 mt-3">
                                        <h3 className="text-[10px] font-mono uppercase tracking-wider text-emerald-500/70 mb-1.5">
                                            ✅ Recently Received ({recentlyReceived.length})
                                        </h3>
                                        <div className="space-y-1">
                                            {recentlyReceived.map(po => (
                                                <div key={po.orderId} className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono">
                                                    <CheckCircle2 className="h-2.5 w-2.5 text-emerald-600/50 shrink-0" />
                                                    <span className="truncate">
                                                        #{po.orderId} {po.vendorName} — rcvd {shortDate(po.receiveDate)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Resize handle */}
                    <div
                        onMouseDown={startResize}
                        className="h-[5px] cursor-row-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60 shrink-0"
                        title="Drag to resize"
                    />
                </>
            )}
        </div>
    );
}

// ── Day Section ──────────────────────────────────────────────────
function DaySection({
    title,
    groups,
    variant,
    today,
}: {
    title: string;
    groups: DayGroup[];
    variant: "overdue" | "today" | "upcoming";
    today: string;
}) {
    const borderColor =
        variant === "overdue" ? "border-red-500/30" :
            variant === "today" ? "border-blue-500/30" :
                "border-zinc-700/30";
    const bgColor =
        variant === "overdue" ? "bg-red-500/5" :
            variant === "today" ? "bg-blue-500/5" :
                "bg-zinc-800/20";

    return (
        <div className={`rounded border ${borderColor} ${bgColor} overflow-hidden`}>
            <div className="px-2.5 py-1.5 border-b border-zinc-800/30">
                <h3 className={`text-[10px] font-mono uppercase tracking-wider ${
                    variant === "overdue" ? "text-red-400" :
                        variant === "today" ? "text-blue-400" :
                            "text-zinc-500"
                }`}>
                    {title}
                </h3>
            </div>

            <div className="divide-y divide-zinc-800/20">
                {groups.map(group => (
                    <div key={group.dateKey}>
                        {/* Date sub-header for overdue/upcoming groups with multiple dates */}
                        {(variant === "overdue" || variant === "upcoming") && (
                            <div className="px-2.5 py-1 bg-zinc-900/30">
                                <span className={`text-[10px] font-mono ${
                                    variant === "overdue" ? "text-red-400/70" : "text-zinc-500"
                                }`}>
                                    {group.label}
                                    {variant === "overdue" && (
                                        <span className="ml-1.5 text-red-500/60">
                                            ({Math.abs(daysDiff(group.dateKey, today))}d overdue)
                                        </span>
                                    )}
                                    {variant === "upcoming" && (
                                        <span className="ml-1.5 text-zinc-600">
                                            (in {daysDiff(today, group.dateKey)}d)
                                        </span>
                                    )}
                                </span>
                            </div>
                        )}

                        {/* Individual POs */}
                        <div className="divide-y divide-zinc-800/10">
                            {group.purchases.map(po => (
                                <PORow key={po.orderId} po={po} variant={variant} today={today} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Single PO Row ────────────────────────────────────────────────
function PORow({
    po,
    variant,
    today,
}: {
    po: ActivePurchase;
    variant: "overdue" | "today" | "upcoming";
    today: string;
}) {
    const itemCount = po.items.reduce((s, i) => s + i.quantity, 0);
    const topSkus = po.items.slice(0, 3).map(i => i.productId).join(", ");
    const more = po.items.length > 3 ? ` +${po.items.length - 3}` : "";
    const hasTracking = (po.trackingNumbers?.length || 0) > 0;
    const daysOverdue = variant === "overdue" ? Math.abs(daysDiff(po.expectedDate, today)) : 0;

    // Estimate revised ETA for overdue items: expected + 50% of overdue days as buffer
    const revisedEtaDays = variant === "overdue" ? Math.ceil(daysOverdue * 0.5) + 1 : 0;
    const revisedEtaDate = variant === "overdue"
        ? new Date(new Date(today + "T12:00:00").getTime() + revisedEtaDays * 86_400_000)
            .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : null;

    return (
        <div className={`px-2.5 py-2 hover:bg-zinc-800/30 transition-colors group ${
            variant === "overdue" ? "bg-red-950/10" : ""
        }`}>
            <div className="flex items-start gap-2">
                {/* Status icon */}
                <div className="mt-0.5 shrink-0">
                    {variant === "overdue" ? (
                        <AlertTriangle className="h-3 w-3 text-red-400 animate-pulse" />
                    ) : variant === "today" ? (
                        <Package className="h-3 w-3 text-blue-400" />
                    ) : (
                        <Clock className="h-3 w-3 text-zinc-500" />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <a
                            href={po.finaleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`text-[11px] font-mono font-medium hover:underline ${
                                variant === "overdue" ? "text-red-300" :
                                    variant === "today" ? "text-blue-300" :
                                        "text-zinc-300"
                            }`}
                        >
                            #{po.orderId}
                        </a>
                        <span className="text-[10px] text-zinc-500 truncate">
                            {po.vendorName}
                        </span>
                        {/* Finale link icon */}
                        <a
                            href={po.finaleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                            <ExternalLink className="h-2.5 w-2.5 text-zinc-600 hover:text-zinc-400" />
                        </a>
                    </div>

                    {/* Items summary */}
                    <div className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate">
                        {topSkus}{more} · {itemCount.toLocaleString()} units
                    </div>

                    {/* Overdue info */}
                    {variant === "overdue" && (
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] font-mono text-red-400/80">
                                Expected {shortDate(po.expectedDate)} · {daysOverdue}d overdue
                            </span>
                            {!hasTracking && (
                                <span className="text-[10px] font-mono text-amber-400/70 px-1 py-0.5 bg-amber-500/10 rounded border border-amber-500/20">
                                    ⚠ NO TRACKING — INVESTIGATE
                                </span>
                            )}
                            {hasTracking && revisedEtaDate && (
                                <span className="text-[10px] font-mono text-amber-300/80 px-1 py-0.5 bg-amber-500/10 rounded border border-amber-500/20">
                                    Est. arrival ~{revisedEtaDate}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Tracking links */}
                    {hasTracking && (
                        <div className="flex flex-wrap gap-1 mt-1">
                            {po.trackingNumbers!.slice(0, 3).map((t, idx) => {
                                const displayNum = t.includes(":::") ? t.split(":::")[1] : t;
                                const short = displayNum.length > 14 ? `…${displayNum.slice(-10)}` : displayNum;
                                return (
                                    <a
                                        key={idx}
                                        href={carrierUrl(t)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[9px] font-mono text-cyan-400/70 hover:text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded px-1 py-0.5 hover:bg-cyan-500/20 transition-colors"
                                    >
                                        📦 {short}
                                    </a>
                                );
                            })}
                            {po.trackingNumbers!.length > 3 && (
                                <span className="text-[9px] font-mono text-zinc-500">
                                    +{po.trackingNumbers!.length - 3} more
                                </span>
                            )}
                        </div>
                    )}

                    {/* Lead time provenance for today/upcoming */}
                    {variant !== "overdue" && (
                        <div className="text-[9px] text-zinc-600 font-mono mt-0.5">
                            ETA: {shortDate(po.expectedDate)} ({po.leadProvenance})
                            {!hasTracking && (
                                <span className="ml-1 text-amber-500/50">· no tracking yet</span>
                            )}
                        </div>
                    )}
                </div>

                {/* Dollar amount */}
                <div className="text-[10px] font-mono text-zinc-500 shrink-0">
                    ${po.total.toLocaleString()}
                </div>
            </div>
        </div>
    );
}
