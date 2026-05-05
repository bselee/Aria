"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown, ExternalLink, Zap, Eye, ShoppingCart } from "lucide-react";
import {
    canIncludeInDraftPO,
    canUseDirectOrdering,
    getOrderingFocusBucket,
    shouldAutoSelectItem,
} from "@/lib/purchasing/dashboard-focus";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import type { FinaleReorderMethod } from "@/lib/finale/client";

// ── types ──────────────────────────────────────────────────────────────────
type UrgencyTier = "critical" | "warning" | "watch" | "ok";
const TIER_ORDER: UrgencyTier[] = ["critical", "warning", "watch", "ok"];

type PurchasingItem = {
    productId: string; productName: string; supplierName: string; supplierPartyId: string;
    unitPrice: number; stockOnHand: number; stockOnOrder: number;
    purchaseVelocity: number; salesVelocity: number; demandVelocity: number; dailyRate: number;
    dailyRateSource?: "demand" | "sales" | "receipts";
    runwayDays: number; adjustedRunwayDays: number; leadTimeDays: number; leadTimeProvenance: string;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    urgency: UrgencyTier;
    explanation: string; suggestedQty: number;
    orderIncrementQty: number | null; isBulkDelivery: boolean;
    finaleReorderQty: number | null; finaleStockoutDays: number | null; finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;
    reorderMethod?: FinaleReorderMethod;
    qtyDiverged?: boolean;
    qtyDivergencePct?: number;
    velocityInflated?: boolean;
    velocityRawRate?: number;
    velocityRealityCap?: number;
    recommendation?: {
        formulaVersion: string;
        coverDays: number;
        rawNeededEaches: number;
        provenance: Array<{ step: string; detail: string; value?: number | string }>;
    };
    packSize?: { unitsPerPack: number; packUnit: string };
    candidate?: { directDemand: number; bomDemand: number; finishedGoodsCoverageDays?: number | null };
    assessment?: {
        decision: "order" | "reduce" | "hold" | "manual_review";
        recommendedQty: number;
        confidence: "high" | "medium" | "low";
        reasonCodes: string[];
        explanation: string;
    };
    vendorPolicy?: {
        leadTimeOverrideDays: number | null;
        targetCoverDays: number | null;
        moqMode: "enforce" | "warn" | "ignore";
        overbuyReviewPct: number;
        overbuyReviewDollars: number;
        notes: string | null;
    };
    moqWarning?: boolean;
    reviewRequired?: boolean;
    reviewReasons?: string[];
};
type AssessmentData = {
    groups: PurchasingGroup[];
    cachedAt: string;
    vendorSummaries?: Array<{
        vendorName: string; vendorPartyId: string;
        actionableCount: number; blockedCount: number;
        highestConfidence: "high" | "medium" | "low" | null;
    }>;
};
type POResult = { orderId: string; finaleUrl: string };
type CommitReview = {
    sendId: string;
    review: {
        orderId: string; vendorName: string; total: number; orderDate: string;
        items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }>;
        finaleUrl: string;
    };
    email: string;
    emailSource: string;
};
type SnoozeEntry = { until: number | "forever" };
type SnoozeMap = Record<string, SnoozeEntry>;
type UlineOrderResult = { success: boolean; itemsAdded: number; message: string; priceUpdatesApplied?: number; errors?: string[] };
type FocusFilter = "today" | "week" | "all";
type LifecycleBucket = "need" | "topping" | "on_order" | "other";
type LifecycleFilter = LifecycleBucket | "all";

// Minimal subset of ActivePurchase needed to enrich openPOs with lifecycle detail.
// Declared locally to avoid pulling server-only modules into the client bundle.
type RecLink = {
    productId: string;
    recommendedQty: number;
    draftedQty: number;
    recommendedAt: string;
    draftedAt: string;
};

type OpenPODetail = {
    orderId: string;
    expectedDate?: string;
    leadProvenance?: string;
    trackingNumbers?: string[];
    lifecycleStage?: string;
    vendorAcknowledgedAt?: string | null;
    sentVerification?: { verified?: boolean; sentAt?: string | null; source?: string | null };
    isReceived?: boolean;
    recLinks?: RecLink[];
};

// ── constants ──────────────────────────────────────────────────────────────
const SNOOZE_LS = "aria-dash-purchasing-snooze";
const FOCUS_FILTER_LS = "aria-dash-purchasing-focus";
const LIFECYCLE_FILTER_LS = "aria-dash-purchasing-lifecycle";

function lifecycleBucket(item: PurchasingItem): LifecycleBucket {
    const reasons = item.assessment?.reasonCodes ?? [];
    if (reasons.includes("on_order_already_covers_need")) return "on_order";
    const decision = item.assessment?.decision;
    if (decision === "order") return item.stockOnOrder > 0 ? "topping" : "need";
    return "other"; // hold (other reasons), manual_review, reduce
}
const URGENCY_RANK = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
// DECISION(2026-03-10): Badge hierarchy reform — only CRIT gets a filled pill.
// WARN = amber text only (no pill).  WATCH/OK = invisible badge.
// This prevents badge blindness when most rows are critical.
const URGENCY = {
    critical: { badge: "bg-red-500/20 text-red-300 border-red-500/40", badgeOutline: "bg-transparent text-red-400 border-red-500/30", dot: "bg-red-500", label: "CRIT", tab: "border-red-500 text-red-300" },
    warning: { badge: "text-amber-400", badgeOutline: "text-amber-400", dot: "bg-amber-400", label: "WARN", tab: "border-amber-400 text-amber-300" },
    watch: { badge: "text-zinc-500", badgeOutline: "text-zinc-500", dot: "bg-emerald-500", label: "WTCH", tab: "border-emerald-500 text-emerald-300" },
    ok: { badge: "", badgeOutline: "", dot: "bg-zinc-600", label: "", tab: "border-zinc-600 text-zinc-500" },
} as const;

