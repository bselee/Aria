"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, RefreshCw, ChevronDown, ExternalLink, X, AlertCircle } from "lucide-react";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import { createBrowserClient } from "@/lib/supabase";

type AtRiskInfo = { severity: "at_risk" | "soon_at_risk"; worstDaysShort: number };

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
    isReceived: boolean;
    completionState: string;
    trackingNumbers?: string[];
    shipments?: Array<{
        tracking_number: string;
        public_tracking_url: string | null;
        status_display: string | null;
        estimated_delivery_at: string | null;
    }>;
    lifecycleStage?: string;
    lifecycleSummary?: string;
    lastMovementSummary?: string | null;
    trackingUnavailableAt?: string | null;
    trackingRequestedAt?: string | null;
    vendorAcknowledgedAt?: string | null;
    sentVerification: {
        verified: boolean;
        sentAt: string | null;
        source: "po_send" | "purchase_order" | "tracking" | "vendor_reply" | "manual" | null;
        evidence: Array<{ type: string; at: string | null; detail: string }>;
    };
    etaProfile?: {
        expectedDate: string;
        source: "tracking_eta" | "vendor_reply_eta" | "vendor_weekday_pattern" | "vendor_median" | "sku_product" | "default";
        confidence: "high" | "medium" | "low";
        label: string;
    };
};

type ApiResponse = {
    purchases: ActivePurchase[];
    cachedAt: string;
    error?: string;
};

