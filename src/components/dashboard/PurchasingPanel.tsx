"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown, ExternalLink, Eye, ShoppingCart, Loader2 } from "lucide-react";
import {
    canIncludeInDraftPO,
    canUseDirectOrdering,
    getEffectiveShortageDays,
    getOrderingFocusBucket,
    itemMatchesOrderingFocus,
    shouldAutoSelectItem,
    type OrderingFocusFilter,
} from "@/lib/purchasing/dashboard-focus";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import type { FinaleReorderMethod, PurchasingGroup } from "@/lib/finale/client";
import type { ExpectedDelivery, DraftVerification, CommitVerification } from "@/lib/purchasing/po-verification";
import { CrystalBallDetail, type CrystalBallItem } from "./CrystalBallDetail";
import { CrystalBallSearch } from "./CrystalBallSearch";

// ── types ──────────────────────────────────────────────────────────────────
type UrgencyTier = "critical" | "warning" | "watch" | "ok";
const TIER_ORDER: UrgencyTier[] = ["critical", "warning", "watch", "ok"];

type PurchasingItem = {
    productId: string; productName: string; supplierName: string; supplierPartyId: string;
    unitPrice: number; stockOnHand: number; stockOnOrder: number;
    purchaseVelocity: number; salesVelocity: number; demandVelocity: number; dailyRate: number;
    draftPO?: {
        orderId: string;
        orderDate: string;
        quantity: number;
        supplierName: string;
        finaleUrl: string;
    } | null;
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
    commitGuard?: {
        productId: string;
        decision: "commit" | "draft_only" | "block";
        targetCoverDays: number;
        minimumPostLeadCoverageDays: number;
        recommendedQty: number;
        dailyRate: number;
        leadTimeDays: number;
        projectedCoverageDays: number;
        projectedPostReceiptCoverageDays: number;
        blockReasons: string[];
        summary: string;
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
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    roundingAlternatives?: number[];
    itemType?: 'resale' | 'bom-component' | 'resale-bom';
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    totalBurnRate?: number;
    medianPOGapDays?: number;
    projectedNextOrderDate?: string;
    receiptConfidence?: 'high' | 'medium' | 'low';
    triggerReason?: 'build-driven' | 'stockout-padded' | 'runway-short' | 'cadence' | null;
    triggerDetail?: string;
    /** Most recent completed PO order date (YYYY-MM-DD). */
    lastPurchaseDate?: string | null;
    /** Qty from that PO line. */
    lastPurchaseQty?: number | null;
    /** True when vendor ships in bulk multi-leg deliveries. */
    isBulkVendor?: boolean;
};
type VendorCycle = {
    decision: "clear" | "reuse_draft" | "routine_locked" | "exception_allowed";
    cycleDays: number;
    lockedUntil: string | null;
    blockingPO: { orderId: string; status: string; orderDate: string } | null;
    exceptionEvidence?: Array<{ productId: string; reason: string; detail: string }>;
    summary: string;
};
type PurchasingDisplayGroup = PurchasingGroup & {
    vendorCycle?: VendorCycle;
};
type AssessmentData = {
    groups: PurchasingDisplayGroup[];
    cachedAt: string;
    vendorSummaries?: Array<{
        vendorName: string; vendorPartyId: string;
        actionableCount: number; blockedCount: number;
        highestConfidence: "high" | "medium" | "low" | null;
    }>;
    refreshing?: boolean;
    error?: string;
    upcomingBuilds?: Array<{ sku: string; earliestDate: string; componentCount: number }>;
};
type POResult = {
    orderId: string;
    finaleUrl: string;
    expectedDelivery?: ExpectedDelivery;
    verification?: DraftVerification;
};
type CommitReview = {
    sendId: string;
    review: {
        orderId: string; vendorName: string; vendorPartyId: string; total: number; orderDate: string;
        items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }>;
        finaleUrl: string;
    };
    email: string;
    emailSource: string;
    warning?: string;
};
type SendStepStatus = 'pending' | 'ok' | 'fail' | 'skip';
type SendSteps = { commit?: SendStepStatus; email?: SendStepStatus; verify?: SendStepStatus };
type SnoozeEntry = { until: number | "forever" };
type SnoozeMap = Record<string, SnoozeEntry>;
type UlineOrderResult = { success: boolean; itemsAdded: number; message: string; priceUpdatesApplied?: number; errors?: string[] };
// v2 (2026-05-06): planning windows replace today/week.
// localStorage migrates legacy values: today -> order_now, week -> 30.
type FocusFilter = OrderingFocusFilter;
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
    humanReplyDetectedAt?: string | null;
    trackingRequestedAt?: string | null;
    sentVerification?: { verified?: boolean; sentAt?: string | null; source?: string | null };
    isReceived?: boolean;
    recLinks?: RecLink[];
    vendorOrdersEmail?: string | null;
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
    // Full POResult per vendor (for verification + ETA display on the success pill).
    const [createdPODetails, setCreatedPODetails] = useState<Record<string, POResult>>({});
    // Per-modal step state for the Commit & Send flow.
    const [sendSteps, setSendSteps] = useState<SendSteps>({});
    const [commitIssues, setCommitIssues] = useState<string[]>([]);

    // commit & send modal
    const [commitModal, setCommitModal] = useState<CommitReview | null>(null);
    const [commitLoading, setCommitLoading] = useState<string | null>(null); // orderId being reviewed
    const [sendingPO, setSendingPO] = useState(false);
    const [sentPOs, setSentPOs] = useState<Set<string>>(new Set()); // orderId → sent
    const [canRetryEmail, setCanRetryEmail] = useState(false);

    // validation modal for PO quantity and case rounding guardrails
    const [validationModal, setValidationModal] = useState<any | null>(null);

    // snooze
    const [snooze, setSnooze] = useState<SnoozeMap>({});
    const [showSnoozed, setShowSnoozed] = useState(false);
    const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);
    const [qtyDropdownOpen, setQtyDropdownOpen] = useState<{ pid: string; productId: string } | null>(null);
    // Default to "all" so every item is visible, sorted most-needed-first.
    // Will: "We just want items in ordering to be staged from most needed to least always."
    const [focusFilter, setFocusFilter] = useState<FocusFilter>("all");
    const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("need");
    type ItemMode = 'all' | 'resale' | 'bom';
    // Both resale and BOM items visible together (no UI toggle — the BOM
    // treatment renders cleanly for BOM rows, resale rows show their own data).
    const [itemMode] = useState<ItemMode>('all');
    const [openPosDetail, setOpenPosDetail] = useState<Map<string, OpenPODetail>>(new Map());

    // ULINE direct ordering
    const [ulineOrdering, setUlineOrdering] = useState(false);
    const [ulineResult, setUlineResult] = useState<UlineOrderResult | null>(null);
    const [selectedItem, setSelectedItem] = useState<CrystalBallItem | null>(null);

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
        // v2 migration: legacy 'today' -> 'order_now', 'week' -> '30'.
        // Anything unrecognized falls through to the default (order_now).
        const savedFocus = localStorage.getItem(FOCUS_FILTER_LS);
        if (savedFocus === "today") setFocusFilter("order_now");
        else if (savedFocus === "week") setFocusFilter("30");
        else if (savedFocus === "order_now" || savedFocus === "30" || savedFocus === "60" || savedFocus === "90" || savedFocus === "all") {
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
                        humanReplyDetectedAt: p.humanReplyDetectedAt ?? null,
                        trackingRequestedAt: p.trackingRequestedAt ?? null,
                        sentVerification: p.sentVerification
                            ? { verified: p.sentVerification.verified, sentAt: p.sentVerification.sentAt, source: p.sentVerification.source }
                            : undefined,
                        isReceived: p.isReceived,
                        recLinks: Array.isArray(p.recLinks) ? p.recLinks : [],
                        vendorOrdersEmail: p.vendorOrdersEmail ?? null,
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
        return itemMatchesOrderingFocus(item, focusFilter);
    }
    function itemMatchesMode(item: PurchasingItem): boolean {
        if (itemMode === "all") return true;
        if (itemMode === "bom") return item.itemType === "bom-component";
        return item.itemType !== "bom-component";
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
    function fillTruckloadForVendor(vendorPartyId: string, multiplier: number) {
        // Scale every currently-CHECKED item's qty up by `multiplier`. Maintains
        // ratios across the vendor's selection. Snaps each result up to the
        // item's own commonOrderQty (from cognitive rounding) when present, so
        // the final qtys remain pallet/case-friendly.
        const group = data?.groups.find(g => g.vendorPartyId === vendorPartyId);
        if (!group) return;
        setQtys(prev => {
            const next = { ...prev };
            const vendorQtys = { ...(next[vendorPartyId] ?? {}) };
            for (const item of group.items) {
                const isOn = checked[vendorPartyId]?.[item.productId];
                if (!isOn || isSnoozed(item.productId)) continue;
                const current = vendorQtys[item.productId] ?? item.assessment?.recommendedQty ?? item.suggestedQty;
                const scaled = current * multiplier;
                const unit = item.roundingAlternatives && item.roundingAlternatives.length > 0
                    ? item.suggestedQty // already snapped — use as the unit
                    : null;
                vendorQtys[item.productId] = unit && unit > 0
                    ? Math.ceil(scaled / unit) * unit
                    : Math.ceil(scaled);
            }
            next[vendorPartyId] = vendorQtys;
            return next;
        });
        setSnoozeMenu(null);
    }

    function renderSnoozeMenu(k: string) {
        const snoozed = isSnoozed(k);
        const isVendor = k.startsWith('v:');
        const vendorPartyId = isVendor ? k.slice(2) : null;
        return (
            <div className="absolute right-0 top-full mt-0.5 z-50 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[170px]">
                {isVendor && vendorPartyId && (
                    <>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-zinc-600 uppercase tracking-wider border-b border-zinc-800 mb-0.5">
                            Fill truckload
                        </div>
                        <div className="flex gap-1 px-2 py-1">
                            {[2, 3, 4].map(n => (
                                <button key={n}
                                    onClick={() => fillTruckloadForVendor(vendorPartyId, n)}
                                    className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-cyan-300 hover:border-cyan-500/40 transition-colors"
                                    title={`Scale every checked item by ×${n}, snapped to typical order size`}
                                >
                                    ×{n}
                                </button>
                            ))}
                        </div>
                    </>
                )}
                {snoozed ? (
                    <button onClick={() => doUnsnooze(k)}
                        className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-emerald-400 hover:bg-zinc-800 border-t border-zinc-800">
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
    // Single fetch — all tiers, sorted by need server-side then again client-side.
    // SWR keeps this fast (warm cache returns in <100ms).
    async function load(bust = false) {
        setError(null);
        if (!data) setLoading(true);
        else if (bust) setScanning(true);

        setLoadingTiers(new Set(['critical', 'warning', 'watch', 'ok']));
        try {
            const res = await fetch(`/api/dashboard/purchasing?mode=all${bust ? '&bust=1' : ''}`);
            const json: AssessmentData = await res.json();
            if (!res.ok) throw new Error(json.error || `Failed to load ordering`);

            if (json.refreshing) setScanning(true);
            else setScanning(false);

            setData(json);
            setLoading(false);

            // Init checkboxes/qtys for new groups
            setChecked(prev => {
                const next: Record<string, Record<string, boolean>> = { ...prev };
                for (const g of json.groups) {
                    if (next[g.vendorPartyId]) continue;
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
                        next[g.vendorPartyId][item.productId] = item.assessment?.recommendedQty ?? item.suggestedQty;
                    }
                }
                return next;
            });
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoadingTiers(new Set());
        }
    }

    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    // Auto-poll while the server reports a background scan in flight. Stops
    // as soon as `refreshing` flips false (cache is warm).
    useEffect(() => {
        if (!data?.refreshing) return;
        const t = setTimeout(() => { load(); }, 15_000);
        return () => clearTimeout(t);
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [data?.refreshing, data?.cachedAt]);

    // Register BOM relationships for Option C highlighting
    useEffect(() => {
        if (!data?.groups) return;
        for (const g of data.groups) {
            for (const item of g.items) {
                if (item.itemType === 'bom-component' && item.feedsFinishedGoods && item.feedsFinishedGoods.length > 0) {
                    lifecycle.registerBOM(item.productId, item.feedsFinishedGoods.map(fg => fg.sku));
                }
            }
        }
    }, [data?.groups, lifecycle]);

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

    async function createVendorPO(group: PurchasingGroup, ignoreCommitGuards?: boolean): Promise<POResult | null> {
        const pid = group.vendorPartyId;
        const items = group.items
            .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId] && canIncludeInDraftPO(i.reorderMethod))
            .map(i => ({ productId: i.productId, quantity: qtys[pid]?.[i.productId] ?? i.suggestedQty, unitPrice: i.unitPrice, orderIncrementQty: i.orderIncrementQty ?? null, isBulkDelivery: i.isBulkDelivery ?? false }));
        if (items.length === 0) return null;
        const res = await fetch("/api/dashboard/purchasing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vendorPartyId: pid, items, memo: "Purchasing Intelligence draft — review and commit in Finale", ignoreCommitGuards }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        return json as POResult;
    }

    async function handleCreateOne(group: PurchasingGroup, ignoreCommitGuards?: boolean) {
        const pid = group.vendorPartyId;

        // Strict Guard: check for 30-day supply minimum and exact case multiple snaps
        if (!ignoreCommitGuards) {
            const violations: Array<{
                productId: string;
                productName: string;
                currentQty: number;
                min30dQty: number;
                increment: number | null;
                lastPurchaseQty: number | null;
            }> = [];

            group.items
                .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId] && canIncludeInDraftPO(i.reorderMethod))
                .forEach(i => {
                    const currentQty = qtys[pid]?.[i.productId] ?? i.suggestedQty;
                    const dailyRate = i.dailyRate ?? 0;
                    const min30dQty = dailyRate > 0 ? Math.ceil(dailyRate * 30) : 0;
                    const increment = i.orderIncrementQty ?? null;

                    const under30d = currentQty < min30dQty;
                    const notCaseMultiple = increment && increment > 1 && (currentQty % increment !== 0);

                    if (under30d || notCaseMultiple) {
                        violations.push({
                            productId: i.productId,
                            productName: i.productName,
                            currentQty,
                            min30dQty,
                            increment,
                            lastPurchaseQty: i.lastPurchaseQty ?? null,
                        });
                    }
                });

            if (violations.length > 0) {
                setValidationModal({ group, violations });
                return;
            }
        }

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
            const result = await createVendorPO(group, ignoreCommitGuards);
            if (result) {
                setCreatedPOs(p => ({ ...p, [pid]: result }));
                setCreatedPODetails(p => ({ ...p, [pid]: result }));
                // HERMIA(2026-05-28): Auto-advance to Review & Send modal.
                // Bill never needs to leave the dashboard or open Finale.
                // Draft created → review opens immediately → one click to commit.
                if (result.orderId) {
                    await load(true);
                    await handleReviewAndSend(result.orderId);
                    return;
                }
            }
            await load(true);
        } catch (e: any) {
            // HERMIA(2026-05-28): When server-side commit guard blocks the draft,
            // surface a confirmation dialog to force past the guard instead of
            // just showing a red error banner. The client-side check (30d simple)
            // can pass while the server's full check (lead_time + 30d coverage)
            // still rejects — in that case, user should be able to force-through.
            const isDraftBlocked = /Draft blocked/i.test(e.message || "");
            const isRoutineLocked = /routine|active PO/i.test(e.message || "");
            if ((isDraftBlocked || isRoutineLocked) && !ignoreCommitGuards) {
                const proceed = window.confirm(
                    `PO guard for ${group.vendorName}:\n\n${e.message}\n\n` +
                    `Aria's safety check recommends a larger quantity or more items.\n` +
                    `Force create a draft PO with your selected quantities?\n\n` +
                    `(OK = force create · Cancel = abort)`
                );
                if (proceed) {
                    handleCreateOne(group, true);
                    return;
                }
            }
            setError(`PO failed for ${group.vendorName}: ${e.message}`);
        } finally {
            setCreatingPO(p => { const n = new Set(p); n.delete(pid); return n; });
        }
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
            setCommitModal({ sendId: json.sendId, review: json.review, email: json.email, emailSource: json.emailSource, warning: json.warning });
            setSendSteps({});
            setCommitIssues([]);
        } catch (e: any) {
            setError(`Review failed: ${e.message}`);
        } finally {
            setCommitLoading(null);
        }
    }

    async function handleConfirmSend(skipEmail: boolean = false) {
        if (!commitModal?.sendId) return;
        setSendingPO(true);
        setSendSteps({ commit: 'pending', email: skipEmail ? 'skip' : 'pending', verify: 'pending' });
        setCommitIssues([]);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', sendId: commitModal.sendId, skipEmail }),
            });
            const json = await res.json();
            if (!res.ok) {
                setSendSteps({ commit: 'fail', email: 'fail', verify: 'fail' });
                setError(json.error || 'Send failed');
                return;
            }

            // Read verification block to drive step indicators.
            const v: CommitVerification | undefined = json.verification ?? json.details?.verification;
            const committed = v?.committed ?? (json.status !== 'failed');
            const emailSent = v?.emailSent ?? json.details?.finaleEmailSent ?? false;
            const emailVerified = v?.emailVerified ?? emailSent;
            setSendSteps({
                commit: committed ? 'ok' : 'fail',
                email: skipEmail ? 'skip' : (emailSent ? 'ok' : 'fail'),
                verify: skipEmail ? (committed ? 'ok' : 'fail') : (emailVerified ? 'ok' : 'fail'),
            });
            const issues: string[] = Array.isArray(v?.issues) ? [...v!.issues] : [];
            const sendEmailError: string | undefined = json.details?.emailError;
            if (sendEmailError && !issues.some(i => i.toLowerCase().includes('email send failed'))) {
                issues.push(`email send failed: ${sendEmailError}`);
            }
            if (sendEmailError && commitModal.email) {
                issues.push(`attempted recipient: ${commitModal.email}`);
            }
            if (issues.length > 0) setCommitIssues(issues);

            if (json.status === 'failed') {
                setError(json.userMessage || json.error || 'Send failed');
                return;
            }
            const details = json.details ?? {};
            if (details.finaleEmailSent || emailSent) {
                setSentPOs(p => new Set(p).add(commitModal.review.orderId));
            }
            setCreatedPOs(prev => {
                const next = { ...prev };
                delete next[commitModal.review.vendorPartyId];
                return next;
            });
            setCreatedPODetails(prev => {
                const next = { ...prev };
                delete next[commitModal.review.vendorPartyId];
                return next;
            });
            setData(prev => prev
                ? { ...prev, groups: prev.groups.filter(g => g.vendorPartyId !== commitModal.review.vendorPartyId) }
                : prev);

            // Auto-close only on a fully-clean result; otherwise leave modal open so
            // Will can see which step failed.
            const allClean = committed && (skipEmail || (emailSent && emailVerified)) && !(v?.issues?.length);
            if (allClean) setCommitModal(null);

            if (json.status === 'partial_success') {
                setError(json.userMessage || 'PO committed in Finale, but the vendor email still needs review.');
                setCanRetryEmail(Boolean(json.details?.retryable));
            } else {
                setCanRetryEmail(false);
            }
            await load(true);
        } catch (e: any) {
            setSendSteps({ commit: 'fail', email: 'fail', verify: 'fail' });
            setError(`Send failed: ${e.message}`);
        } finally {
            setSendingPO(false);
        }
    }

    function dismissCommitModal() {
        setCommitModal(null);
        setSendSteps({});
        setCommitIssues([]);
        setCanRetryEmail(false);
    }

    async function handleRetryEmail() {
        if (!commitModal?.sendId) return;
        setSendingPO(true);
        setSendSteps(s => ({ ...s, email: 'pending', verify: 'pending' }));
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'retry-email', sendId: commitModal.sendId }),
            });
            const json = await res.json();
            if (!res.ok || json.status === 'failed') {
                setSendSteps(s => ({ ...s, email: 'fail', verify: 'fail' }));
                setError(json.userMessage || json.error || 'Retry failed');
                return;
            }
            const ok = json.status === 'success';
            setSendSteps(s => ({ ...s, email: ok ? 'ok' : 'fail', verify: ok ? 'ok' : 'fail' }));
            if (ok) {
                setCanRetryEmail(false);
                setSentPOs(p => new Set(p).add(commitModal.review.orderId));
                setCommitIssues([]);
                setError(null);
                await load(true);
                setCommitModal(null);
            } else {
                setError(json.userMessage || 'Retry still failing — vendor email may be wrong or both delivery paths are down');
            }
        } catch (e: any) {
            setError(`Retry failed: ${e.message}`);
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
        dismissCommitModal();
    }

    async function handleCancelDraft(orderId: string) {
        if (!confirm(`Cancel draft PO #${orderId}?\n\nThis will delete it from Finale. Cannot be undone.`)) {
            return;
        }

        setCommitLoading(orderId);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'cancel-draft', orderId, sendId: commitModal?.sendId || null }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to cancel draft');
            }
            // Remove from local state
            setCreatedPOs(prev => {
                const next = { ...prev };
                for (const [pid, po] of Object.entries(next)) {
                    if (po.orderId === orderId) delete next[pid];
                }
                return next;
            });
            // Close the commit modal if it was open for this PO
            if (commitModal?.review?.orderId === orderId) {
                dismissCommitModal();
            }
            await load();
        } catch (err: any) {
            setVendorError(err.message);
        } finally {
            setCommitLoading(null);
        }
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
    const allGroups = (data?.groups ?? [])
        .map(group => ({
            ...group,
            items: group.items.filter(itemMatchesMode),
        }))
        .filter(group => group.items.length > 0);

    /**
     * v2 vendor sort. Score each group by *real* purchase need: earliest
     * effective shortage among actionable items, then severity, then count,
     * then total open need (refinement: tiebreaker that works even when
     * nothing is checked yet — sums suggestedQty × unitPrice across actionable
     * items, not just selected ones), then dollar value of selections, then
     * alphabetical.
     */
    function vendorNeedScore(group: PurchasingGroup): {
        earliestShortage: number;
        urgencyRank: number;
        actionableCount: number;
        openNeedDollars: number;
        selectedDollars: number;
    } {
        const actionable = group.items.filter(item =>
            item.assessment?.decision === "order" || item.assessment?.decision === "reduce",
        );
        const candidates = actionable.length > 0 ? actionable : group.items;
        const earliestShortage = candidates.length > 0
            ? Math.min(...candidates.map(getEffectiveShortageDays))
            : Number.POSITIVE_INFINITY;
        const urgencyRank = candidates.length > 0
            ? Math.min(...candidates.map(item => URGENCY_RANK[item.urgency]))
            : URGENCY_RANK.ok;
        const openNeedDollars = actionable.reduce(
            (sum, item) => sum + (item.suggestedQty || 0) * (item.unitPrice || 0),
            0,
        );
        const selectedDollars = actionable.reduce((sum, item) => {
            const isChecked = !isSnoozed(item.productId) && checked[group.vendorPartyId]?.[item.productId];
            return isChecked ? sum + (item.suggestedQty || 0) * (item.unitPrice || 0) : sum;
        }, 0);
        return {
            earliestShortage,
            urgencyRank,
            actionableCount: actionable.length,
            openNeedDollars,
            selectedDollars,
        };
    }
    const sortedGroups = [...allGroups].sort((a, b) => {
        const left = vendorNeedScore(a);
        const right = vendorNeedScore(b);
        return (
            left.earliestShortage - right.earliestShortage
            || left.urgencyRank - right.urgencyRank
            || right.actionableCount - left.actionableCount
            || right.openNeedDollars - left.openNeedDollars
            || right.selectedDollars - left.selectedDollars
            || a.vendorName.localeCompare(b.vendorName)
        );
    });
    const activeGroups = sortedGroups.filter(g => !vendorSnoozed(g));
    const displayGroups = showSnoozed ? sortedGroups : activeGroups;
    const focusGroups = displayGroups
        .map(group => {
            const hasDraftPO = !!createdPOs[group.vendorPartyId];
            return {
                ...group,
                items: hasDraftPO
                    ? []
                    : sortItemsByNeed(group.items.filter(item => itemMatchesFocus(item) && itemMatchesLifecycle(item))),
            };
        })
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

    // v2 cumulative window counts — every pill counts items, not vendors.
    // Lifecycle filter is applied so the count matches the visible-rows count.
    const focusCount = (filter: FocusFilter) =>
        activeGroups
            .flatMap(g => g.items)
            .filter(item => itemMatchesOrderingFocus(item, filter) && itemMatchesLifecycle(item))
            .length;
    const orderNowCount = focusCount("order_now");
    const thirtyCount = focusCount("30");
    const sixtyCount = focusCount("60");
    const ninetyCount = focusCount("90");
    const allCount = focusCount("all");
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

    const handleVendorSearchSelect = useCallback((vendor: { vendorPartyId: string; vendorName: string }) => {
        setSelectedItem(null);
        setFocusFilter("all");
        setLifecycleFilter("all");
        setVendorTab(vendor.vendorPartyId);
        setExpanded(prev => {
            const next = new Set(prev);
            next.add(vendor.vendorPartyId);
            return next;
        });
    }, []);

    // ── render ─────────────────────────────────────────────────────────────
    return (
        <div className="border-b border-zinc-800 shrink-0">
            {/* PO Quantity & Case Rounding Validation Loop Modal */}
            {validationModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md">
                    <div className="bg-zinc-950 border border-red-500/30 rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
                        <div className="px-5 py-4 border-b border-zinc-800 bg-red-500/5 flex items-center gap-3">
                            <span className="text-xl">🛡️</span>
                            <div>
                                <h3 className="text-sm font-semibold font-mono text-zinc-100">PO Quantity Guardrail Alert</h3>
                                <p className="text-[10px] text-zinc-400 font-mono">Ensuring a minimum 30-day supply & exacting case pack multiples</p>
                            </div>
                            <div className="flex-1" />
                            <span className="text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
                                {validationModal.group.vendorName}
                            </span>
                        </div>
                        
                        <div className="p-5 max-h-[380px] overflow-y-auto space-y-4">
                            <p className="text-xs text-zinc-300">
                                The following items in this order do not meet the safe inventory guardrails. Review the history and auto-round to ensure you do not order too frequently.
                            </p>

                            <div className="space-y-2.5">
                                {validationModal.violations.map(v => {
                                    const incrementLabel = v.increment && v.increment > 1 ? `${v.increment} units/case` : 'No case limit';
                                    const under30d = v.currentQty < v.min30dQty;
                                    const notMultiple = v.increment && v.increment > 1 && (v.currentQty % v.increment !== 0);

                                    return (
                                        <div key={v.productId} className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80 font-mono text-xs">
                                            <div className="flex justify-between items-start gap-4 mb-2">
                                                <div>
                                                    <span className="text-zinc-200 font-semibold">{v.productId}</span>
                                                    <span className="text-[10px] text-zinc-500 block truncate max-w-[400px]">{v.productName}</span>
                                                </div>
                                                <div className="flex flex-col items-end gap-1">
                                                    {under30d && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-red-500/20 text-red-400 border border-red-500/30">
                                                            Under 30d Supply
                                                        </span>
                                                    )}
                                                    {notMultiple && (
                                                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                                            Not Case Multiple
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] text-zinc-400 bg-zinc-950 p-2 rounded border border-zinc-900">
                                                <div>
                                                    <span className="text-zinc-500 block">Current Qty</span>
                                                    <span className="text-zinc-300 font-semibold">{v.currentQty.toLocaleString()} units</span>
                                                </div>
                                                <div>
                                                    <span className="text-zinc-500 block">30d Supply Floor</span>
                                                    <span className="text-zinc-300 font-semibold">{v.min30dQty.toLocaleString()} units</span>
                                                </div>
                                                <div>
                                                    <span className="text-zinc-500 block">Case Standard</span>
                                                    <span className="text-zinc-300 font-semibold">{incrementLabel}</span>
                                                </div>
                                                <div>
                                                    <span className="text-zinc-500 block">Last Ordered Qty</span>
                                                    <span className="text-zinc-300 font-semibold">
                                                        {v.lastPurchaseQty ? `${v.lastPurchaseQty.toLocaleString()} units` : 'No PO history'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-950 flex flex-wrap gap-2 justify-end">
                            <button
                                onClick={() => setValidationModal(null)}
                                className="px-3 py-1.5 text-xs font-mono font-medium rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-transparent transition-colors"
                            >
                                Back to Queue
                            </button>
                            <button
                                onClick={async () => {
                                    const pid = validationModal.group.vendorPartyId;
                                    setQtys(prev => {
                                        const next = { ...prev };
                                        if (!next[pid]) next[pid] = {};
                                        validationModal.violations.forEach(v => {
                                            const increment = v.increment ?? 1;
                                            const targetQty = Math.ceil(v.min30dQty / increment) * increment;
                                            next[pid][v.productId] = Math.max(increment, targetQty);
                                        });
                                        return next;
                                    });
                                    setValidationModal(null);
                                    // Let state updates batch then execute creation using the rounded values
                                    setTimeout(() => {
                                        // Re-evaluate group quantities with corrected values
                                        const correctedGroup = {
                                            ...validationModal.group,
                                        };
                                        handleCreateOne(correctedGroup, true);
                                    }, 100);
                                }}
                                className="px-3.5 py-1.5 text-xs font-mono font-semibold rounded text-zinc-950 bg-emerald-400 hover:bg-emerald-300 transition-colors shadow-lg shadow-emerald-950/20"
                            >
                                ⚡ Auto-Round Up & Create Draft
                            </button>
                            <button
                                onClick={() => {
                                    const group = validationModal.group;
                                    setValidationModal(null);
                                    handleCreateOne(group, true);
                                }}
                                className="px-3.5 py-1.5 text-xs font-mono font-medium rounded text-red-300 hover:text-red-200 border border-red-500/20 hover:border-red-500/40 hover:bg-red-500/5 transition-colors"
                            >
                                Force Draft Only
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Commit & Send modal */}
            {commitModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
                        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                            <span className="text-sm font-mono font-semibold text-zinc-200">Commit & Send PO #{commitModal.review.orderId}</span>
                            <div className="flex-1" />
                            <span className="text-[10px] font-mono text-zinc-600">{commitModal.review.vendorName}</span>
                        </div>
                        {commitModal.warning && (
                            <div className="px-4 py-2 text-[11px] font-mono text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
                                ⚠ {commitModal.warning}
                            </div>
                        )}
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
                            {canRetryEmail ? (
                                <button onClick={handleCancelCommit}
                                    className="text-[11px] font-mono px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                                    Close
                                </button>
                            ) : Object.keys(sendSteps).length > 0 ? (
                                <button onClick={handleCancelCommit}
                                    className="text-[11px] font-mono px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                                    Close
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={() => handleCancelDraft(commitModal.review.orderId)}
                                        disabled={sendingPO}
                                        className="text-[11px] font-mono px-3 py-1.5 rounded bg-rose-900/40 hover:bg-rose-900/60 text-rose-300 border border-rose-700/50 transition-colors disabled:opacity-40 mr-auto"
                                        title="Cancel this PO in Finale — removes the draft entirely"
                                    >
                                        🗑 Cancel Draft
                                    </button>
                                    <button onClick={handleCancelCommit}
                                        className="text-[11px] font-mono px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                                        Keep Draft
                                    </button>
                                </>
                            )}
                            {canRetryEmail ? (
                                <button
                                    onClick={handleRetryEmail}
                                    disabled={sendingPO}
                                    className="text-[11px] font-mono px-4 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white border border-amber-600 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                                    title="The PO is already committed in Finale; this retries just the vendor email step"
                                >
                                    {sendingPO && <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />}
                                    {sendingPO ? 'Retrying…' : '↻ Retry Email'}
                                </button>
                            ) : (
                                <>
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
                                </>
                            )}
                        </div>
                        {/* Step status — appears once a send is in flight */}
                        {Object.keys(sendSteps).length > 0 && (
                            <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-950/60 text-[11px] font-mono space-y-1">
                                {([
                                    { k: 'commit' as const, label: '1. Commit in Finale' },
                                    { k: 'email' as const,  label: '2. Email vendor' },
                                    { k: 'verify' as const, label: '3. Verify Finale state' },
                                ]).map(s => {
                                    const v = sendSteps[s.k];
                                    const icon = v === 'ok' ? <span className="text-emerald-400">✓</span>
                                        : v === 'fail' ? <span className="text-rose-400">✗</span>
                                        : v === 'skip' ? <span className="text-zinc-600">—</span>
                                        : v === 'pending' ? <span className="text-amber-300 animate-pulse">⏳</span>
                                        : <span className="text-zinc-700">·</span>;
                                    return (
                                        <div key={s.k} className="flex items-center gap-2">
                                            <span className="w-5 text-center">{icon}</span>
                                            <span className={v === 'fail' ? 'text-rose-300' : v === 'ok' ? 'text-zinc-300' : 'text-zinc-500'}>{s.label}</span>
                                        </div>
                                    );
                                })}
                                {commitIssues.length > 0 && (
                                    <div className="mt-2 p-2 rounded border border-rose-500/40 bg-rose-500/5 text-[10px] text-rose-300 space-y-0.5">
                                        {commitIssues.map((iss, i) => <div key={i}>· {iss}</div>)}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Backdrop — closes any open snooze dropdown */}
            {snoozeMenu && (
                <div className="fixed inset-0 z-40" onClick={() => setSnoozeMenu(null)} />
            )}

            {/* Backdrop — closes any open qty override dropdown */}
            {qtyDropdownOpen && (
                <div className="fixed inset-0 z-40" onClick={() => setQtyDropdownOpen(null)} />
            )}

            {/* ── Header ── */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Ordering</span>
                <CrystalBallSearch onSelect={setSelectedItem} onVendorSelect={handleVendorSearchSelect} />
                {data && !scanning && <span className="text-[10px] text-[var(--dash-ts)] ml-auto mr-0 font-mono">{timeAgo(data.cachedAt)}</span>}
                {/* Compact indicator (header) — only when warm cache exists; cold-load shows the centered card below */}
                {isLoading && data && (
                    <span className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {scanning ? "Refreshing…" : loadingTiers.size > 0
                            ? `Loading ${Array.from(loadingTiers).join(", ")}…`
                            : "Scanning…"}
                    </span>
                )}
                <div className="flex-1" />

                {/* v2 ordering filter — Order Now / 30 / 60 / 90 / All. Cumulative. Item-counted. */}
                {([
                    { k: "order_now" as const, label: "ORDER NOW", count: orderNowCount, active: "bg-red-500/20 text-red-300 border-red-500/40", title: "Items short within lead time (or already short with no PO coverage)" },
                    { k: "30" as const, label: "30", count: thirtyCount, active: "bg-amber-500/20 text-amber-300 border-amber-500/40", title: "Show items projected short within 30 days" },
                    { k: "60" as const, label: "60", count: sixtyCount, active: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40", title: "Show items projected short within 60 days" },
                    { k: "90" as const, label: "90", count: ninetyCount, active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", title: "Show items projected short within 90 days" },
                    { k: "all" as const, label: "ALL", count: allCount, active: "bg-zinc-700 text-zinc-200 border-zinc-600", title: "Every actionable item" },
                ]).map(b => (
                    <button
                        key={b.k}
                        onClick={() => setFocusFilter(b.k)}
                        title={b.title}
                        className={`text-xs font-mono ${b.k === "order_now" ? "font-bold" : ""} px-1.5 py-0.5 rounded border transition-colors ${focusFilter === b.k
                            ? b.active
                            : "text-zinc-500 border-zinc-700 hover:text-zinc-300"
                            }`}
                    >
                        {b.count} {b.label}
                    </button>
                ))}

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

                {/* DECISION(2026-05-19, Will): bulk "Create all POs" button removed.
                    Per-vendor "Draft PO" buttons stay — bulk creation hid which
                    vendor was about to fire and made it too easy to accidentally
                    queue every vendor at once. */}
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
                    {selectedItem ? (
                        <>
                            <div
                                className="overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full font-mono"
                                style={{ height: bodyHeight }}
                            >
                                <CrystalBallDetail 
                                    item={selectedItem} 
                                    onClose={() => setSelectedItem(null)} 
                                    onCommitPO={handleReviewAndSend}
                                />
                            </div>

                            <div onMouseDown={startResize}
                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                title="Drag to resize" />
                        </>
                    ) : (
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
                                {({
                                    order_now: "Order Now",
                                    "30": "Next 30 Days",
                                    "60": "Next 60 Days",
                                    "90": "Next 90 Days",
                                    all: "All",
                                } as Record<FocusFilter, string>)[focusFilter]} <span className="opacity-60">{focusGroups.length}</span>
                            </button>

                            {focusGroups.map(g => {
                                const cfg = URGENCY[g.urgency];
                                const isActive = vendorTab === g.vendorPartyId;
                                const hasPO = !!createdPOs[g.vendorPartyId];
                                const vSnoozed = !hasPO && vendorSnoozed(g);
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
                        <div className="px-4 py-10 flex items-center justify-center">
                            <div className="flex flex-col items-center gap-3 px-6 py-6 rounded-lg border border-emerald-500/30 bg-emerald-500/5 shadow-lg max-w-md w-full">
                                <div className="relative">
                                    <Loader2 className="w-9 h-9 text-emerald-400 animate-spin" />
                                    <Package className="w-4 h-4 text-emerald-300 absolute inset-0 m-auto" />
                                </div>
                                <div className="text-sm font-mono font-semibold text-emerald-200 tracking-wide">
                                    {scanning ? "Refreshing…" : "Refreshing…"}
                                </div>
                                <div className="text-[11px] font-mono text-zinc-400 text-center min-h-[14px]">
                                    {loadingTiers.size > 0
                                        ? `Loading ${Array.from(loadingTiers).join(", ")} items…`
                                        : "Cold-path scans take 3–6 minutes. Hang tight."}
                                </div>
                                {/* Subtle skeleton hint underneath */}
                                <div className="w-full space-y-1.5 pt-2">
                                    {[1, 2, 3].map(i => (
                                        <div key={i} className="flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full skeleton-shimmer shrink-0" />
                                            <div className="skeleton-shimmer h-2.5 rounded" style={{ width: `${45 + i * 14}%` }} />
                                        </div>
                                    ))}
                                </div>
                            </div>
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
                                    const isCreatingThis = creatingPO.has(pid);
                                    const po = createdPOs[pid];
                                    const vSnoozed = !po && vendorSnoozed(group);
                                    const isExpanded = !vSnoozed && (expanded.has(pid) || vendorTab === pid);
                                    const groupChecked = checked[pid] ?? {};
                                    const groupQtys = qtys[pid] ?? {};
                                    const activeItems = group.items.filter(i => !isSnoozed(i.productId));
                                    const hasActionable = activeItems.some(i =>
                                        i.assessment?.decision === "order" || i.assessment?.decision === "reduce",
                                    );
                                    const selectedItems = activeItems.filter(i => groupChecked[i.productId]);
                                    const directOrderBlocked = selectedItems.some(i => !canUseDirectOrdering(group.vendorName, i.reorderMethod));
                                    const selectedCount = activeItems.filter(i => groupChecked[i.productId]).length;
                                    const selectedUnits = selectedItems.reduce((sum, item) => sum + (groupQtys[item.productId] ?? item.suggestedQty), 0);
                                    const selectedValue = selectedItems.reduce((sum, item) => {
                                        const qty = groupQtys[item.productId] ?? item.suggestedQty;
                                        return sum + qty * Math.max(0, item.unitPrice);
                                    }, 0);
                                    const actionableForShortage = activeItems.filter(i =>
                                        i.assessment?.decision === "order" || i.assessment?.decision === "reduce",
                                    );
                                    const shortageCandidates = actionableForShortage.length > 0 ? actionableForShortage : activeItems;
                                    const earliestRunway = shortageCandidates.length > 0
                                        ? Math.min(...shortageCandidates.map(getEffectiveShortageDays))
                                        : null;
                                    const diffCount = activeItems.filter(item => item.qtyDiverged).length;
                                    const allCheckedFlag = activeItems.length > 0 && activeItems.every(i => groupChecked[i.productId]);
                                    const groupProductIds = activeItems.map(item => item.productId);
                                    const groupMatch = lifecycle.checkMatchDetails({
                                        vendorName: group.vendorName,
                                        productIds: groupProductIds,
                                    });
                                    const groupBg = groupMatch.isLockedDirect
                                        ? "bg-amber-500/10 ring-2 ring-inset ring-amber-500/50"
                                        : groupMatch.isLockedBom
                                        ? "bg-amber-500/5 ring-1 ring-dashed ring-amber-500/30"
                                        : groupMatch.isDirect
                                        ? "bg-cyan-500/8 ring-1 ring-inset ring-cyan-500/35"
                                        : groupMatch.isBom
                                        ? "bg-cyan-500/4 ring-1 ring-dashed ring-cyan-500/25"
                                        : "";
                                    const vendorCycle = group.vendorCycle;
                                    const vendorCycleBadge = vendorCycle && vendorCycle.decision !== "clear"
                                        ? {
                                            text: vendorCycle.decision === "routine_locked"
                                                ? `cycle locked${vendorCycle.blockingPO?.orderId ? ` - PO ${vendorCycle.blockingPO.orderId}` : ""}`
                                                : vendorCycle.decision === "exception_allowed"
                                                ? `exception allowed${vendorCycle.exceptionEvidence?.[0]?.reason ? ` - ${vendorCycle.exceptionEvidence[0].reason.replace(/_/g, " ")}` : ""}`
                                                : `reuse draft${vendorCycle.blockingPO?.orderId ? ` - PO ${vendorCycle.blockingPO.orderId}` : ""}`,
                                            className: vendorCycle.decision === "routine_locked"
                                                ? "text-amber-200 border-amber-500/40 bg-amber-500/10"
                                                : vendorCycle.decision === "exception_allowed"
                                                ? "text-cyan-200 border-cyan-500/40 bg-cyan-500/10"
                                                : "text-emerald-200 border-emerald-500/40 bg-emerald-500/10",
                                        }
                                        : null;

                                    return (
                                        <div
                                            key={pid}
                                            onClick={(e) => {
                                                const target = e.target as HTMLElement;
                                                if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) return;
                                                lifecycle.setLockedFocus({ source: "ordering", vendorName: group.vendorName, productIds: groupProductIds });
                                            }}
                                            onMouseEnter={() => lifecycle.setFocus({ source: "ordering", vendorName: group.vendorName, productIds: groupProductIds })}
                                            onMouseLeave={lifecycle.clearFocus}
                                            className={`border-b border-zinc-800/60 cursor-pointer ${vSnoozed ? "opacity-25 hover:opacity-45 transition-opacity" : ""} ${groupBg}`}
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
                                                    {!vSnoozed && earliestRunway != null && Number.isFinite(earliestRunway) && (() => {
                                                        // Show the lead time of the most-urgent item so the shortage number is
                                                        // self-explanatory: "shortage 21d · lead 25d" = we're already late.
                                                        const critItem = activeItems.find(i => i.urgency === 'critical');
                                                        const shortageLeadTime = critItem?.leadTimeDays ?? null;
                                                        return (
                                                            <span
                                                                className={`text-xs font-mono shrink-0 ${runwayColor(earliestRunway)}`}
                                                                title={shortageLeadTime != null
                                                                    ? `Runway ${Math.round(earliestRunway)}d < lead time ${shortageLeadTime}d → order window already closed. Stock will hit zero before the next delivery arrives.`
                                                                    : "Earliest effective shortage among actionable items"}
                                                            >
                                                                shortage {Math.round(earliestRunway)}d
                                                                {shortageLeadTime != null && (
                                                                    <span className="text-zinc-500 font-normal"> · lead {shortageLeadTime}d</span>
                                                                )}
                                                            </span>
                                                        );
                                                    })()}
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
                                                    {!vSnoozed && vendorCycleBadge && (
                                                        <span
                                                            className={`text-[10px] font-mono border rounded px-1 py-0.5 shrink-0 ${vendorCycleBadge.className}`}
                                                            title={vendorCycle?.summary}
                                                        >
                                                            {vendorCycleBadge.text}
                                                        </span>
                                                    )}
                                                    {/* Affected FGs across this vendor's BOM items (collapsed view) */}
                                                    {!vSnoozed && (() => {
                                                        const fgs = new Map<string, string>();
                                                        for (const it of activeItems) {
                                                            for (const fg of it.feedsFinishedGoods ?? []) {
                                                                if (!fgs.has(fg.sku)) fgs.set(fg.sku, fg.name);
                                                            }
                                                        }
                                                        if (fgs.size === 0) return null;
                                                        const list = Array.from(fgs.entries());
                                                        const shown = list.slice(0, 3);
                                                        return (
                                                            <span
                                                                className="text-[10px] font-mono text-purple-300/80 truncate max-w-[420px] shrink"
                                                                title={list.map(([sku, name]) => `${sku} · ${name}`).join('\n')}
                                                            >
                                                                affects {shown.map(([sku]) => sku).join(', ')}
                                                                {list.length > shown.length && ` · +${list.length - shown.length}`}
                                                            </span>
                                                        );
                                                    })()}
                                                </button>

                                                {!vSnoozed && cfg.label && (() => {
                                                    // DECISION(2026-05-27): CRIT badge gets an explanatory tooltip so humans
                                                    // understand why CRIT ≠ just "it's bad" — it means the order window is closed.
                                                    // The tooltip exposes the runway < lead time math that defines critical.
                                                    const critItems = group.urgency === 'critical'
                                                        ? activeItems.filter(i => i.urgency === 'critical')
                                                        : [];
                                                    const critTooltip = critItems.length > 0
                                                        ? `CRITICAL: stock runway (${Math.round(Math.min(...critItems.map(i => i.adjustedRunwayDays)))}d) is less than vendor lead time (${Math.round(Math.min(...critItems.map(i => i.leadTimeDays)))}d). The order window has closed — you will stock out before the next delivery arrives. Order immediately.`
                                                        : cfg.label;
                                                    return (
                                                        <span
                                                            className={`text-[10px] font-mono shrink-0 ${group.urgency === "critical"
                                                                ? (po ? `px-1 py-0.5 rounded border ${cfg.badgeOutline}` : `px-1 py-0.5 rounded border ${cfg.badge}`)
                                                                : cfg.badge
                                                            }`}
                                                            title={critTooltip}
                                                        >
                                                            {cfg.label}
                                                        </span>
                                                    );
                                                })()}
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
                                                                {(() => {
                                                                    const det = createdPODetails[pid];
                                                                    if (!det?.verification) return null;
                                                                    if (det.verification.verified) {
                                                                        return (
                                                                            <span
                                                                                className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shrink-0"
                                                                                title={det.expectedDelivery?.label ?? 'verified'}
                                                                            >
                                                                                ✓ Verified{det.expectedDelivery?.date ? ` · ETA ${det.expectedDelivery.date.slice(5)}` : ''}
                                                                            </span>
                                                                        );
                                                                    }
                                                                    return (
                                                                        <span
                                                                            className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-rose-500/15 text-rose-300 border-rose-500/40 shrink-0"
                                                                            title={det.verification.mismatches.join('; ')}
                                                                        >
                                                                            ⚠ Verify failed
                                                                        </span>
                                                                    );
                                                                })()}
                                                                {sentPOs.has(po.orderId) ? (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                ) : (
                                                                    <>
                                                                        <button
                                                                            onClick={() => handleReviewAndSend(po.orderId)}
                                                                            disabled={commitLoading === po.orderId}
                                                                            className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-600 transition-colors disabled:opacity-40"
                                                                            title="Commit in Finale and email vendor"
                                                                        >
                                                                            {commitLoading === po.orderId ? '…' : 'Commit & Send'}
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleCancelDraft(po.orderId)}
                                                                            disabled={commitLoading === po.orderId}
                                                                            className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-rose-900/40 hover:bg-rose-900/60 text-rose-300 border-rose-700/50 transition-colors disabled:opacity-40"
                                                                            title="Cancel this draft PO in Finale"
                                                                        >
                                                                            ✕
                                                                        </button>
                                                                    </>
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
                                                                    <>
                                                                        <button
                                                                            onClick={() => handleReviewAndSend(po.orderId)}
                                                                            disabled={commitLoading === po.orderId}
                                                                            className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors disabled:opacity-40"
                                                                        >
                                                                            {commitLoading === po.orderId ? 'Loading…' : 'Commit & Send'}
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleCancelDraft(po.orderId)}
                                                                            disabled={commitLoading === po.orderId}
                                                                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-900/40 hover:bg-rose-900/60 text-rose-300 border border-rose-700/50 transition-colors disabled:opacity-40"
                                                                            title="Cancel this draft PO in Finale"
                                                                        >
                                                                            ✕
                                                                        </button>
                                                                    </>
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
                                                            const draftBlocked = !canIncludeInDraftPO(item.reorderMethod) || !!item.draftPO;
                                                            const isChecked = !itemSnoozed && !draftBlocked && (groupChecked[item.productId] ?? false);
                                                            const qty = groupQtys[item.productId] ?? item.suggestedQty;
                                                            const rc = runwayColor(item.runwayDays);
                                                            const isBundle = !itemSnoozed && item.urgency === "watch" && hasActionable;
                                                            const iKey = item.productId;
                                                            const methodBadge = reorderMethodBadge(item.reorderMethod);
                                                            const openOrderId = item.openPOs[0]?.orderId;
                                                            const itemMatch = lifecycle.checkMatchDetails({
                                                                vendorName: group.vendorName,
                                                                orderId: openOrderId,
                                                                productIds: [item.productId],
                                                            });
                                                            const itemBg = itemMatch.isLockedDirect
                                                                ? "bg-amber-500/10 ring-2 ring-inset ring-amber-500/50"
                                                                : itemMatch.isLockedBom
                                                                ? "bg-amber-500/5 ring-1 ring-dashed ring-amber-500/30"
                                                                : itemMatch.isDirect
                                                                ? "bg-cyan-500/8 ring-1 ring-inset ring-cyan-500/35"
                                                                : itemMatch.isBom
                                                                ? "bg-cyan-500/4 ring-1 ring-dashed ring-cyan-500/25"
                                                                : "";

                                                            return (
                                                                <div key={iKey}
                                                                    onClick={(e) => {
                                                                        const target = e.target as HTMLElement;
                                                                        if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) return;
                                                                        lifecycle.setLockedFocus({ source: "ordering", vendorName: group.vendorName, orderId: openOrderId, productIds: [item.productId] });
                                                                    }}
                                                                    onMouseEnter={() => lifecycle.setFocus({ source: "ordering", vendorName: group.vendorName, orderId: openOrderId, productIds: [item.productId] })}
                                                                    onMouseLeave={lifecycle.clearFocus}
                                                                    className={`px-4 py-3.5 border-b border-zinc-800/40 last:border-0 cursor-pointer ${itemBg} ${itemSnoozed ? "opacity-20 hover:opacity-40 transition-opacity" : isChecked ? "" : "opacity-90"
                                                                        }`}>
                                                                    <div className="flex items-start gap-3">
                                                                        {!itemSnoozed && (
                                                                            <input type="checkbox" checked={isChecked}
                                                                                onChange={() => toggleItem(pid, iKey)}
                                                                                disabled={draftBlocked}
                                                                                title={item.draftPO ? `Draft PO #${item.draftPO.orderId} already exists` : undefined}
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
                                                                                {!itemSnoozed && item.commitGuard && (
                                                                                    <span
                                                                                        className={`text-[10px] font-mono border rounded px-1 shrink-0 ${
                                                                                            item.commitGuard.decision === "commit"
                                                                                                ? "text-emerald-300 border-emerald-500/35 bg-emerald-500/10"
                                                                                                : item.commitGuard.decision === "draft_only"
                                                                                                    ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
                                                                                                    : "text-red-300 border-red-500/40 bg-red-500/10"
                                                                                        }`}
                                                                                        title={`${item.commitGuard.summary} Target: ${item.commitGuard.targetCoverDays}d total (${item.commitGuard.leadTimeDays}d lead + ${item.commitGuard.minimumPostLeadCoverageDays}d supply).`}
                                                                                    >
                                                                                        {item.commitGuard.decision === "commit"
                                                                                            ? "Commit ready"
                                                                                            : item.commitGuard.decision === "draft_only"
                                                                                                ? "Draft only"
                                                                                                : "Blocked"}
                                                                                    </span>
                                                                                )}

                                                                                <div className="flex-1" />

                                                                                {!itemSnoozed && (() => {
                                                                                    // v2: shortage label uses effective shortage, not raw runway.
                                                                                    // Refinement A: when the lifecycle ribbon below will render
                                                                                    // (item has open POs), drop the "→Xd adjusted" tail since the
                                                                                    // ribbon shows the same coverage in more detail.
                                                                                    const effective = getEffectiveShortageDays(item);
                                                                                    const ribbonBelow = (item.openPOs?.length ?? 0) > 0;
                                                                                    const rawIsZero = item.runwayDays === 0 && item.adjustedRunwayDays > 0;
                                                                                    if (rawIsZero && !ribbonBelow) {
                                                                                        return (
                                                                                            <span className={`text-xs font-mono shrink-0 ${rc}`}>
                                                                                                on hand out · covered <span className="text-zinc-300">{Math.round(item.adjustedRunwayDays)}d</span>
                                                                                            </span>
                                                                                        );
                                                                                    }
                                                                                    return (
                                                                                        <span className={`text-xs font-mono shrink-0 ${rc}`} title="Effective shortage: finaleStockoutDays > adjustedRunwayDays > runwayDays">
                                                                                            shortage {Number.isFinite(effective) ? `${Math.round(effective)}d` : "—"}
                                                                                            {!ribbonBelow && item.stockOnOrder > 0 && (
                                                                                                <span className="text-zinc-400 font-normal text-[10px]">
                                                                                                    {" "}(raw {Math.round(item.runwayDays)}d)
                                                                                                </span>
                                                                                            )}
                                                                                        </span>
                                                                                    );
                                                                                })()}

                                                                                {/* Per-row trigger reason badge */}
                                                                                {!itemSnoozed && item.triggerReason && (
                                                                                    <span
                                                                                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                                                                                            item.triggerReason === 'build-driven' ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                                                                                            : item.triggerReason === 'stockout-padded' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                                                                                            : item.triggerReason === 'runway-short' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                                                                                            : 'bg-zinc-700/40 text-zinc-400 border-zinc-700'
                                                                                        }`}
                                                                                        title={item.triggerDetail ?? ''}
                                                                                    >
                                                                                        {item.triggerReason === 'build-driven' ? '📅 build' :
                                                                                         item.triggerReason === 'stockout-padded' ? '🔁 stockout' :
                                                                                         item.triggerReason === 'runway-short' ? '⏱ runway' :
                                                                                         '🗓 cadence'}
                                                                                    </span>
                                                                                )}

                                                                                {/* 🚛 BULK badge — shown when vendor is flagged as a bulk multi-leg shipper */}
                                                                                {!itemSnoozed && item.isBulkVendor && (
                                                                                    <span
                                                                                        className="text-[9px] font-mono px-1 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300 shrink-0"
                                                                                        title="Bulk vendor — shipments arrive in multiple legs over time"
                                                                                    >
                                                                                        🚛 BULK
                                                                                    </span>
                                                                                )}

                                                                                <div className="relative shrink-0 ml-1">
                                                                                    <button
                                                                                        onClick={e => {
                                                                                            e.stopPropagation();
                                                                                            // Single click unsnoozes — no menu needed when the only action is "bring it back."
                                                                                            if (itemSnoozed) { doUnsnooze(iKey); return; }
                                                                                            setSnoozeMenu(snoozeMenu === iKey ? null : iKey);
                                                                                        }}
                                                                                        className={`text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors ${itemSnoozed
                                                                                            ? "text-emerald-400/80 hover:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/10"
                                                                                            : "text-zinc-500 hover:text-zinc-300"
                                                                                            }`}
                                                                                        title={itemSnoozed ? "Unsnooze this item" : "Snooze this item"}
                                                                                    >{itemSnoozed ? "↩ unsnooze" : "···"}</button>
                                                                                    {!itemSnoozed && snoozeMenu === iKey && renderSnoozeMenu(iKey)}
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
                                                                                        if (detail?.humanReplyDetectedAt) pieces.push(`reply 💬`);
                                                                                        if (detail?.trackingRequestedAt) pieces.push(`poke ✉️`);
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

                                                                            {/* ── Bulk last-receipt + order-needed row ── */}
                                                                            {/* DECISION(2026-05-21): Shown for all isBulkVendor items so the
                                                                                ordering surface always answers: when did we last buy, and when
                                                                                must we place the next order? Removes need to cross-reference
                                                                                Active Purchases or Finale for bulk vendors. */}
                                                                            {!itemSnoozed && item.isBulkVendor && (() => {
                                                                                const lastDate = item.lastPurchaseDate;
                                                                                const lastQty  = item.lastPurchaseQty;
                                                                                // "Order by" = today + (runwayDays - leadTimeDays).
                                                                                // Positive = days until we MUST place the order.
                                                                                // Zero/negative = already past the order window.
                                                                                const orderByDays = Math.round(item.runwayDays - item.leadTimeDays);
                                                                                const orderByDate = orderByDays > -90
                                                                                    ? new Date(Date.now() + orderByDays * 86400000)
                                                                                        .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                                                                                    : null;
                                                                                const hasOpenPO = (item.openPOs?.length ?? 0) > 0;
                                                                                return (
                                                                                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-500 px-0.5">
                                                                                        {lastDate && lastQty != null ? (
                                                                                            <span title="Most recent completed PO order date + qty for this SKU">
                                                                                                Last rcvd:
                                                                                                <span className="text-zinc-300 ml-1">
                                                                                                    {lastQty.toLocaleString()} · {new Date(lastDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}
                                                                                                </span>
                                                                                            </span>
                                                                                        ) : (
                                                                                            <span className="text-zinc-600 italic">no receipt history</span>
                                                                                        )}
                                                                                        <span className="text-zinc-700">·</span>
                                                                                        {hasOpenPO ? (
                                                                                            <span className="text-emerald-400/80 font-semibold">
                                                                                                ✓ PO committed
                                                                                            </span>
                                                                                        ) : orderByDate ? (
                                                                                            <span
                                                                                                className={`font-semibold ${
                                                                                                    orderByDays <= 0  ? 'text-red-400' :
                                                                                                    orderByDays <= 14 ? 'text-amber-400' :
                                                                                                    'text-zinc-400'
                                                                                                }`}
                                                                                                title={`Place order by ${orderByDate} so it arrives before stockout (runway ${Math.round(item.runwayDays)}d − lead ${item.leadTimeDays}d = ${orderByDays}d remaining)`}
                                                                                            >
                                                                                                {orderByDays <= 0 ? '⚠ ORDER NOW — window closed' : `order by ${orderByDate}`}
                                                                                            </span>
                                                                                        ) : (
                                                                                            <span className="text-zinc-600">order timing unknown</span>
                                                                                        )}
                                                                                    </div>
                                                                                );
                                                                            })()}

                                                                            {/* Row 2: Description & Amount */}
                                                                            {!itemSnoozed && (
                                                                                <div className="flex items-center gap-2 mt-1">
                                                                                    <span className="text-[13px] font-mono text-zinc-200 flex-1 truncate">
                                                                                        {item.productName}
                                                                                        {(item.itemType === 'bom-component' || item.itemType === 'resale-bom') && (
                                                                                            <span
                                                                                                className="text-[8px] font-mono px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 ml-1"
                                                                                                title={item.itemType === 'resale-bom'
                                                                                                    ? 'Both sold directly AND used as a BOM component in finished goods'
                                                                                                    : 'BOM component — consumed by finished goods builds, not sold directly'}
                                                                                            >
                                                                                                {item.itemType === 'resale-bom' ? 'BOM+RESALE' : 'BOM'}
                                                                                            </span>
                                                                                        )}
                                                                                    </span>
                                                                                    {item.reorderMethod === "default" && item.dailyRateSource === "demand" && (
                                                                                        <span className="text-[11px] font-mono text-zinc-300 shrink-0" title="No sales or receipt velocity found — falling back to Finale demand signal">
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

                                                                            {/* Row 2.5: Demand context — what is driving this order? */}
                                                                            {/* DECISION(2026-05-27): Users asked "why is this critical, what triggers it,
                                                                                how is it consumed?" This row answers all three without requiring a Why drawer:
                                                                                - Retail demand: sold directly, shows sales velocity + demand rate
                                                                                - BOM demand: component of finished goods, shows which products consume it
                                                                                - BOM+retail: both paths, shows combined burn rate */}
                                                                            {!itemSnoozed && (() => {
                                                                                const isBom = item.itemType === 'bom-component' || item.itemType === 'resale-bom';
                                                                                const isResale = item.itemType === 'resale' || item.itemType === 'resale-bom';
                                                                                const hasFGs = (item.feedsFinishedGoods?.length ?? 0) > 0;
                                                                                const hasDemandContext = isBom || (item.candidate?.bomDemand ?? 0) > 0 || (item.candidate?.directDemand ?? 0) > 0;
                                                                                if (!hasDemandContext && !hasFGs) return null;
                                                                                return (
                                                                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono text-zinc-500 px-0.5">
                                                                                        {/* Retail demand signal */}
                                                                                        {isResale && (item.candidate?.directDemand ?? 0) > 0 && (
                                                                                            <span title="Direct retail sales velocity feeding this reorder">
                                                                                                retail: <span className="text-zinc-300">{(item.candidate!.directDemand).toFixed(1)}/day</span>
                                                                                            </span>
                                                                                        )}
                                                                                        {/* BOM demand signal */}
                                                                                        {isBom && (item.candidate?.bomDemand ?? 0) > 0 && (
                                                                                            <span title="Demand from BOM builds — how many units of this component are consumed per day across all finished goods">
                                                                                                bom: <span className="text-purple-300">{(item.candidate!.bomDemand).toFixed(1)}/day</span>
                                                                                            </span>
                                                                                        )}
                                                                                        {/* What finished goods consume this */}
                                                                                        {hasFGs && (
                                                                                            <span
                                                                                                className="text-purple-300/70"
                                                                                                title={item.feedsFinishedGoods!.map(fg => `${fg.sku} – ${fg.name} (≈${fg.buildsWorth} builds covered)`).join('\n')}
                                                                                            >
                                                                                                feeds: {item.feedsFinishedGoods!.slice(0, 2).map(fg => fg.sku).join(', ')}
                                                                                                {(item.feedsFinishedGoods!.length) > 2 && ` +${item.feedsFinishedGoods!.length - 2}`}
                                                                                            </span>
                                                                                        )}
                                                                                        {/* Trigger reason in plain language */}
                                                                                        {item.triggerReason === 'build-driven' && (
                                                                                            <span className="text-cyan-400/80" title={item.triggerDetail ?? 'Triggered by upcoming BOM build demand'}>↑ build demand</span>
                                                                                        )}
                                                                                        {item.triggerReason === 'stockout-padded' && (
                                                                                            <span className="text-rose-400/80" title={item.triggerDetail ?? 'Stockout imminent — ordering with safety padding'}>⚠ stockout risk</span>
                                                                                        )}
                                                                                        {item.triggerReason === 'runway-short' && (
                                                                                            <span className="text-amber-400/80" title={item.triggerDetail ?? 'Runway is below the safety threshold'}>↓ runway short</span>
                                                                                        )}
                                                                                    </div>
                                                                                );
                                                                            })()}

                                                                            {!itemSnoozed && (item.itemType === 'bom-component' || item.itemType === 'resale-bom') && item.feedsFinishedGoods && item.feedsFinishedGoods.length > 0 && false && (
                                                                                <div className="text-[9px] text-zinc-500 font-mono mt-0.5 truncate">
                                                                                    feeds: {item.feedsFinishedGoods.slice(0, 2).map(fg =>
                                                                                        `${fg.name} (≈${fg.buildsWorth} builds covered)`
                                                                                    ).join(' · ')}
                                                                                    {item.feedsFinishedGoods.length > 2 && ` · +${item.feedsFinishedGoods.length - 2} more`}
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
                                                                                        <label className="flex items-center gap-1.5 shrink-0 relative">
                                                                                            <span className="text-[11px] font-mono text-zinc-300">qty</span>
                                                                                            <input
                                                                                                type="number" min={1} value={qty}
                                                                                                onChange={e => setQty(pid, iKey, parseInt(e.target.value) || 1)}
                                                                                                onClick={e => e.stopPropagation()}
                                                                                                className="w-20 px-2 py-1 text-xs font-mono bg-zinc-900 border border-zinc-600 hover:border-zinc-400 rounded text-zinc-50 focus:outline-none focus:border-emerald-500 text-right transition-colors"
                                                                                            />
                                                                                            {item.roundingAlternatives && item.roundingAlternatives.length > 0 && (() => {
                                                                                                const isOpen = qtyDropdownOpen?.pid === pid && qtyDropdownOpen?.productId === item.productId;
                                                                                                const auto = item.suggestedQty;
                                                                                                const alts = Array.from(new Set((item.roundingAlternatives ?? []).filter(v => v !== auto))).sort((a, b) => a - b).slice(0, 2);
                                                                                                const entries: Array<{ value: number; isAuto: boolean }> = [
                                                                                                    { value: auto, isAuto: true },
                                                                                                    ...alts.map(v => ({ value: v, isAuto: false })),
                                                                                                ];
                                                                                                return (
                                                                                                    <>
                                                                                                        <button
                                                                                                            type="button"
                                                                                                            title="Snap to a different clean number"
                                                                                                            onClick={e => {
                                                                                                                e.stopPropagation();
                                                                                                                setQtyDropdownOpen(isOpen ? null : { pid, productId: item.productId });
                                                                                                            }}
                                                                                                            className="ml-0.5 px-1 py-0.5 text-[10px] font-mono bg-zinc-900 border border-zinc-700 hover:border-zinc-400 rounded text-zinc-400 hover:text-zinc-100 leading-none"
                                                                                                        >
                                                                                                            ▾
                                                                                                        </button>
                                                                                                        {isOpen && (
                                                                                                            <div
                                                                                                                onClick={e => e.stopPropagation()}
                                                                                                                className="absolute z-50 right-0 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded shadow-lg min-w-[8rem]"
                                                                                                            >
                                                                                                                {entries.map(entry => {
                                                                                                                    const delta = entry.value - auto;
                                                                                                                    const sign = delta >= 0 ? "+" : "";
                                                                                                                    return (
                                                                                                                        <button
                                                                                                                            key={entry.value}
                                                                                                                            type="button"
                                                                                                                            onClick={e => {
                                                                                                                                e.stopPropagation();
                                                                                                                                setQty(pid, iKey, entry.value);
                                                                                                                                setQtyDropdownOpen(null);
                                                                                                                            }}
                                                                                                                            className="w-full flex items-center justify-between gap-2 px-2 py-1 text-[11px] font-mono text-zinc-200 hover:bg-zinc-800 text-left"
                                                                                                                        >
                                                                                                                            <span className="font-semibold">{entry.value}</span>
                                                                                                                            {entry.isAuto ? (
                                                                                                                                <span className="text-[10px] text-emerald-400">(auto)</span>
                                                                                                                            ) : (
                                                                                                                                <span className="text-[10px] text-zinc-500">{sign}{delta}</span>
                                                                                                                            )}
                                                                                                                        </button>
                                                                                                                    );
                                                                                                                })}
                                                                                                            </div>
                                                                                                        )}
                                                                                                    </>
                                                                                                );
                                                                                            })()}
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
                                                                                            {item.projectedNextOrderDate && (
                                                                                                <span className="ml-2 text-cyan-300 not-italic">
                                                                                                    · 🔮 Next order ~{item.projectedNextOrderDate}
                                                                                                </span>
                                                                                            )}
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
                                                                                    {!itemSnoozed && item.draftPO && (
                                                                                        <div className="mt-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded p-2.5 font-mono text-[11px] space-y-1.5 animate-fadeIn">
                                                                                            <div className="flex items-start gap-1.5">
                                                                                                <span className="font-bold text-amber-400 block text-xs">⚠️ Draft PO Detected</span>
                                                                                            </div>
                                                                                            <p className="leading-normal text-zinc-300">
                                                                                                Draft PO #{item.draftPO.orderId} created on {item.draftPO.orderDate} by {item.draftPO.supplierName} contains {item.draftPO.quantity} units of this item. Please review and commit this PO instead of creating a duplicate.
                                                                                            </p>
                                                                                            <div className="flex items-center gap-2 pt-1">
                                                                                                <button
                                                                                                    onClick={(e) => { e.stopPropagation(); handleReviewAndSend(item.draftPO!.orderId); }}
                                                                                                    className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 transition-all font-semibold text-[10px]"
                                                                                                >
                                                                                                    Commit & Send PO
                                                                                                </button>
                                                                                                <button
                                                                                                    onClick={(e) => { e.stopPropagation(); handleCancelDraft(item.draftPO!.orderId); }}
                                                                                                    className="px-2 py-1 rounded border border-rose-500/40 hover:bg-rose-500/20 hover:text-rose-200 text-rose-300 transition-all font-semibold text-[10px]"
                                                                                                    title="Cancel this draft PO in Finale"
                                                                                                >
                                                                                                    🗑 Cancel Draft
                                                                                                </button>
                                                                                            </div>
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