function runwayColor(days: number) {
    if (days < 14) return "text-red-400 font-semibold";
    if (days < 45) return "text-yellow-400 font-semibold";
    if (days < 90) return "text-green-400";
    return "text-zinc-500";
}
function timeAgo(iso: string) {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function orderingNeedScore(item: PurchasingItem): number {
    const stockoutDays = item.finaleStockoutDays ?? item.adjustedRunwayDays ?? item.runwayDays;
    return Number.isFinite(stockoutDays) ? stockoutDays : 9999;
}

function sortItemsByNeed(items: PurchasingItem[]): PurchasingItem[] {
    return [...items].sort((a, b) => {
        const runwayDelta = (a.runwayDays ?? 9999) - (b.runwayDays ?? 9999);
        if (runwayDelta !== 0) return runwayDelta;

        const stockoutDelta = orderingNeedScore(a) - orderingNeedScore(b);
        if (stockoutDelta !== 0) return stockoutDelta;

        const urgencyDelta = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
        if (urgencyDelta !== 0) return urgencyDelta;

        const confidenceRank = { high: 0, medium: 1, low: 2 } as const;
        const confidenceDelta =
            (confidenceRank[a.assessment?.confidence ?? "low"] ?? 2) -
            (confidenceRank[b.assessment?.confidence ?? "low"] ?? 2);
        if (confidenceDelta !== 0) return confidenceDelta;

        return b.suggestedQty - a.suggestedQty;
    });
}

// ── component ──────────────────────────────────────────────────────────────
export default function PurchasingPanel() {
    const lifecycle = usePurchasingLifecycle();
    const [data, setData] = useState<AssessmentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingTiers, setLoadingTiers] = useState<Set<UrgencyTier>>(new Set());
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [vendorTab, setVendorTab] = useState<string>("all");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set());
    const toggleWhy = useCallback((id: string) => {
        setWhyOpen(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const [checked, setChecked] = useState<Record<string, Record<string, boolean>>>({});
    const [qtys, setQtys] = useState<Record<string, Record<string, number>>>({});
    const [creatingPO, setCreatingPO] = useState<Set<string>>(new Set());
    const [createdPOs, setCreatedPOs] = useState<Record<string, POResult>>({});

    // commit & send modal
    const [commitModal, setCommitModal] = useState<CommitReview | null>(null);
    const [commitLoading, setCommitLoading] = useState<string | null>(null); // orderId being reviewed
    const [sendingPO, setSendingPO] = useState(false);
    const [sentPOs, setSentPOs] = useState<Set<string>>(new Set()); // orderId → sent

    // snooze
    const [snooze, setSnooze] = useState<SnoozeMap>({});
    const [showSnoozed, setShowSnoozed] = useState(false);
    const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);
    const [focusFilter, setFocusFilter] = useState<FocusFilter>("today");
    const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("need");
    const [openPosDetail, setOpenPosDetail] = useState<Map<string, OpenPODetail>>(new Map());

    // ULINE direct ordering
    const [ulineOrdering, setUlineOrdering] = useState(false);
    const [ulineResult, setUlineResult] = useState<UlineOrderResult | null>(null);

    // collapse + resize
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => { if (localStorage.getItem("aria-dash-purchasing-collapsed") === "true") setIsCollapsed(true); }, []);
    useEffect(() => { localStorage.setItem("aria-dash-purchasing-collapsed", String(isCollapsed)); }, [isCollapsed]);

    const [bodyHeight, setBodyHeight] = useState(620);
    const [listScrollTop, setListScrollTop] = useState(0);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-purchasing-h");
        if (s) setBodyHeight(Math.max(420, Math.min(1000, parseInt(s))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-purchasing-h", String(bodyHeight)); }, [bodyHeight]);
    useEffect(() => {
        const savedFocus = localStorage.getItem(FOCUS_FILTER_LS) as FocusFilter | null;
        if (savedFocus === "today" || savedFocus === "week" || savedFocus === "all") {
            setFocusFilter(savedFocus);
        }
    }, []);
    useEffect(() => { localStorage.setItem(FOCUS_FILTER_LS, focusFilter); }, [focusFilter]);
    useEffect(() => {
        const saved = localStorage.getItem(LIFECYCLE_FILTER_LS) as LifecycleFilter | null;
        if (saved === "need" || saved === "topping" || saved === "on_order" || saved === "other" || saved === "all") {
            setLifecycleFilter(saved);
        }
    }, []);
    useEffect(() => { localStorage.setItem(LIFECYCLE_FILTER_LS, lifecycleFilter); }, [lifecycleFilter]);

    // Fetch open-PO detail (ETA, tracking, lifecycle) once per panel load. Best-effort —
    // missing detail just means the lifecycle ribbon falls back to PO# + qty + orderDate.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/dashboard/active-purchases");
                if (!res.ok) return;
                const json: { purchases?: any[] } = await res.json();
                if (cancelled || !json.purchases) return;
                const m = new Map<string, OpenPODetail>();
                for (const p of json.purchases) {
                    if (!p.orderId) continue;
                    const id = String(p.orderId);
                    m.set(id, {
                        orderId: id,
                        expectedDate: p.expectedDate,
                        leadProvenance: p.leadProvenance,
                        trackingNumbers: Array.isArray(p.trackingNumbers) ? p.trackingNumbers : [],
                        lifecycleStage: p.lifecycleStage,
                        vendorAcknowledgedAt: p.vendorAcknowledgedAt ?? null,
                        sentVerification: p.sentVerification
                            ? { verified: p.sentVerification.verified, sentAt: p.sentVerification.sentAt, source: p.sentVerification.source }
                            : undefined,
                        isReceived: p.isReceived,
                        recLinks: Array.isArray(p.recLinks) ? p.recLinks : [],
                    });
                }
                setOpenPosDetail(m);
            } catch { /* best-effort */ }
        })();
        return () => { cancelled = true; };
    }, []);

    // Load snooze state from localStorage; purge expired entries on mount
    useEffect(() => {
        const raw = localStorage.getItem(SNOOZE_LS);
        if (!raw) return;
        try {
            const parsed: SnoozeMap = JSON.parse(raw);
            const now = Date.now();
            const cleaned: SnoozeMap = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (v.until === "forever" || (typeof v.until === "number" && v.until > now)) {
                    cleaned[k] = v;
                }
            }
            setSnooze(cleaned);
            localStorage.setItem(SNOOZE_LS, JSON.stringify(cleaned));
        } catch { }
    }, []);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(420, Math.min(1000, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    // ── snooze helpers ─────────────────────────────────────────────────────
    function isSnoozed(key: string): boolean {
        const e = snooze[key];
        if (!e) return false;
        return e.until === "forever" || (typeof e.until === "number" && Date.now() < e.until);
    }
    function doSnooze(key: string, days: number | "forever") {
        const entry: SnoozeEntry = days === "forever"
            ? { until: "forever" }
            : { until: Date.now() + (days as number) * 86400000 };
        const updated = { ...snooze, [key]: entry };
        setSnooze(updated);
        localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
        setSnoozeMenu(null);
    }
    function doUnsnooze(key: string) {
        const updated = { ...snooze };
        delete updated[key];
        setSnooze(updated);
        localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
        setSnoozeMenu(null);
    }
    function snoozeLabel(key: string): string {
        const e = snooze[key];
        if (!e) return "";
        if (e.until === "forever") return "always skip";
        const days = Math.ceil(((e.until as number) - Date.now()) / 86400000);
        return `snoozed ${days}d`;
    }
    function reorderMethodBadge(method?: FinaleReorderMethod): string | null {
        if (!method) return null;
        if (method === "do_not_reorder") return "DNR";
        if (method === "manual") return "MANUAL";
        if (method === "sales_velocity") return "SALES";
        if (method === "demand_velocity") return "DEMAND";
        if (method === "on_site_order") return "ON SITE";
        return "DEFAULT";
    }
    function reorderMethodTone(method?: FinaleReorderMethod): string {
        if (method === "do_not_reorder") return "text-rose-300/80 border-rose-500/20";
        if (method === "manual" || method === "on_site_order") return "text-amber-300/80 border-amber-500/20";
        if (method === "sales_velocity" || method === "demand_velocity") return "text-cyan-300/80 border-cyan-500/20";
        return "text-zinc-400 border-zinc-700/60";
    }
    function directOrderBlockReason(items: PurchasingItem[]): string {
        if (items.some(item => item.reorderMethod === "manual")) return "Finale manual items selected";
        if (items.some(item => item.reorderMethod === "on_site_order")) return "On-site order items selected";
        if (items.some(item => item.reorderMethod === "do_not_reorder")) return "Do not reorder items selected";
        return "Selected items need PO handling";
    }
    function itemMatchesFocus(item: PurchasingItem): boolean {
        if (focusFilter === "all") return true;
        const bucket = getOrderingFocusBucket(item);
        if (focusFilter === "today") return bucket === "today";
        return bucket === "today" || bucket === "week";
    }
    function itemMatchesLifecycle(item: PurchasingItem): boolean {
        if (lifecycleFilter === "all") return true;
        return lifecycleBucket(item) === lifecycleFilter;
    }
    // Vendor is effectively hidden if vendor-level snoozed OR every item is individually snoozed
    function vendorSnoozed(g: PurchasingGroup): boolean {
        return isSnoozed(`v:${g.vendorPartyId}`) || g.items.every(i => isSnoozed(i.productId));
    }
    // Inline dropdown — rendered as JSX, not a React component, to avoid closure issues
    function renderSnoozeMenu(k: string) {
        const snoozed = isSnoozed(k);
        return (
            <div className="absolute right-0 top-full mt-0.5 z-50 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[150px]">
                {snoozed ? (
                    <button onClick={() => doUnsnooze(k)}
                        className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-emerald-400 hover:bg-zinc-800">
                        ↩ Unsnooze
                    </button>
                ) : (
                    <>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-zinc-600 uppercase tracking-wider border-b border-zinc-800 mb-0.5">
                            Skip for
                        </div>
                        <button onClick={() => doSnooze(k, 30)}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                            30 days
                        </button>
                        <button onClick={() => doSnooze(k, 90)}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                            90 days
                        </button>
                        <button onClick={() => doSnooze(k, "forever")}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 border-t border-zinc-800 mt-0.5">
                            Always skip
                        </button>
                    </>
                )}
            </div>
        );
    }

    // ── data load ──────────────────────────────────────────────────────────
    // Progressive urgency-tier loading: critical first, then warning, watch, ok.
    // On bust, only tier 1 busts the server cache; subsequent tiers hit warm cache.
    async function load(bust = false) {
        setError(null);
        if (!data) setLoading(true);
        else if (bust) setScanning(true);

        const errors: string[] = [];

        const runTier = async (tier: UrgencyTier, bustThis: boolean): Promise<boolean> => {
            setLoadingTiers(p => new Set([...p, tier]));
            try {
                const res = await fetch(`/api/dashboard/purchasing?urgency=${tier}${bustThis ? '&bust=1' : ''}`);
                const json: AssessmentData = await res.json();
                if (!res.ok) throw new Error(json.error || `Failed tier ${tier}`);

                // Merge incoming groups without clobbering existing UI state
                setData(prev => {
                    if (!prev) return json;
                    const existingIds = new Set(prev.groups.map(g => g.vendorPartyId));
                    const newGroups = json.groups.filter(g => !existingIds.has(g.vendorPartyId));
                    const mergedGroups = [...prev.groups, ...newGroups];
                    // Keep vendorSummaries from the latest response
                    return {
                        groups: mergedGroups,
                        cachedAt: json.cachedAt,
                        vendorSummaries: json.vendorSummaries ?? prev.vendorSummaries,
                    };
                });

                // Init checkboxes/qtys for new groups
                setChecked(prev => {
                    const next: Record<string, Record<string, boolean>> = { ...prev };
                    for (const g of json.groups) {
                        if (next[g.vendorPartyId]) continue; // preserve existing
                        next[g.vendorPartyId] = {};
                        for (const item of g.items) {
                            next[g.vendorPartyId][item.productId] = shouldAutoSelectItem(item);
                        }
                    }
                    return next;
                });

                setQtys(prev => {
                    const next: Record<string, Record<string, number>> = { ...prev };
                    for (const g of json.groups) {
                        if (next[g.vendorPartyId]) continue;
                        next[g.vendorPartyId] = {};
                        for (const item of g.items) {
                            // Default to OUR suggestion when quantities diverge (>20%)
                            next[g.vendorPartyId][item.productId] = item.assessment?.recommendedQty ?? item.suggestedQty;
                        }
                    }
                    return next;
                });

                return true;
            } catch (e: any) {
                errors.push(e.message);
                return false;
            } finally {
                setLoadingTiers(p => {
                    const n = new Set(p);
                    n.delete(tier);
                    return n;
                });
            }
        };

        let anySuccess = false;

        // Tier 1: critical — bust if requested. Always render even if empty.
        if (await runTier('critical', bust)) anySuccess = true;
        if (anySuccess) {
            setLoading(false);
            setScanning(false);
        }

        // Remaining tiers share the warm cache and can load together. This keeps
        // Ordering from feeling like it is filling one bucket at a time.
        await Promise.all((['warning', 'watch', 'ok'] as UrgencyTier[]).map(tier => runTier(tier, false)));

        if (errors.length > 0 && !anySuccess) {
            setError(errors.join(' | '));
        } else if (errors.length > 0) {
            setError(errors.join(' | '));
        }
    }

    useEffect(() => { load(); }, []);

    function toggleExpand(id: string) {
        setExpanded(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    function toggleItem(pid: string, itemId: string) {
        const item = data?.groups.find(group => group.vendorPartyId === pid)?.items.find(candidate => candidate.productId === itemId);
        if (item && !canIncludeInDraftPO(item.reorderMethod)) return;
        setChecked(p => ({ ...p, [pid]: { ...p[pid], [itemId]: !p[pid]?.[itemId] } }));
    }
    function setQty(pid: string, itemId: string, v: number) {
        setQtys(p => ({ ...p, [pid]: { ...p[pid], [itemId]: Math.max(1, v) } }));
    }
    function selectAll(group: PurchasingGroup, val: boolean) {
        setChecked(p => {
            const n = { ...p[group.vendorPartyId] };
            // only select/deselect draft-eligible, non-snoozed items
            group.items
                .filter(i => !isSnoozed(i.productId) && canIncludeInDraftPO(i.reorderMethod))
                .forEach(i => { n[i.productId] = val; });
            return { ...p, [group.vendorPartyId]: n };
        });
    }

    async function createVendorPO(group: PurchasingGroup): Promise<POResult | null> {
        const pid = group.vendorPartyId;
        const items = group.items
            .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId] && canIncludeInDraftPO(i.reorderMethod))
            .map(i => ({ productId: i.productId, quantity: qtys[pid]?.[i.productId] ?? i.suggestedQty, unitPrice: i.unitPrice, orderIncrementQty: i.orderIncrementQty ?? null, isBulkDelivery: i.isBulkDelivery ?? false }));
        if (items.length === 0) return null;
        const res = await fetch("/api/dashboard/purchasing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vendorPartyId: pid, items, memo: "Purchasing Intelligence draft — review and commit in Finale" }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        return json as POResult;
    }

    async function handleCreateOne(group: PurchasingGroup) {
        const pid = group.vendorPartyId;

        // Soft guard: warn if any selected SKU already has open POs covering it.
        // Catches the muscle-memory double-order on rows where Aria is suggesting
        // a top-up rather than a fresh order.
        const selectedItemsWithOpenPOs = group.items.filter(item =>
            !isSnoozed(item.productId)
            && checked[pid]?.[item.productId]
            && item.openPOs
            && item.openPOs.length > 0
        );
        if (selectedItemsWithOpenPOs.length > 0) {
            const lines = selectedItemsWithOpenPOs.map(item => {
                const pos = item.openPOs.map(p => {
                    const d = openPosDetail.get(p.orderId);
                    const eta = d?.expectedDate ? ` · ETA ${new Date(d.expectedDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}` : '';
                    return `PO ${p.orderId} (qty ${p.quantity}${eta})`;
                }).join(', ');
                return `  • ${item.productId}: ${pos}`;
            }).join('\n');
            const proceed = window.confirm(
                `${selectedItemsWithOpenPOs.length} SKU(s) already have open POs in flight:\n\n${lines}\n\n` +
                `Aria still recommends ordering more (incremental need beyond what's coming).\n\n` +
                `Create a new draft PO anyway?`
            );
            if (!proceed) return;
        }

        setCreatingPO(p => new Set(p).add(pid));
        try {
            const result = await createVendorPO(group);
            if (result) setCreatedPOs(p => ({ ...p, [pid]: result }));
            await load(true);
        } catch (e: any) {
            setError(`PO failed for ${group.vendorName}: ${e.message}`);
        } finally {
            setCreatingPO(p => { const n = new Set(p); n.delete(pid); return n; });
        }
    }

    async function handleCreateAll() {
        const groups = visibleGroups.filter(g =>
            !vendorSnoozed(g) &&
            !createdPOs[g.vendorPartyId] &&
            g.items.some(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId])
        );
        if (groups.length === 0) return;
        setCreatingPO(new Set(groups.map(g => g.vendorPartyId)));
        const results = await Promise.allSettled(groups.map(g => createVendorPO(g)));
        const updates: Record<string, POResult> = {};
        const errs: string[] = [];
        results.forEach((r, idx) => {
            if (r.status === "fulfilled" && r.value) updates[groups[idx].vendorPartyId] = r.value;
            else if (r.status === "rejected") errs.push(`${groups[idx].vendorName}: ${r.reason?.message ?? "failed"}`);
        });
        if (Object.keys(updates).length) setCreatedPOs(p => ({ ...p, ...updates }));
        if (errs.length) setError(errs.join(" | "));
        setCreatingPO(new Set());
        if (Object.keys(updates).length > 0) await load(true);
    }

    async function handleReviewAndSend(orderId: string) {
        setCommitLoading(orderId);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'review', orderId }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Failed to fetch PO review'); return; }
            setCommitModal({ sendId: json.sendId, review: json.review, email: json.email, emailSource: json.emailSource });
        } catch (e: any) {
            setError(`Review failed: ${e.message}`);
        } finally {
            setCommitLoading(null);
        }
    }

    async function handleConfirmSend(skipEmail: boolean = false) {
        if (!commitModal?.sendId) return;
        setSendingPO(true);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', sendId: commitModal.sendId, skipEmail }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Send failed'); return; }
            setSentPOs(p => new Set(p).add(commitModal.review.orderId));
            setCommitModal(null);
            await load(true);
        } catch (e: any) {
            setError(`Send failed: ${e.message}`);
        } finally {
            setSendingPO(false);
        }
    }

    async function handleCancelCommit() {
        if (commitModal?.sendId) {
            fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'cancel', sendId: commitModal.sendId }),
            }).catch(() => { });
        }
        setCommitModal(null);
    }

    // ── ULINE direct ordering ──────────────────────────────────────────────
    function isUlineVendor(vendorName: string): boolean {
        return vendorName.toLowerCase().includes("uline");
    }

    async function handleOrderOnUline(group: PurchasingGroup) {
        const pid = group.vendorPartyId;
        const draftPO = createdPOs[pid]?.orderId;
        const items = group.items
            .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId] && canUseDirectOrdering(group.vendorName, i.reorderMethod))
            .map(i => ({
                productId: i.productId,
                quantity: qtys[pid]?.[i.productId] ?? i.suggestedQty,
                unitPrice: i.unitPrice,
            }));

        if (items.length === 0) return;

        setUlineOrdering(true);
        setUlineResult(null);
        try {
            const res = await fetch('/api/dashboard/purchasing/uline-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items, draftPO }),
            });
            const result: UlineOrderResult = await res.json();
            setUlineResult(result);
            if (result.success) await load(true);
        } catch (e: any) {
            setUlineResult({ success: false, itemsAdded: 0, message: e.message });
        } finally {
            setUlineOrdering(false);
        }
    }

    // ── derived state ──────────────────────────────────────────────────────
    const allGroups = data?.groups ?? [];
    const sortedGroups = [...allGroups].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
    const activeGroups = sortedGroups.filter(g => !vendorSnoozed(g));
    const displayGroups = showSnoozed ? sortedGroups : activeGroups;
    const focusGroups = displayGroups
        .map(group => ({
            ...group,
            items: sortItemsByNeed(group.items.filter(item => itemMatchesFocus(item) && itemMatchesLifecycle(item))),
        }))
        .filter(group => group.items.length > 0 || !!createdPOs[group.vendorPartyId]);

    // Lifecycle bucket counts — computed across all focus-matched items so tabs
    // reveal what's hidden on the current focus window. Uses the same vendor
    // visibility filter (snooze) as the rest of the pipeline.
    const lifecycleCounts: Record<LifecycleBucket, number> = { need: 0, topping: 0, on_order: 0, other: 0 };
    for (const g of displayGroups) {
        for (const item of g.items) {
            if (!itemMatchesFocus(item)) continue;
            lifecycleCounts[lifecycleBucket(item)]++;
        }
    }
    const visibleGroups = vendorTab === "all" ? focusGroups : focusGroups.filter(g => g.vendorPartyId === vendorTab);

    // Total hidden items across all snoozed vendors + individually snoozed items
    const hiddenItemCount = sortedGroups.reduce((n, g) => {
        if (isSnoozed(`v:${g.vendorPartyId}`)) return n + g.items.length;
        return n + g.items.filter(i => isSnoozed(i.productId)).length;
    }, 0);

    const todayCount = activeGroups.flatMap(g => g.items).filter(item => getOrderingFocusBucket(item) === "today").length;
    const weekCount = activeGroups.flatMap(g => g.items).filter(item => getOrderingFocusBucket(item) === "week").length;
    const actionableVendors = focusGroups.filter(g =>
        !createdPOs[g.vendorPartyId] &&
        g.items.some(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId])
    );
    const isLoading = loading || scanning;
    const anyCreating = creatingPO.size > 0;

    useEffect(() => {
        if (vendorTab !== "all" && !focusGroups.some(g => g.vendorPartyId === vendorTab)) {
            setVendorTab("all");
        }
    }, [focusGroups, vendorTab]);

    const GROUP_HEADER_ESTIMATE = 52;
    const SELECT_ALL_ESTIMATE = 34;
    const ITEM_ROW_ESTIMATE = 132;
    const VIRTUAL_OVERSCAN_PX = 700;

    const estimatedGroupHeights = visibleGroups.map(group => {
        const pid = group.vendorPartyId;
        const vSnoozed = vendorSnoozed(group);
        const isExpanded = !vSnoozed && (expanded.has(pid) || vendorTab === pid);
        if (!isExpanded) return GROUP_HEADER_ESTIMATE;
        const itemCount = group.items.filter(item => showSnoozed || !isSnoozed(item.productId)).length;
        return GROUP_HEADER_ESTIMATE + SELECT_ALL_ESTIMATE + itemCount * ITEM_ROW_ESTIMATE;
    });
    const totalVirtualHeight = estimatedGroupHeights.reduce((sum, h) => sum + h, 0);
    const virtualTop = Math.max(0, listScrollTop - VIRTUAL_OVERSCAN_PX);
    const virtualBottom = listScrollTop + bodyHeight + VIRTUAL_OVERSCAN_PX;
    let measuredTop = 0;
    let virtualStart = 0;
    let virtualEnd = visibleGroups.length;
    let cursor = 0;
    for (let i = 0; i < estimatedGroupHeights.length; i++) {
        const next = cursor + estimatedGroupHeights[i];
        if (next < virtualTop) {
            virtualStart = i + 1;
            measuredTop = next;
        }
        if (cursor <= virtualBottom) {
            virtualEnd = i + 1;
        }
        cursor = next;
    }
    const virtualGroups = visibleGroups.slice(virtualStart, virtualEnd);
    const measuredBottom = estimatedGroupHeights.slice(virtualStart, virtualEnd).reduce((sum, h) => sum + h, 0);
    const virtualBottomPad = Math.max(0, totalVirtualHeight - measuredTop - measuredBottom);

    // ── render ─────────────────────────────────────────────────────────────
    return (
        <div className="border-b border-zinc-800 shrink-0">
            {/* Commit & Send modal */}
            {commitModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
                        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                            <span className="text-sm font-mono font-semibold text-zinc-200">Commit & Send PO #{commitModal.review.orderId}</span>
                            <div className="flex-1" />
                            <span className="text-[10px] font-mono text-zinc-600">{commitModal.review.vendorName}</span>
                        </div>
                        <div className="px-4 py-3 space-y-1 max-h-60 overflow-y-auto">
                            {commitModal.review.items.map(item => (
                                <div key={item.productId} className="flex items-center gap-2 text-[11px] font-mono">
                                    <span className="text-zinc-500 w-36 truncate shrink-0">{item.productId}</span>
                                    <span className="text-zinc-400 flex-1 truncate">{item.productName}</span>
                                    <span className="text-zinc-500 shrink-0">×{item.quantity}</span>
                                    <span className="text-zinc-400 shrink-0">${item.unitPrice.toFixed(2)}</span>
                                    <span className="text-zinc-300 shrink-0 w-20 text-right">${item.lineTotal.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-between text-[11px] font-mono">
                            <span className="text-zinc-500">Total</span>
                            <span className="text-zinc-200 font-semibold">${commitModal.review.total.toFixed(2)}</span>
                        </div>
                        <div className="px-4 py-2 border-t border-zinc-800/60 text-[11px] font-mono">
                            {commitModal.email ? (
                                <span className="text-zinc-400">To: <span className="text-zinc-200">{commitModal.email}</span> <span className="text-zinc-600">({commitModal.emailSource})</span></span>
                            ) : (
                                <span className="text-amber-400">⚠ No vendor email on file. You can still commit the PO to Finale.</span>
                            )}
                        </div>
                        {commitModal.email && (
                            <div className="px-4 py-2 text-[10px] font-mono text-amber-500/80 border-t border-zinc-800/40 bg-amber-500/10">
                                ⚠ This will commit the PO in Finale AND email the vendor.
                            </div>
                        )}
                        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
                            <button onClick={handleCancelCommit}
                                className="text-[11px] font-mono px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={() => handleConfirmSend(true)}
                                disabled={sendingPO}
                                className="text-[11px] font-mono px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-40"
                            >
                                Commit Only
                            </button>
                            {commitModal.email && (
                                <button
                                    onClick={() => handleConfirmSend(false)}
                                    disabled={sendingPO}
                                    className="text-[11px] font-mono px-4 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-600 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                                >
                                    {sendingPO && <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />}
                                    {sendingPO ? 'Sending…' : '✅ Commit & Email Vendor'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Backdrop — closes any open snooze dropdown */}
            {snoozeMenu && (
                <div className="fixed inset-0 z-40" onClick={() => setSnoozeMenu(null)} />
            )}

            {/* ── Header ── */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Ordering</span>
                {data && !scanning && <span className="text-[10px] text-[var(--dash-ts)] ml-auto mr-0 font-mono">{timeAgo(data.cachedAt)}</span>}
                {scanning && <span className="text-xs text-zinc-600 font-mono">scanning…</span>}
                {loadingTiers.size > 0 && !scanning && (
                    <span className="text-[10px] text-zinc-600 font-mono">
                        loading {Array.from(loadingTiers).join(',')}…
                    </span>
                )}
                {loadingTiers.size > 0 && !scanning && (
                    <span className="text-[10px] text-zinc-600 font-mono">
                        loading {Array.from(loadingTiers).join(',')}…
                    </span>
                )}
                <div className="flex-1" />

                <button
                    onClick={() => setFocusFilter("today")}
                    className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded border transition-colors ${focusFilter === "today"
                        ? "bg-red-500/20 text-red-300 border-red-500/40"
                        : "text-zinc-500 border-zinc-700 hover:text-zinc-300"
                        }`}
                >
                    {todayCount} TODAY
                </button>
                <button
                    onClick={() => setFocusFilter("week")}
                    className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${focusFilter === "week"
                        ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40"
                        : "text-zinc-500 border-zinc-700 hover:text-zinc-300"
                        }`}
                >
                    {weekCount} WEEK
                </button>
                <button
                    onClick={() => setFocusFilter("all")}
                    className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${focusFilter === "all"
                        ? "bg-zinc-700 text-zinc-200 border-zinc-600"
                        : "text-zinc-500 border-zinc-700 hover:text-zinc-300"
                        }`}
                >
                    ALL {activeGroups.length}
                </button>

                {/* Snoozed badge — toggles reveal */}
                {hiddenItemCount > 0 && (
                    <button
                        onClick={() => setShowSnoozed(s => !s)}
                        className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${showSnoozed
                            ? "bg-zinc-700 text-zinc-300 border-zinc-600"
                            : "bg-transparent text-zinc-600 border-zinc-800 hover:text-zinc-400 hover:border-zinc-700"
                            }`}
                        title={showSnoozed ? "Hide snoozed" : "Show snoozed items"}
                    >
                        <Eye className="w-2.5 h-2.5" />
                        {hiddenItemCount} snoozed
                    </button>
                )}

                {!isLoading && activeGroups.length === 0 && hiddenItemCount === 0 && (
                    <span className="text-xs font-mono text-zinc-600">all clear</span>
                )}

                {actionableVendors.length > 1 && !anyCreating && (
                    <button onClick={handleCreateAll}
                        className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors"
                        title={`Create draft POs for all ${actionableVendors.length} selected vendors at once`}
                    >
                        <Zap className="w-2.5 h-2.5" />
                        {actionableVendors.length} POs
                    </button>
                )}
                {anyCreating && (
                    <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
                        <div className="w-2 h-2 border border-zinc-600 border-t-transparent rounded-full animate-spin" />
                        creating…
                    </span>
                )}
                <button onClick={() => load(true)} disabled={isLoading}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                    title="Re-scan Finale">
                    <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </button>
                <button onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {/* ── Lifecycle tabs ── segments rows by whether action is needed despite open POs */}
                    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-950/40 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider mr-1 shrink-0">show</span>
                        {([
                            { k: "need" as const, label: "Need Order", tone: "bg-red-500/15 text-red-300 border-red-500/40", inactive: "text-zinc-400 border-zinc-700 hover:text-zinc-200" },
                            { k: "topping" as const, label: "Topping Up", tone: "bg-amber-500/15 text-amber-300 border-amber-500/40", inactive: "text-zinc-500 border-zinc-700 hover:text-zinc-300" },
                            { k: "on_order" as const, label: "On Order", tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", inactive: "text-zinc-500 border-zinc-800 hover:text-zinc-300" },
                            { k: "other" as const, label: "Other Holds", tone: "bg-zinc-700 text-zinc-200 border-zinc-500", inactive: "text-zinc-500 border-zinc-800 hover:text-zinc-300" },
                        ]).map(t => (
                            <button key={t.k}
                                onClick={() => setLifecycleFilter(t.k)}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors shrink-0 ${lifecycleFilter === t.k ? t.tone : t.inactive}`}
                                title={t.k === "need" ? "Need a fresh PO — nothing already on order"
                                    : t.k === "topping" ? "Open PO exists but Aria sees additional need"
                                    : t.k === "on_order" ? "Open PO already covers near-term need — no action"
                                    : "Other holds (FG covered, uneconomic, manual review)"}
                            >
                                {t.label} <span className="opacity-60">{lifecycleCounts[t.k]}</span>
                            </button>
                        ))}
                        <button onClick={() => setLifecycleFilter("all")}
                            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors shrink-0 ${lifecycleFilter === "all" ? "bg-zinc-700 text-zinc-200 border-zinc-500" : "text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
                            title="All buckets at once"
                        >
                            All <span className="opacity-60">{lifecycleCounts.need + lifecycleCounts.topping + lifecycleCounts.on_order + lifecycleCounts.other}</span>
                        </button>
                    </div>

                    {/* ── Vendor tabs ── active vendors + snoozed (greyed) when showSnoozed */}
                    {focusGroups.length > 0 && (
                        <div className="flex items-center border-b border-zinc-800/60 bg-zinc-950/30 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            <button
                                onClick={() => setVendorTab("all")}
                                className={`px-3 py-1.5 text-xs font-mono whitespace-nowrap border-b-2 transition-colors shrink-0 ${vendorTab === "all"
                                    ? "border-zinc-300 text-zinc-100 bg-zinc-800/30"
                                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                                    }`}
                            >
                                {focusFilter === "today" ? "Today" : focusFilter === "week" ? "This Week" : "All"} <span className="opacity-60">{focusGroups.length}</span>
                            </button>

                            {focusGroups.map(g => {
                                const vSnoozed = vendorSnoozed(g);
                                const cfg = URGENCY[g.urgency];
                                const isActive = vendorTab === g.vendorPartyId;
                                const hasPO = !!createdPOs[g.vendorPartyId];
                                const checkedCount = g.items.filter(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId]).length;
                                return (
                                    <button key={g.vendorPartyId}
                                        onClick={() => setVendorTab(g.vendorPartyId)}
                                        className={`px-3 py-1.5 text-xs font-mono whitespace-nowrap border-b-2 transition-colors shrink-0 flex items-center gap-1 ${vSnoozed
                                            ? "border-transparent text-zinc-700 hover:text-zinc-500"
                                            : isActive
                                                ? `${cfg.tab} bg-zinc-800/30`
                                                : "border-transparent text-zinc-400 hover:text-zinc-200"
                                            }`}
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                        <span className={vSnoozed ? "line-through" : ""}>
                                            {g.vendorName.length > 14 ? g.vendorName.slice(0, 12) + "…" : g.vendorName}
                                        </span>
                                        {!vSnoozed && (hasPO
                                            ? <span className="text-emerald-500 ml-0.5">✓</span>
                                            : checkedCount > 0
                                                ? <span className="text-zinc-500 ml-0.5">{checkedCount}</span>
                                                : null
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {isLoading && !data && (
                        <div className="px-4 py-2 space-y-2.5">
                            {[1, 2, 3, 4].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-2 h-2 rounded-full skeleton-shimmer shrink-0" />
                                    <div className="skeleton-shimmer h-3.5" style={{ width: `${50 + i * 12}%` }} />
                                    <div className="skeleton-shimmer h-3 w-10 ml-auto" />
                                </div>
                            ))}
                        </div>
                    )}
                    {error && (
                        <div className="px-4 py-2 border-t border-zinc-800/60 text-xs font-mono text-rose-400/80">{error}</div>
                    )}

                    {data && visibleGroups.length > 0 && (
                        <>
                            <div
                                className="overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full"
                                style={{ height: bodyHeight }}
                                onScroll={e => setListScrollTop(e.currentTarget.scrollTop)}
                            >
                                <div style={{ height: measuredTop }} aria-hidden="true" />
                                {virtualGroups.map(group => {
                                    const cfg = URGENCY[group.urgency];
                                    const pid = group.vendorPartyId;
                                    const vSnoozeKey = `v:${pid}`;
                                    const vSnoozed = vendorSnoozed(group);
                                    const isExpanded = !vSnoozed && (expanded.has(pid) || vendorTab === pid);
                                    const isCreatingThis = creatingPO.has(pid);
                                    const po = createdPOs[pid];
                                    const groupChecked = checked[pid] ?? {};
                                    const groupQtys = qtys[pid] ?? {};
                                    const activeItems = group.items.filter(i => !isSnoozed(i.productId));
                                    const selectedItems = activeItems.filter(i => groupChecked[i.productId]);
                                    const directOrderBlocked = selectedItems.some(i => !canUseDirectOrdering(group.vendorName, i.reorderMethod));
                                    const selectedCount = activeItems.filter(i => groupChecked[i.productId]).length;
                                    const selectedUnits = selectedItems.reduce((sum, item) => sum + (groupQtys[item.productId] ?? item.suggestedQty), 0);
                                    const selectedValue = selectedItems.reduce((sum, item) => {
                                        const qty = groupQtys[item.productId] ?? item.suggestedQty;
                                        return sum + qty * Math.max(0, item.unitPrice);
                                    }, 0);
                                    const earliestRunway = activeItems.length > 0
                                        ? Math.min(...activeItems.map(item => item.runwayDays))
                                        : null;
                                    const diffCount = activeItems.filter(item => item.qtyDiverged).length;
                                    const allCheckedFlag = activeItems.length > 0 && activeItems.every(i => groupChecked[i.productId]);
                                    const hasActionable = activeItems.some(i => i.urgency === "critical" || i.urgency === "warning");
                                    const groupProductIds = activeItems.map(item => item.productId);
                                    const groupMatchesLifecycle = lifecycle.matchesFocus({
                                        vendorName: group.vendorName,
                                        productIds: groupProductIds,
                                    });

                                    return (
                                        <div
                                            key={pid}
                                            onMouseEnter={() => lifecycle.setFocus({ source: "ordering", vendorName: group.vendorName, productIds: groupProductIds })}
                                            onMouseLeave={lifecycle.clearFocus}
                                            className={`border-b border-zinc-800/60 ${vSnoozed ? "opacity-45" : ""} ${groupMatchesLifecycle ? "bg-cyan-500/5 ring-1 ring-inset ring-cyan-500/35" : ""}`}
                                        >
                                            {/* ── Vendor header ── */}
                                            <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-zinc-800/30 transition-colors">
                                                <span className={`w-2 h-2 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                                <button
                                                    onClick={() => !vSnoozed && toggleExpand(pid)}
                                                    className="flex-1 text-left flex items-center gap-2 min-w-0"
                                                >
                                                    <span className={`text-base font-mono font-semibold truncate ${vSnoozed ? "line-through text-zinc-600" : "text-zinc-50"}`}>
                                                        {group.vendorName}
                                                    </span>
                                                    <span className="text-xs font-mono text-zinc-200 shrink-0">
                                                        {vSnoozed
                                                            ? (isSnoozed(vSnoozeKey) ? snoozeLabel(vSnoozeKey) : "all skipped")
                                                            : `${activeItems.length} SKU${activeItems.length !== 1 ? "s" : ""}`}
                                                    </span>
                                                    {!vSnoozed && earliestRunway != null && (
                                                        <span className={`text-xs font-mono shrink-0 ${runwayColor(earliestRunway)}`}>
                                                            first out {Math.round(earliestRunway)}d
                                                        </span>
                                                    )}
                                                    {!vSnoozed && selectedCount > 0 && (
                                                        <span className="text-xs font-mono text-emerald-300 shrink-0">
                                                            selected {selectedCount} / {selectedUnits} units
                                                            {selectedValue > 0 ? ` / $${selectedValue.toFixed(0)}` : ""}
                                                        </span>
                                                    )}
                                                    {!vSnoozed && diffCount > 0 && (
                                                        <span className="text-[11px] font-mono text-amber-300 border border-amber-500/30 rounded px-1 shrink-0">
                                                            {diffCount} qty diff
                                                        </span>
                                                    )}
                                                </button>

                                                {!vSnoozed && cfg.label && (
                                                    <span className={`text-[10px] font-mono shrink-0 ${group.urgency === "critical"
                                                            ? (po ? `px-1 py-0.5 rounded border ${cfg.badgeOutline}` : `px-1 py-0.5 rounded border ${cfg.badge}`)
                                                            : cfg.badge
                                                        }`}>
                                                        {cfg.label}
                                                    </span>
                                                )}
                                                {vSnoozed ? (
                                                    /* Restore entire snoozed vendor */
                                                    <button
                                                        onClick={() => {
                                                            const updated = { ...snooze };
                                                            delete updated[vSnoozeKey];
                                                            group.items.forEach(i => delete updated[i.productId]);
                                                            setSnooze(updated);
                                                            localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
                                                        }}
                                                        className="text-[10px] font-mono text-zinc-600 hover:text-emerald-400 shrink-0 transition-colors"
                                                    >
                                                        ↩ restore
                                                    </button>
                                                ) : (
                                                    <>
                                                        {po ? (
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <a href={po.finaleUrl} target="_blank" rel="noreferrer"
                                                                    className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 hover:text-emerald-300">
                                                                    PO #{po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                                                </a>
                                                                {sentPOs.has(po.orderId) ? (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                ) : (
                                                                    <button
                                                                        onClick={() => handleReviewAndSend(po.orderId)}
                                                                        disabled={commitLoading === po.orderId}
                                                                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-600 transition-colors disabled:opacity-40"
                                                                        title="Commit in Finale and email vendor"
                                                                    >
                                                                        {commitLoading === po.orderId ? '…' : 'Commit & Send'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <button
                                                                    onClick={() => selectedCount > 0 ? handleCreateOne(group) : toggleExpand(pid)}
                                                                    disabled={anyCreating}
                                                                    className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 shrink-0 ${selectedCount > 0
                                                                        ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 border-zinc-700"
                                                                        : "bg-transparent text-zinc-600 border-zinc-800"
                                                                        }`}
                                                                >
                                                                    {isCreatingThis && <div className="w-2 h-2 border border-zinc-600 border-t-transparent rounded-full animate-spin" />}
                                                                    {selectedCount > 0 ? `Draft PO (${selectedCount})` : "Draft PO"}
                                                                </button>
                                                                {/* ULINE: Order Now button — fires items directly to ULINE cart */}
                                                                {isUlineVendor(group.vendorName) && selectedCount > 0 && !directOrderBlocked && (
                                                                    <button
                                                                        onClick={() => handleOrderOnUline(group)}
                                                                        disabled={ulineOrdering}
                                                                        className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-700/80 hover:bg-amber-600 text-amber-100 border-amber-600 transition-colors disabled:opacity-40 shrink-0"
                                                                        title="Add selected items to ULINE cart via Quick Order"
                                                                    >
                                                                        {ulineOrdering
                                                                            ? <div className="w-2 h-2 border border-amber-300 border-t-transparent rounded-full animate-spin" />
                                                                            : <ShoppingCart className="w-2.5 h-2.5" />}
                                                                        {ulineOrdering ? 'Ordering…' : 'Order on ULINE'}
                                                                    </button>
                                                                )}
                                                                {isUlineVendor(group.vendorName) && selectedCount > 0 && directOrderBlocked && (
                                                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/20 text-amber-300/80 shrink-0">
                                                                        {directOrderBlockReason(selectedItems)}
                                                                    </span>
                                                                )}
                                                            </>
                                                        )}
                                                        {/* Vendor-level snooze menu */}
                                                        <div className="relative shrink-0">
                                                            <button
                                                                onClick={e => { e.stopPropagation(); setSnoozeMenu(snoozeMenu === vSnoozeKey ? null : vSnoozeKey); }}
                                                                className="px-1 py-0.5 text-[11px] font-mono text-zinc-700 hover:text-zinc-400 transition-colors"
                                                                title="Snooze this vendor"
                                                            >···</button>
                                                            {snoozeMenu === vSnoozeKey && renderSnoozeMenu(vSnoozeKey)}
                                                        </div>
                                                        <ChevronDown
                                                            onClick={() => toggleExpand(pid)}
                                                            className={`w-3.5 h-3.5 text-zinc-700 transition-transform shrink-0 cursor-pointer ${isExpanded ? "" : "-rotate-90"}`}
                                                        />
                                                    </>
                                                )}
                                            </div>

                                            {/* ── Item rows ── */}
                                            {isExpanded && (
                                                <div className="bg-zinc-950/40 border-t border-zinc-800/30">
                                                    {/* Select-all bar */}
                                                    <div className="flex items-center gap-2 px-4 py-1 border-b border-zinc-800/20">
                                                        <input type="checkbox" checked={allCheckedFlag}
                                                            onChange={e => selectAll(group, e.target.checked)}
                                                            className="w-3 h-3 rounded accent-zinc-400 shrink-0" />
                                                        <span className="text-[11px] font-mono text-zinc-400">
                                                            {allCheckedFlag ? "Deselect all" : "Select all"}
                                                        </span>
                                                        <div className="flex-1" />
                                                        {po ? (
                                                            <div className="flex items-center gap-2">
                                                                <a href={po.finaleUrl} target="_blank" rel="noreferrer"
                                                                    className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                                                                    ✓ PO #{po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                                                </a>
                                                                {sentPOs.has(po.orderId) ? (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                ) : (
                                                                    <button
                                                                        onClick={() => handleReviewAndSend(po.orderId)}
                                                                        disabled={commitLoading === po.orderId}
                                                                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors disabled:opacity-40"
                                                                    >
                                                                        {commitLoading === po.orderId ? 'Loading…' : 'Commit & Send'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : selectedCount > 0 ? (
                                                            <div className="flex items-center gap-1.5">
                                                                <button onClick={() => handleCreateOne(group)} disabled={anyCreating}
                                                                    className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors disabled:opacity-40">
                                                                    {isCreatingThis ? "Creating…" : `→ Draft PO (${selectedCount} item${selectedCount !== 1 ? "s" : ""})`}
                                                                </button>
                                                                {isUlineVendor(group.vendorName) && !directOrderBlocked && (
                                                                    <button
                                                                        onClick={() => handleOrderOnUline(group)}
                                                                        disabled={ulineOrdering}
                                                                        className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-700/80 hover:bg-amber-600 text-amber-100 border border-amber-600 transition-colors disabled:opacity-40"
                                                                    >
                                                                        {ulineOrdering
                                                                            ? <div className="w-2 h-2 border border-amber-300 border-t-transparent rounded-full animate-spin" />
                                                                            : <ShoppingCart className="w-2.5 h-2.5" />}
                                                                        {ulineOrdering ? 'Ordering…' : 'Order on ULINE'}
                                                                    </button>
                                                                )}
                                                                {isUlineVendor(group.vendorName) && directOrderBlocked && (
                                                                    <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-amber-500/20 text-amber-300/80">
                                                                        {directOrderBlockReason(selectedItems)}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        ) : null}
                                                    </div>

                                                    {sortItemsByNeed(group.items)
                                                        .filter(item => showSnoozed || !isSnoozed(item.productId))
                                                        .map(item => {
                                                            const itemSnoozed = isSnoozed(item.productId);
                                                            const draftBlocked = !canIncludeInDraftPO(item.reorderMethod);
                                                            const isChecked = !itemSnoozed && !draftBlocked && (groupChecked[item.productId] ?? false);
                                                            const qty = groupQtys[item.productId] ?? item.suggestedQty;
                                                            const rc = runwayColor(item.runwayDays);
                                                            const isBundle = !itemSnoozed && item.urgency === "watch" && hasActionable;
                                                            const iKey = item.productId;
                                                            const methodBadge = reorderMethodBadge(item.reorderMethod);
                                                            const openOrderId = item.openPOs[0]?.orderId;
                                                            const itemMatchesLifecycle = lifecycle.matchesFocus({
                                                                vendorName: group.vendorName,
                                                                orderId: openOrderId,
                                                                productIds: [item.productId],
                                                            });

                                                            return (
                                                                <div key={iKey}
                                                                    onMouseEnter={() => lifecycle.setFocus({ source: "ordering", vendorName: group.vendorName, orderId: openOrderId, productIds: [item.productId] })}
                                                                    onMouseLeave={lifecycle.clearFocus}
                                                                    className={`px-4 py-3.5 border-b border-zinc-800/40 last:border-0 ${itemMatchesLifecycle ? "bg-cyan-500/8 ring-1 ring-inset ring-cyan-500/35" : ""} ${itemSnoozed ? "opacity-35" : isChecked ? "" : "opacity-90"
                                                                        }`}>
                                                                    <div className="flex items-start gap-3">
                                                                        {!itemSnoozed && (
                                                                            <input type="checkbox" checked={isChecked}
                                                                                onChange={() => toggleItem(pid, iKey)}
                                                                                disabled={draftBlocked}
                                                                                className={`mt-1 flex-shrink-0 w-3.5 h-3.5 rounded ${item.urgency === "critical" ? "accent-red-500"
                                                                                    : item.urgency === "warning" ? "accent-yellow-400"
                                                                                        : "accent-zinc-400"
                                                                                    } disabled:opacity-40`} />
                                                                        )}
                                                                        {itemSnoozed && <div className="mt-1 w-3.5 h-3.5" />}

                                                                        <div className="flex-1 min-w-0">
                                                                            {/* Row 1: Dot · SKU · Badges · Runway · Snooze */}
                                                                            <div className="flex items-center gap-2">
                                                                                <span className={`w-2 h-2 rounded-full shrink-0 ${itemSnoozed ? "bg-zinc-700" : URGENCY[item.urgency].dot}`} />
                                                                                <span className={`text-base font-mono font-bold truncate ${itemSnoozed ? "line-through text-zinc-600" : "text-zinc-50"}`}>
                                                                                    {item.productId}
                                                                                </span>

                                                                                {itemSnoozed && (
                                                                                    <span className="text-[9px] font-mono text-zinc-600 shrink-0">
                                                                                        {snoozeLabel(iKey)}
                                                                                    </span>
                                                                                )}
                                                                                {isBundle && (
                                                                                    <span className="text-[9px] font-mono text-blue-500/70 border border-blue-500/20 rounded px-1 shrink-0">
                                                                                        bundle?
                                                                                    </span>
                                                                                )}
                                                                                {methodBadge && !itemSnoozed && (
                                                                                    <span className={`text-[9px] font-mono border rounded px-1 shrink-0 ${reorderMethodTone(item.reorderMethod)}`}>
                                                                                        {methodBadge}
                                                                                    </span>
                                                                                )}
                                                                                {item.packSize && !itemSnoozed && (
                                                                                    <span className="text-[10px] font-mono text-zinc-400 shrink-0" title={`${item.packSize.unitsPerPack} ${item.packSize.packUnit} = 1 orderable pack`}>
                                                                                        {item.packSize.unitsPerPack}/{item.packSize.packUnit}
                                                                                    </span>
                                                                                )}
                                                                                {!itemSnoozed && item.vendorPolicy?.targetCoverDays != null && item.vendorPolicy.targetCoverDays > 0 && (
                                                                                    <span
                                                                                        className="text-[10px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-500/5 rounded px-1 shrink-0"
                                                                                        title={item.vendorPolicy.notes ?? "Vendor policy target cover window"}
                                                                                    >
                                                                                        {item.vendorPolicy.targetCoverDays}d cover
                                                                                    </span>
                                                                                )}
                                                                                {!itemSnoozed && item.vendorPolicy?.leadTimeOverrideDays != null && item.vendorPolicy.leadTimeOverrideDays > 0 && (
                                                                                    <span
                                                                                        className="text-[10px] font-mono text-zinc-300 border border-zinc-600/50 bg-zinc-800/40 rounded px-1 shrink-0"
                                                                                        title="Vendor policy lead-time override"
                                                                                    >
                                                                                        {item.vendorPolicy.leadTimeOverrideDays}d lead
                                                                                    </span>
                                                                                )}
                                                                                {!itemSnoozed && item.moqWarning && (
                                                                                    <span
                                                                                        className="text-[10px] font-mono text-amber-300 border border-amber-500/40 bg-amber-500/10 rounded px-1 shrink-0"
                                                                                        title="Vendor MOQ not met (warn-only — qty not bumped)"
                                                                                    >
                                                                                        MOQ warn
                                                                                    </span>
                                                                                )}
                                                                                {!itemSnoozed && item.reviewRequired && (
                                                                                    <span
                                                                                        className="text-[10px] font-mono text-red-300 border border-red-500/40 bg-red-500/10 rounded px-1 shrink-0"
                                                                                        title="Recommendation flagged for review — see reasons below"
                                                                                    >
                                                                                        Review
                                                                                    </span>
                                                                                )}

                                                                                <div className="flex-1" />

                                                                                {!itemSnoozed && (
                                                                                    <span className={`text-xs font-mono shrink-0 ${rc}`}>
                                                                                        Out in {Math.round(item.runwayDays)}d
                                                                                        {item.stockOnOrder > 0 && (
                                                                                            <span className="text-zinc-400 font-normal text-[10px]">
                                                                                                {" "}→{Math.round(item.adjustedRunwayDays)}d
                                                                                            </span>
                                                                                        )}
                                                                                    </span>
                                                                                )}

                                                                                <div className="relative shrink-0 ml-1">
                                                                                    <button
                                                                                        onClick={e => { e.stopPropagation(); setSnoozeMenu(snoozeMenu === iKey ? null : iKey); }}
                                                                                        className={`text-[11px] font-mono transition-colors ${itemSnoozed
                                                                                            ? "text-zinc-600 hover:text-emerald-400"
                                                                                            : "text-zinc-500 hover:text-zinc-300"
                                                                                            }`}
                                                                                        title={itemSnoozed ? "Unsnooze" : "Snooze this item"}
                                                                                    >{itemSnoozed ? "↩" : "···"}</button>
                                                                                    {snoozeMenu === iKey && renderSnoozeMenu(iKey)}
                                                                                </div>
                                                                            </div>

                                                                            {/* Row 1.5: Open-PO lifecycle ribbon — one chip per open PO covering this SKU */}
                                                                            {!itemSnoozed && item.openPOs && item.openPOs.length > 0 && (
                                                                                <div className="mt-1.5 flex flex-col gap-1">
                                                                                    {item.openPOs.map((openPo) => {
                                                                                        const detail = openPosDetail.get(openPo.orderId);
                                                                                        const stage = detail?.lifecycleStage;
                                                                                        // Color the chip by stage — green when shipped/delivered, amber when sent but unconfirmed, blue when sent+acked, gray when unknown.
                                                                                        const chipClass = stage === "delivered" || stage === "moving_with_tracking"
                                                                                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                                                                                            : stage === "vendor_acknowledged" || stage === "tracking_unavailable"
                                                                                                ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-200"
                                                                                                : detail?.sentVerification?.verified
                                                                                                    ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-200"
                                                                                                    : "bg-zinc-800/60 border-zinc-700/60 text-zinc-300";
                                                                                        // Build the inline status pieces.
                                                                                        const pieces: string[] = [];
                                                                                        if (detail?.sentVerification?.verified) pieces.push(`sent ✓`);
                                                                                        if (detail?.vendorAcknowledgedAt) pieces.push(`acked ${new Date(detail.vendorAcknowledgedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`);
                                                                                        if ((detail?.trackingNumbers?.length ?? 0) > 0) pieces.push(`📦 ${detail!.trackingNumbers![0].slice(-6)}`);
                                                                                        if (detail?.expectedDate) pieces.push(`ETA ${new Date(detail.expectedDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}`);
                                                                                        // Phase C — find the rec link for THIS sku (the one being recommended).
                                                                                        const recLink = (detail?.recLinks ?? []).find(r => r.productId === item.productId);
                                                                                        const recDivergence = recLink && recLink.recommendedQty > 0
                                                                                            ? Math.round(((recLink.draftedQty - recLink.recommendedQty) / recLink.recommendedQty) * 100)
                                                                                            : null;
                                                                                        return (
                                                                                            <div key={openPo.orderId} className={`flex items-center gap-2 text-[10.5px] font-mono px-2 py-1 rounded border ${chipClass}`}>
                                                                                                <span className="font-semibold shrink-0">PO {openPo.orderId}</span>
                                                                                                <span className="text-[10px] opacity-70 shrink-0">qty {openPo.quantity}</span>
                                                                                                {recLink && (
                                                                                                    <span
                                                                                                        className="text-[9.5px] font-mono text-cyan-300/80 border border-cyan-500/30 rounded px-1 shrink-0"
                                                                                                        title={`Aria recommended ${recLink.recommendedQty} on ${new Date(recLink.recommendedAt).toLocaleDateString()} → drafted ${recLink.draftedQty} on ${new Date(recLink.draftedAt).toLocaleDateString()}`}
                                                                                                    >
                                                                                                        rec {recLink.recommendedQty}→{recLink.draftedQty}
                                                                                                        {recDivergence != null && Math.abs(recDivergence) >= 10 && (
                                                                                                            <span className="ml-1 text-amber-400">{recDivergence > 0 ? '+' : ''}{recDivergence}%</span>
                                                                                                        )}
                                                                                                    </span>
                                                                                                )}
                                                                                                {pieces.length > 0 && <span className="text-zinc-500 shrink-0">·</span>}
                                                                                                <span className="truncate">{pieces.join(' · ')}</span>
                                                                                                {!detail && <span className="text-[9.5px] text-zinc-500 italic shrink-0">no tracking detail</span>}
                                                                                            </div>
                                                                                        );
                                                                                    })}
                                                                                </div>
                                                                            )}

                                                                            {/* Row 2: Description & Amount */}
                                                                            {!itemSnoozed && (
                                                                                <div className="flex items-center gap-2 mt-1">
                                                                                    <span className="text-[13px] font-mono text-zinc-200 flex-1 truncate">{item.productName}</span>
                                                                                    {item.reorderMethod === "default" && item.dailyRateSource === "demand" && (
                                                                                        <span className="text-[11px] font-mono text-zinc-300 shrink-0">
                                                                                            demand fallback
                                                                                        </span>
                                                                                    )}
                                                                                    {item.unitPrice > 0 ? (
                                                                                        <span className="text-xs font-mono text-emerald-300 font-semibold shrink-0">
                                                                                            ${item.unitPrice.toFixed(2)}/ea
                                                                                        </span>
                                                                                    ) : (
                                                                                        <span className="text-xs font-mono text-zinc-400 shrink-0">
                                                                                            $0.00
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                            )}

                                                                            {/* Row 3: Details & Qty */}
                                                                            {!itemSnoozed && (
                                                                                <div className="flex items-start justify-between gap-2 mt-2">
                                                                                    <div className="flex flex-col gap-1">
                                                                                        <div className="flex items-center gap-2 text-xs font-mono text-zinc-300">
                                                                                            <span>{item.dailyRate.toFixed(1)}/day</span>
                                                                                            {item.velocityInflated && item.velocityRawRate != null && (
                                                                                                <span
                                                                                                    title={`Finale reported ${item.velocityRawRate.toFixed(1)}/day demand — likely BOM consumption inflation. Capped to actual sales/receipts (${item.velocityRealityCap?.toFixed(2) ?? '0'}/day) to prevent over-ordering.`}
                                                                                                    className="text-[9px] font-mono text-amber-400 border border-amber-500/20 rounded px-1"
                                                                                                >
                                                                                                    ⚠ capped (Finale: {item.velocityRawRate.toFixed(1)}/d)
                                                                                                </span>
                                                                                            )}
                                                                                            <span>·</span>
                                                                                            <span>{Math.round(item.stockOnHand)} on hand</span>
                                                                                        </div>
                                                                                        {(item.finaleReorderQty ?? 0) > 0 && (
                                                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                                                <span className={`text-[11px] font-mono italic ${item.qtyDiverged ? 'text-amber-300' : 'text-cyan-300'}`}>
                                                                                                    Finale: {item.finaleReorderQty}
                                                                                                </span>
                                                                                                <span className="text-zinc-600 text-[10px]">→</span>
                                                                                                <span className={`text-[11px] font-mono font-semibold ${item.qtyDiverged ? 'text-emerald-300' : 'text-zinc-200'}`}>
                                                                                                    Aria: {item.suggestedQty}
                                                                                                </span>
                                                                                                {item.qtyDiverged && item.qtyDivergencePct != null && (
                                                                                                    <span className="text-[9px] font-mono text-amber-400 border border-amber-500/20 rounded px-1">
                                                                                                        ⚠ {Math.abs(item.qtyDivergencePct)}% diff
                                                                                                    </span>
                                                                                                )}
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="flex items-center gap-2">
                                                                                        <label className="flex items-center gap-1.5 shrink-0">
                                                                                            <span className="text-[11px] font-mono text-zinc-300">qty</span>
                                                                                            <input
                                                                                                type="number" min={1} value={qty}
                                                                                                onChange={e => setQty(pid, iKey, parseInt(e.target.value) || 1)}
                                                                                                onClick={e => e.stopPropagation()}
                                                                                                className="w-20 px-2 py-1 text-xs font-mono bg-zinc-900 border border-zinc-600 hover:border-zinc-400 rounded text-zinc-50 focus:outline-none focus:border-emerald-500 text-right transition-colors"
                                                                                            />
                                                                                        </label>
                                                                                        {item.unitPrice > 0 && (
                                                                                            <span className="text-xs font-mono text-zinc-200 font-semibold shrink-0 w-20 text-right">
                                                                                                = ${(qty * item.unitPrice).toFixed(0)}
                                                                                            </span>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                            )}

                                                                            {/* Row 4: Explanation + Why drawer */}
                                                                            {!itemSnoozed && (
                                                                                <div className="mt-2 space-y-1">
                                                                                    <div className="flex items-start justify-between gap-2">
                                                                                        <div className="text-[11px] font-mono text-zinc-400 italic flex-1">
                                                                                            {item.assessment?.explanation ?? item.explanation}
                                                                                        </div>
                                                                                        {item.recommendation && (
                                                                                            <button
                                                                                                onClick={(e) => { e.stopPropagation(); toggleWhy(`${pid}:${item.productId}`); }}
                                                                                                className="text-[10px] font-mono text-cyan-400 hover:text-cyan-200 underline-offset-2 hover:underline shrink-0"
                                                                                                title="Show full reorder math trace"
                                                                                            >
                                                                                                {whyOpen.has(`${pid}:${item.productId}`) ? "Hide why" : `Why ${item.suggestedQty}?`}
                                                                                            </button>
                                                                                        )}
                                                                                    </div>
                                                                                    {item.reviewReasons && item.reviewReasons.length > 0 && (
                                                                                        <div className="mt-1 rounded border border-red-500/40 bg-red-950/20 px-2 py-1 text-[11px] font-mono text-red-300 space-y-0.5">
                                                                                            {item.reviewReasons.map((reason, i) => (
                                                                                                <div key={i}>{reason}</div>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                    {item.recommendation && whyOpen.has(`${pid}:${item.productId}`) && (
                                                                                        <div className="mt-1 border border-cyan-900/40 bg-cyan-950/20 rounded p-2 space-y-1">
                                                                                            <div className="text-[10px] font-mono text-cyan-300/80 mb-1">
                                                                                                formula {item.recommendation.formulaVersion} · cover {item.recommendation.coverDays}d · raw need {Math.round(item.recommendation.rawNeededEaches)}
                                                                                            </div>
                                                                                            {item.recommendation.provenance.map((step, i) => (
                                                                                                <div key={i} className="text-[10.5px] font-mono text-zinc-300 leading-snug">
                                                                                                    <span className="text-cyan-400">{step.step}</span>
                                                                                                    <span className="text-zinc-500"> → </span>
                                                                                                    <span>{step.detail}</span>
                                                                                                </div>
                                                                                            ))}
                                                                                            {(item.finaleReorderQty ?? 0) > 0 && (
                                                                                                <div className="text-[10px] font-mono text-zinc-500 pt-1 border-t border-cyan-900/40">
                                                                                                    Finale says {item.finaleReorderQty} (ignored — Aria's trace above is the source of truth)
                                                                                                </div>
                                                                                            )}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                <div style={{ height: virtualBottomPad }} aria-hidden="true" />
                            </div>

                            {/* ULINE order result banner */}
                            {ulineResult && (
                                <div className={`px-4 py-2 text-[11px] font-mono flex items-center gap-2 border-t ${
                                    ulineResult.success
                                        ? 'bg-emerald-900/20 border-emerald-800/40 text-emerald-400'
                                        : 'bg-rose-900/20 border-rose-800/40 text-rose-400'
                                }`}>
                                    <span>{ulineResult.success ? '✅' : '⚠️'}</span>
                                    <span className="flex-1">{ulineResult.message}</span>
                                    <button
                                        onClick={() => setUlineResult(null)}
                                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                                    >✕</button>
                                </div>
                            )}

                            <div onMouseDown={startResize}
                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                title="Drag to resize" />
                        </>
                    )}

                    {/* Empty states */}
                    {!isLoading && activeGroups.length === 0 && hiddenItemCount === 0 && (
                        <div className="px-4 py-3 border-t border-zinc-800/60 text-xs font-mono text-zinc-600">
                            All purchased items have adequate runway.
                        </div>
                    )}
                    {!isLoading && activeGroups.length === 0 && hiddenItemCount > 0 && !showSnoozed && (
                        <div className="px-4 py-3 border-t border-zinc-800/60 text-xs font-mono text-zinc-600">
                            All active items covered.{" "}
                            <button onClick={() => setShowSnoozed(true)}
                                className="text-zinc-500 hover:text-zinc-300 underline transition-colors">
                                {hiddenItemCount} snoozed
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