// Build clickable carrier tracking URL (mirrors ops-manager.ts logic)
function carrierUrl(trackingNumber: string): string {
    const raw = trackingNumber.includes(":::") ? trackingNumber.split(":::")[1] : trackingNumber;
    const carrier = trackingNumber.includes(":::") ? trackingNumber.split(":::")[0].toLowerCase() : "";

    // LTL carriers
    if (carrier.includes("old dominion") || carrier.includes("odfl")) return `https://www.odfl.com/trace/Trace.jsp?pro=${raw}`;
    if (carrier.includes("saia")) return `https://www.saia.com/tracking?pro=${raw}`;
    if (carrier.includes("estes")) return `https://www.estes-express.com/tracking?pro=${raw}`;
    if (carrier.includes("xpo")) return `https://app.xpo.com/track/pro/${raw}`;
    if (carrier.includes("dayton")) return `https://www.daytonfreight.com/tracking/?pro=${raw}`;
    if (carrier.includes("fedex freight")) return `https://www.fedex.com/fedextrack/?tracknumbers=${raw}`;
    if (carrier.includes("r&l") || carrier.includes("r+l")) return `https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro=${raw}`;

    // Parcel carriers — detect from number format
    if (/^1Z[A-Z0-9]{16}$/i.test(raw)) return `https://www.ups.com/track?tracknum=${raw}`;
    if (/^(94|92|93|95)\d{20}$/.test(raw)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${raw}`;
    if (/^(96\d{18}|\d{15}|\d{12})$/.test(raw)) return `https://www.fedex.com/fedextrack/?tracknumbers=${raw}`;
    if (/^JD\d{18}$/i.test(raw)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${raw}`;

    // Fallback: ParcelApp
    return `https://parcelsapp.com/en/tracking/${raw}`;
}

// Returns e.g. "Mar 3, 2026"
function fmtDate(dateStr: string | null | undefined): string {
    if (!dateStr) return "Unknown";
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return isNaN(d.getTime())
        ? dateStr
        : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function timeAgo(iso: string) {
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return "";
    const m = Math.floor(ms / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default function ActivePurchasesPanel() {
    const lifecycle = usePurchasingLifecycle();
    const [purchases, setPurchases] = useState<ActivePurchase[]>([]);
    const [cachedAt, setCachedAt] = useState("");
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [verifyingSent, setVerifyingSent] = useState<Set<string>>(new Set());

    // PO_ARRIVAL_AT_RISK index from ap_activity_log (last 24h). Drives the
    // rose/amber outline + AT-RISK pill on affected POs. Activity-first
    // routing: the data lives in the Activity feed; this panel is a lens.
    const [atRiskByPoId, setAtRiskByPoId] = useState<Map<string, AtRiskInfo>>(new Map());

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

    // Load PO_ARRIVAL_AT_RISK rows once on mount + subscribe for live updates
    // so the panel highlights stay current as the detector reruns (2h cron).
    useEffect(() => {
        const supabase = createBrowserClient();
        const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

        const rebuild = (rows: Array<{ metadata: any }>): Map<string, AtRiskInfo> => {
            const m = new Map<string, AtRiskInfo>();
            for (const row of rows) {
                const meta = row.metadata;
                if (!meta?.poId) continue;
                const severity: AtRiskInfo["severity"] = meta.severity === "soon_at_risk" ? "soon_at_risk" : "at_risk";
                m.set(String(meta.poId), { severity, worstDaysShort: Number(meta.worstDaysShort ?? 0) });
            }
            return m;
        };

        supabase
            .from("ap_activity_log")
            .select("id, metadata")
            .eq("intent", "PO_ARRIVAL_AT_RISK")
            .gte("created_at", since24h)
            .order("created_at", { ascending: false })
            .limit(200)
            .then((res: { data: Array<{ id: string; metadata: any }> | null }) => {
                if (res.data) setAtRiskByPoId(rebuild(res.data));
            });
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

    async function markSentVerified(orderId: string) {
        setVerifyingSent((prev) => new Set(prev).add(orderId));
        setError(null);
        try {
            const res = await fetch("/api/dashboard/active-purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "mark_sent_verified", orderId }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Verification failed");
            setPurchases((prev) => prev.map((po) => po.orderId === orderId
                ? { ...po, lifecycleStage: po.lifecycleStage || "sent", sentVerification: json.sentVerification }
                : po));
        } catch (e: any) {
            setError(e.message);
        } finally {
            setVerifyingSent((prev) => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    }

    // ── Vendor reliability map ──
    const [reliability, setReliability] = useState<Record<string, { grade: string | null; replyRate: number | null; onTimeRate: number | null; poCount: number; avgDaysToDelivery: number | null; avgReplyHours: number | null }>>({});
    useEffect(() => {
        let cancelled = false;
        fetch('/api/dashboard/vendor-reliability')
            .then(r => r.json())
            .then(j => {
                if (cancelled) return;
                const m: Record<string, any> = {};
                for (const row of j.rows ?? []) m[(row.vendorName ?? '').toLowerCase()] = row;
                setReliability(m);
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);
    function relFor(name: string) { return reliability[(name ?? '').toLowerCase()] ?? null; }

    // ── Timeline drawer state ──
    const [timelineOrderId, setTimelineOrderId] = useState<string | null>(null);
    const [timelineData, setTimelineData] = useState<any | null>(null);
    const [timelineLoading, setTimelineLoading] = useState(false);
    useEffect(() => {
        if (!timelineOrderId) { setTimelineData(null); return; }
        let cancelled = false;
        setTimelineLoading(true);
        fetch(`/api/dashboard/po-timeline/${encodeURIComponent(timelineOrderId)}`)
            .then(r => r.json())
            .then(j => { if (!cancelled) setTimelineData(j); })
            .catch(() => { if (!cancelled) setTimelineData({ error: 'fetch failed' }); })
            .finally(() => { if (!cancelled) setTimelineLoading(false); });
        return () => { cancelled = true; };
    }, [timelineOrderId]);

    const todayMs = Date.now();
    function effectiveExpected(po: ActivePurchase): string | null {
        return po.etaProfile?.expectedDate || po.expectedDate || null;
    }
    function dayDiff(a: string | null, b: string | null): number | null {
        if (!a || !b) return null;
        const ta = new Date(a).getTime();
        const tb = new Date(b).getTime();
        if (isNaN(ta) || isNaN(tb)) return null;
        return Math.round((ta - tb) / 86_400_000);
    }
    function daysSince(d: string | null): number | null {
        if (!d) return null;
        const t = new Date(d).getTime();
        if (isNaN(t)) return null;
        return Math.floor((todayMs - t) / 86_400_000);
    }
    function isOverdue(po: ActivePurchase): boolean {
        if (po.isReceived) return false;
        const exp = effectiveExpected(po);
        if (!exp) return false;
        return new Date(exp).getTime() < todayMs;
    }

    const visiblePurchases = purchases
        .filter((po) => !dismissed.has(po.orderId))
        .sort((a, b) => {
            // Received → bottom (most recent at top of the received pile)
            if (a.isReceived !== b.isReceived) return a.isReceived ? 1 : -1;
            if (a.isReceived && b.isReceived) {
                return (b.receiveDate || "").localeCompare(a.receiveDate || "");
            }
            // Overdue first — most-late at top
            const aOv = isOverdue(a), bOv = isOverdue(b);
            if (aOv !== bOv) return aOv ? -1 : 1;
            if (aOv && bOv) {
                const aExp = effectiveExpected(a) || "";
                const bExp = effectiveExpected(b) || "";
                return aExp.localeCompare(bExp); // earlier expected = more late
            }
            // Soonest expected next
            const aExp = effectiveExpected(a) || "9999-12-31";
            const bExp = effectiveExpected(b) || "9999-12-31";
            if (aExp !== bExp) return aExp.localeCompare(bExp);
            // Tiebreak: earliest order date
            return (a.orderDate || "").localeCompare(b.orderDate || "");
        });

    return (
        <div className="border-b border-zinc-800 shrink-0" ref={containerRef}>
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <ListChecks className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Active Purchases</span>
                {cachedAt && !refreshing && <span className="text-[10px] text-[var(--dash-ts)] font-mono">{timeAgo(cachedAt)}</span>}
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
                        <div className="px-4 py-2 space-y-2.5">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="skeleton-shimmer h-4" style={{ width: `${35 + i * 12}%` }} />
                                    <div className="skeleton-shimmer h-3 w-14 ml-auto" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="px-4 py-3 border-t border-zinc-800/60"><span className="text-xs font-mono text-rose-400">{error}</span></div>
                    ) : visiblePurchases.length === 0 ? (
                        <div className="px-4 py-3 border-t border-zinc-800/60"><span className="text-xs font-mono text-zinc-600">No active purchases.</span></div>
                    ) : (
                        <div className="overflow-y-auto border-t border-zinc-800/60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50" style={{ height: bodyHeight }}>
                            {visiblePurchases.map(po => {
                                const isReceived = po.isReceived;
                                const isCancelled = po.status.toLowerCase() === "cancelled";
                                const sentVerified = po.sentVerification?.verified;
                                const sentSource = po.sentVerification?.source;
                                const sentAt = po.sentVerification?.sentAt;
                                const etaConfidence = po.etaProfile?.confidence ?? "low";
                                const etaTone = etaConfidence === "high"
                                    ? "text-emerald-300"
                                    : etaConfidence === "medium"
                                    ? "text-cyan-300"
                                    : "text-zinc-500";
                                const poProductIds = po.items.map(item => item.productId);
                                const poMatch = lifecycle.checkMatchDetails({
                                    vendorName: po.vendorName,
                                    orderId: po.orderId,
                                    productIds: poProductIds,
                                });
                                const poBg = poMatch.isLockedDirect
                                    ? "bg-amber-500/10 ring-2 ring-inset ring-amber-500/50"
                                    : poMatch.isLockedBom
                                    ? "bg-amber-500/5 ring-1 ring-dashed ring-amber-500/30"
                                    : poMatch.isDirect
                                    ? "bg-cyan-500/8 ring-1 ring-inset ring-cyan-500/35"
                                    : poMatch.isBom
                                    ? "bg-cyan-500/4 ring-1 ring-dashed ring-cyan-500/25"
                                    : "";

                                let statusLabel = "In Transit";
                                let statusColor = "text-blue-400 bg-blue-500/10 border-blue-500/30";

                                if (isReceived) {
                                    statusLabel = "Received";
                                    statusColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
                                } else if (isCancelled) {
                                    statusLabel = "Cancelled";
                                    statusColor = "text-rose-400 bg-rose-500/10 border-rose-500/30";
                                } else if (po.lifecycleStage === 'sent') {
                                    statusLabel = "Sent";
                                    statusColor = "text-zinc-400 bg-zinc-500/10 border-zinc-500/30";
                                } else if (po.lifecycleStage === 'vendor_acknowledged') {
                                    statusLabel = "Awaiting Tracking";
                                    statusColor = "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";
                                } else if (po.lifecycleStage === 'tracking_unavailable') {
                                    statusLabel = "Tracking Unavailable";
                                    statusColor = "text-orange-400 bg-orange-500/10 border-orange-500/30";
                                } else if (po.lifecycleStage === 'ap_follow_up') {
                                    statusLabel = "AP Review";
                                    statusColor = "text-purple-400 bg-purple-500/10 border-purple-500/30";
                                } else if (po.lifecycleStage === 'moving_with_tracking') {
                                    statusLabel = po.lastMovementSummary ? `Moving — ${po.lastMovementSummary}` : "In Transit";
                                    statusColor = "text-blue-400 bg-blue-500/10 border-blue-500/30";
                                } else if (po.shipments?.some((shipment) => shipment.status_display?.toLowerCase().includes("out for delivery"))) {
                                    statusLabel = "Out Today";
                                    statusColor = "text-amber-300 bg-amber-500/10 border-amber-500/30";
                                } else if (po.shipments?.some((shipment) => shipment.status_display?.toLowerCase().includes("delivered"))) {
                                    statusLabel = "Delivered";
                                    statusColor = "text-cyan-300 bg-cyan-500/10 border-cyan-500/30";
                                }

                                const expISO = effectiveExpected(po);
                                const overdue = isOverdue(po);
                                const daysLate = overdue ? -1 * (dayDiff(expISO, new Date().toISOString().slice(0, 10)) ?? 0) : 0;
                                const daysOut = daysSince(po.orderDate);
                                const receivedDiff = po.isReceived && po.receiveDate ? dayDiff(po.receiveDate, expISO) : null;
                                // Outline this row when the detector flagged the PO. Rose for
                                // already-at-risk, amber for soon-at-risk. Pill renders the
                                // severity inline next to the status pill.
                                const atRisk = atRiskByPoId.get(po.orderId);
                                const riskRing = atRisk
                                    ? atRisk.severity === "at_risk"
                                        ? "ring-1 ring-inset ring-rose-500/60 bg-rose-500/[.04]"
                                        : "ring-1 ring-inset ring-amber-500/50 bg-amber-500/[.03]"
                                    : "";
                                return (
                                    <div
                                        key={po.orderId}
                                        onMouseEnter={() => lifecycle.setFocus({ source: "purchases", vendorName: po.vendorName, orderId: po.orderId, productIds: poProductIds })}
                                        onMouseLeave={lifecycle.clearFocus}
                                        onClick={(e) => {
                                            const target = e.target as HTMLElement;
                                            if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) return;
                                            lifecycle.setLockedFocus({ source: "purchases", vendorName: po.vendorName, orderId: po.orderId, productIds: poProductIds });
                                            setTimelineOrderId(po.orderId);
                                        }}
                                        className={`px-4 py-3 border-b border-zinc-800/40 transition-colors group relative cursor-pointer ${overdue ? 'border-l-2 border-l-rose-500/60' : ''} ${poBg ? poBg : !atRisk ? "hover:bg-zinc-800/20" : ""} ${riskRing}`}
                                    >
                                        {/* Dismiss Button */}
                                        <button
                                            onClick={e => { e.stopPropagation(); dismissPurchase(po.orderId); }}
                                            className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 p-1 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 rounded transition-all"
                                            title="Dismiss PO"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>

                                        {/* Line 1: Vendor, Date, Tags */}
                                        <div className="flex items-center gap-2 flex-wrap min-w-0 pr-8">
                                            <span className="text-sm font-semibold text-zinc-100 truncate min-w-[120px] max-w-[260px]" title={po.vendorName}>{po.vendorName}</span>
                                            {(() => {
                                                const r = relFor(po.vendorName);
                                                if (!r?.grade) return null;
                                                const tone = r.grade === 'A' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                                    : r.grade === 'B' ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                                                    : r.grade === 'C' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                                    : r.grade === 'D' ? 'bg-orange-500/20 text-orange-300 border-orange-500/40'
                                                    : 'bg-rose-500/20 text-rose-300 border-rose-500/40';
                                                const reply = r.avgReplyHours != null ? `${Math.round(r.avgReplyHours)}h reply` : 'no reply data';
                                                const onTime = r.onTimeRate != null ? `${Math.round(r.onTimeRate * 100)}% on-time` : 'no delivery data';
                                                const deliv = r.avgDaysToDelivery != null ? `${Math.round(r.avgDaysToDelivery)}d avg delivery` : null;
                                                const title = `${r.poCount} POs · ${reply} · ${onTime}${deliv ? ` · ${deliv}` : ''}`;
                                                return (
                                                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${tone}`} title={title}>
                                                        {r.grade}
                                                    </span>
                                                );
                                            })()}
                                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${statusColor}`}>
                                                {statusLabel}
                                            </span>
                                            {atRisk && atRisk.severity === "at_risk" && (
                                                <span
                                                    className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border bg-rose-600/30 text-rose-200 border-rose-500/60 shrink-0"
                                                    title={`Arrival ${atRisk.worstDaysShort}d after projected stockout`}
                                                >
                                                    <AlertCircle className="w-2.5 h-2.5" />
                                                    BUILD AT RISK · {atRisk.worstDaysShort}d short
                                                </span>
                                            )}
                                            {atRisk && atRisk.severity === "soon_at_risk" && (
                                                <span
                                                    className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border bg-amber-600/20 text-amber-200 border-amber-500/50 shrink-0"
                                                    title={`Only ${Math.abs(atRisk.worstDaysShort)}d buffer before stockout`}
                                                >
                                                    <AlertCircle className="w-2.5 h-2.5" />
                                                    MARGIN TIGHT · {Math.abs(atRisk.worstDaysShort)}d
                                                </span>
                                            )}
                                            {overdue && (
                                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-rose-500/15 text-rose-300 border-rose-500/40 shrink-0">
                                                    ⚠ OVERDUE {daysLate}d
                                                </span>
                                            )}
                                            {po.vendorAcknowledgedAt && !po.isReceived && (
                                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-300/90 border-emerald-500/30 shrink-0" title={`Vendor acknowledged ${po.vendorAcknowledgedAt}`}>
                                                    ✓ Vendor ack
                                                </span>
                                            )}
                                            {daysOut != null && !po.isReceived && !overdue && (
                                                <span className="text-[10px] font-mono text-zinc-600 shrink-0">{daysOut}d out</span>
                                            )}
                                            {po.total > 0 && (
                                                <span className="text-xs font-mono text-zinc-400 shrink-0 ml-auto mr-1">
                                                    ${po.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                </span>
                                            )}
                                        </div>

                                        {/* Line 2: Links and Schedule text */}
                                        <div className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px] font-mono text-[var(--dash-l2)]">
                                            <a href={po.finaleUrl} target="_blank" rel="noopener noreferrer"
                                                onClick={e => e.stopPropagation()}
                                                className="text-blue-500 hover:text-blue-400 transition-colors inline-flex items-center gap-1 shrink-0">
                                                {po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                            </a>
                                            <span className="text-zinc-700">·</span>

                                            {isReceived && po.receiveDate ? (
                                                <span>
                                                    Rcvd {fmtDate(po.receiveDate)}
                                                    {receivedDiff != null && (
                                                        <span className={`ml-1 ${receivedDiff < 0 ? 'text-emerald-400' : receivedDiff > 0 ? 'text-rose-400' : 'text-zinc-500'}`}>
                                                            ({receivedDiff === 0 ? 'on time' : receivedDiff < 0 ? `${Math.abs(receivedDiff)}d early` : `${receivedDiff}d late`})
                                                        </span>
                                                    )}
                                                </span>
                                            ) : (
                                                <span>
                                                    Exp: <span className={`${overdue ? 'text-rose-300' : etaTone}`}>{fmtDate(po.expectedDate)}</span>{" "}
                                                    <span className="opacity-60">({po.etaProfile?.label || po.leadProvenance})</span>
                                                </span>
                                            )}

                                            <span className="text-zinc-700">·</span>
                                            {sentVerified ? (
                                                <span
                                                    className="inline-flex items-center gap-1 text-emerald-300 shrink-0"
                                                    title={(po.sentVerification.evidence || []).map((entry) => entry.detail).join("\n")}
                                                >
                                                    PO sent verified{sentAt ? ` ${fmtDate(sentAt)}` : ""} <span className="text-emerald-500/70">({sentSource})</span>
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1.5 shrink-0">
                                                    <span className="text-amber-300">PO send unverified</span>
                                                    <button
                                                        onClick={e => { e.stopPropagation(); markSentVerified(po.orderId); }}
                                                        disabled={verifyingSent.has(po.orderId)}
                                                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
                                                        title="Mark this PO as sent after verifying externally"
                                                    >
                                                        {verifyingSent.has(po.orderId) ? "saving" : "mark verified"}
                                                    </button>
                                                </span>
                                            )}

                                            {((po.shipments?.length || 0) > 0 || (po.trackingNumbers?.length || 0) > 0) && (
                                                <>
                                                    <span className="text-zinc-700">·</span>
                                                    <span className="text-zinc-400 shrink-0">Ship:</span>
                                                    {(po.shipments?.length
                                                        ? po.shipments.map((shipment) => ({
                                                            tracking: shipment.tracking_number,
                                                            url: shipment.public_tracking_url || carrierUrl(shipment.tracking_number),
                                                            status: shipment.status_display,
                                                            eta: shipment.estimated_delivery_at,
                                                        }))
                                                        : (po.trackingNumbers || []).map((tracking) => ({
                                                            tracking,
                                                            url: carrierUrl(tracking),
                                                            status: null,
                                                            eta: null,
                                                        }))).map((entry, i) => {
                                                        const t = entry.tracking;
                                                        const display = t.includes(":::") ? t.replace(":::", " ") : t;
                                                        return (
                                                            <span key={i} className="inline-flex items-center gap-1 shrink-0">
                                                                <a href={entry.url} target="_blank" rel="noopener noreferrer"
                                                                    onClick={e => e.stopPropagation()}
                                                                    className="text-cyan-400 hover:text-cyan-300 hover:underline transition-colors shrink-0 inline-flex items-center gap-0.5">
                                                                    {display}<ExternalLink className="w-2 h-2 opacity-60" />
                                                                </a>
                                                                {(entry.status || entry.eta) && (
                                                                    <span className="text-zinc-500">
                                                                        {entry.status || "In transit"}{entry.eta ? ` • ${fmtDateTime(entry.eta)}` : ""}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                                </>
                                            )}
                                        </div>

                                        {/* Line 3: Line Items */}
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                                            {po.items.map((item, idx) => {
                                                const badgeMatch = lifecycle.checkMatchDetails({ productIds: [item.productId] });
                                                const badgeBg = badgeMatch.isLockedDirect
                                                    ? "text-amber-100 bg-amber-500/20 border-amber-500/50"
                                                    : badgeMatch.isLockedBom
                                                    ? "text-amber-200/90 bg-amber-500/10 border-amber-500/30 border-dashed"
                                                    : badgeMatch.isDirect
                                                    ? "text-cyan-100 bg-cyan-500/15 border-cyan-500/40"
                                                    : badgeMatch.isBom
                                                    ? "text-cyan-200/95 bg-cyan-500/5 border-cyan-500/25 border-dashed"
                                                    : "text-zinc-300 bg-zinc-800/40 border-zinc-700/50";
                                                return (
                                                    <span key={item.productId + idx} className={`text-[11px] font-mono px-1.5 py-px rounded border ${badgeBg}`}>
                                                        {item.productId} <span className="text-zinc-500">×{item.quantity.toLocaleString()}</span>
                                                    </span>
                                                );
                                            })}
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
            {timelineOrderId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setTimelineOrderId(null)}>
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                            <span className="text-sm font-mono font-semibold text-zinc-200">PO #{timelineOrderId} timeline</span>
                            <span className="text-[10px] font-mono text-zinc-600">{timelineData?.vendorName ?? ''}</span>
                            <div className="flex-1" />
                            <button onClick={() => setTimelineOrderId(null)} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"><X className="w-3.5 h-3.5" /></button>
                        </div>
                        <div className="px-4 py-3 overflow-y-auto">
                            {timelineLoading && <div className="text-[11px] font-mono text-zinc-500">Loading…</div>}
                            {timelineData?.error && <div className="text-[11px] font-mono text-rose-400">{timelineData.error}</div>}
                            {timelineData?.events && timelineData.events.length === 0 && <div className="text-[11px] font-mono text-zinc-500">No events recorded for this PO yet.</div>}
                            {timelineData?.events?.map((e: any, i: number) => {
                                const tone = e.kind === 'delivered' || e.kind === 'received' || e.kind === 'reconciled' || e.kind === 'acked'
                                    ? 'text-emerald-400'
                                    : e.kind === 'noncomm'
                                    ? 'text-rose-400'
                                    : e.kind === 'tracking_requested' || e.kind === 'tracking_requested_l2'
                                    ? 'text-amber-300'
                                    : 'text-cyan-300';
                                return (
                                    <div key={i} className="flex items-start gap-3 py-1.5 border-b border-zinc-800/40">
                                        <span className="text-[10px] font-mono text-zinc-600 w-32 shrink-0 mt-0.5">{new Date(e.at).toLocaleString()}</span>
                                        <span className={`text-[11px] font-mono ${tone} w-44 shrink-0 mt-0.5`}>{e.label}</span>
                                        <span className="text-[10px] font-mono text-zinc-500 truncate">{e.detail ?? ''}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
