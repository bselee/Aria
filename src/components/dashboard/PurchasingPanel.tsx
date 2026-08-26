"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Package, RefreshCw, ChevronDown, ExternalLink, Eye, Loader2, Search } from "lucide-react";

// Lazy-load flyout to avoid SSG bundling-order issues with the agentic audit panel.
const VendorDecisionFlyout = dynamic(() => import("./VendorDecisionFlyout"), { ssr: false });
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
import { VendorOutlookBar } from "./VendorOutlookBar";
import { FilterChip, ActionChip } from "@/components/dashboard/chips";
import { selectForwardPoLines, applyTruckQty } from "@/lib/purchasing/forward-po-lines";
import { bundleVendorDraftLines, isAmazonVendor } from "@/lib/purchasing/vendor-sku-bundle";
import { decodeOutlookNotes, isHoldActive, type VendorOutlookFields } from "@/lib/purchasing/vendor-outlook";
import { formatPoDraftLabel, isAutoDraftToday, isNeverAutonomous, orderDraftJustification, shouldListOnOrdering } from "@/lib/purchasing/ordering-row-copy";

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
        autoDrafted?: boolean;
    } | null;
    dailyRateSource?: "demand" | "sales" | "receipts";
    runwayDays: number; adjustedRunwayDays: number; leadTimeDays: number; leadTimeProvenance: string;
    effectiveLeadTimeDays?: number;
    stockAvailable?: number | null;
    forwardDemandEntry?: { requiredQty: number; earliestBuildDate: string; feedsBuilds: string[] } | null;
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
    autonomyLevel?: number;
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
    /** Crawl time of the basauto third-opinion report joined onto rows. */
    basautoReconAt?: string | null;
    /** True when the basauto report is older than the 30h TTL (cron failure). */
    basautoReconStale?: boolean;
    /** basauto-flagged SKUs with no Aria row — the BAS-only strip. */
    basautoOnlyFlags?: BasautoOnlyFlag[];
};

/** A basauto flag for a SKU that has no Ordering row at all. */
type BasautoOnlyFlag = {
    sku: string;
    vendor: string | null;
    description: string | null;
    severity: "high" | "medium" | "low";
    reason: string;
    basauto: { urgency: string | null; stockDaysLeft: number | null; reorderQty: number | null; reorderDate: string | null };
};
type POResult = {
    orderId: string;
    finaleUrl: string;
    expectedDelivery?: ExpectedDelivery;
    verification?: DraftVerification;
    preemptCount?: number;
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
type SendStepStatus = 'pending' | 'verifying' | 'ok' | 'fail' | 'skip';
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
/** Session-scoped: vendors just ordered stay off Ordering until Finale recent-PO overlay catches up. */
const ORDERED_VENDORS_LS = "aria-dash-purchasing-ordered-vendors";
const ORDERED_VENDOR_TTL_MS = 6 * 60 * 60 * 1000; // 6h

type OrderedVendorEntry = { at: number; orderId?: string };

function readOrderedVendors(): Record<string, OrderedVendorEntry> {
    try {
        const raw = sessionStorage.getItem(ORDERED_VENDORS_LS);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Record<string, OrderedVendorEntry>;
        const now = Date.now();
        const keep: Record<string, OrderedVendorEntry> = {};
        for (const [pid, entry] of Object.entries(parsed || {})) {
            if (entry?.at && now - entry.at < ORDERED_VENDOR_TTL_MS) keep[pid] = entry;
        }
        return keep;
    } catch {
        return {};
    }
}

function writeOrderedVendor(vendorPartyId: string, orderId?: string): void {
    try {
        const next = readOrderedVendors();
        next[vendorPartyId] = { at: Date.now(), orderId };
        sessionStorage.setItem(ORDERED_VENDORS_LS, JSON.stringify(next));
    } catch { /* ignore */ }
}
function lifecycleBucket(item: PurchasingItem): LifecycleBucket {
    const reasons = item.assessment?.reasonCodes ?? [];
    // Draft or committed open-PO coverage — Ordering only keeps need/topping.
    if (reasons.includes("on_order_already_covers_need") || reasons.includes("recent_draft_exists")) {
        return "on_order";
    }
    if (item.draftPO) return "on_order";
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

// ── Lifecycle summary helpers ─────────────────────────────────────────────

type VendorLifecycleSummary = {
    totalPOs: number;
    stageCounts: Record<string, number>;
    earliestETA: string | null;
    stuckCount: number;
    stuckStage: string | null; // most severe stuck stage
    hasDeliveredNotReceived: boolean;
};

/**
 * Aggregate lifecycle data across ALL open POs for a vendor group.
 * Scans every item's openPOs, looks up the detail, and produces a compact
 * status summary for the collapsed vendor row.
 */
function vendorLifecycleSummary(
    items: PurchasingItem[],
    detailMap: Map<string, OpenPODetail>,
): VendorLifecycleSummary | null {
    const poSet = new Set<string>();
    const stages: Record<string, number> = {};
    let earliestETA: string | null = null;
    let stuckCount = 0;
    let worstStuckStage: string | null = null;
    let hasDeliveredNotReceived = false;

    for (const item of items) {
        for (const po of item.openPOs ?? []) {
            if (poSet.has(po.orderId)) continue;
            poSet.add(po.orderId);
            const d = detailMap.get(po.orderId);
            if (!d) continue;

            const stage = d.lifecycleStage ?? "unknown";
            stages[stage] = (stages[stage] ?? 0) + 1;

            // Track stuck conditions
            const isStuck =
                stage === "noncomm" ||
                stage === "tracking_unavailable" ||
                stage === "stalled" ||
                stage === "ap_follow_up" ||
                stage === "human_escalated";
            if (isStuck) {
                stuckCount++;
                // Rank stuck severity: noncomm > human_escalated > tracking_unavailable > ap_follow_up > stalled
                const severity = ["noncomm", "human_escalated", "tracking_unavailable", "ap_follow_up", "stalled"];
                for (const s of severity) {
                    if (stage === s) { worstStuckStage = s; break; }
                }
            }

            // Delivered but not yet received in Finale
            if (stage === "delivered" && !d.isReceived) {
                hasDeliveredNotReceived = true;
            }

            // Track earliest ETA
            if (d.expectedDate && (!earliestETA || d.expectedDate < earliestETA)) {
                earliestETA = d.expectedDate;
            }
        }
    }

    if (poSet.size === 0) return null;

    return {
        totalPOs: poSet.size,
        stageCounts: stages,
        earliestETA,
        stuckCount,
        stuckStage: worstStuckStage,
        hasDeliveredNotReceived,
    };
}

/** Stuck-stage labels for next-action guidance. */
const STUCK_LABELS: Record<string, { label: string; tone: string; action: string }> = {
    noncomm:              { label: "Unresponsive", tone: "text-rose-300 border-rose-500/40 bg-rose-500/10", action: "Escalate vendor" },
    human_escalated:      { label: "Escalated",    tone: "text-purple-300 border-purple-500/40 bg-purple-500/10", action: "Review escalation" },
    tracking_unavailable: { label: "No Tracking",  tone: "text-amber-300 border-amber-500/40 bg-amber-500/10", action: "Request tracking" },
    ap_follow_up:         { label: "AP Follow-up", tone: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10", action: "Follow up" },
    stalled:              { label: "Stalled",      tone: "text-zinc-300 border-zinc-600/40 bg-zinc-800/40", action: "Check status" },
};

/**
 * Categorize a PO's lifecycle stage into one of a few compact buckets
 * so the collapsed row gets a readable summary.
 */
function lifecycleStageBucket(stage: string | undefined): { emoji: string; text: string; tone: string } | null {
    if (!stage) return null;
    switch (stage) {
        case "sent":              return { emoji: "🕐", text: "Sent",     tone: "text-cyan-400" };
        case "vendor_acknowledged": return { emoji: "✋", text: "Acked",   tone: "text-cyan-300" };
        case "moving_with_tracking": return { emoji: "📦", text: "In Transit", tone: "text-emerald-300" };
        case "delivered":         return { emoji: "✅", text: "Delivered", tone: "text-emerald-400" };
        case "noncomm":           return { emoji: "🚫", text: "Unresponsive", tone: "text-rose-300" };
        case "tracking_unavailable": return { emoji: "🔍", text: "No Tracking", tone: "text-amber-300" };
        case "human_escalated":   return { emoji: "🚨", text: "Escalated", tone: "text-purple-300" };
        case "ap_follow_up":      return { emoji: "💬", text: "AP Follow", tone: "text-cyan-300" };
        default:                  return { emoji: "🔄", text: stage.replace(/_/g, " "), tone: "text-zinc-400" };
    }
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
export type PurchasingPanelProps = {
    /** Lifecycle column mode: fill height, no card collapse/resize. */
    embedded?: boolean;
};

export default function PurchasingPanel({ embedded = false }: PurchasingPanelProps = {}) {
    const lifecycle = usePurchasingLifecycle();
    const [data, setData] = useState<AssessmentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingTiers, setLoadingTiers] = useState<Set<UrgencyTier>>(new Set());
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showBasOnly, setShowBasOnly] = useState(false);

    const [vendorTab, setVendorTab] = useState<string>("all");
    const [outlookByVendor, setOutlookByVendor] = useState<Record<string, VendorOutlookFields>>({});
    // Vendor dropdown combobox state (replaces horizontal tab strip)
    const [vendorDropdownOpen, setVendorDropdownOpen] = useState(false);
    const [vendorSearchQuery, setVendorSearchQuery] = useState("");
    const vendorDropdownRef = useRef<HTMLDivElement>(null);
    const vendorSearchRef = useRef<HTMLInputElement>(null);
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
    const [preemptByVendor, setPreemptByVendor] = useState<Record<string, number>>({});
    const [autonomyOverride, setAutonomyOverride] = useState<Record<string, number>>({});
    // Vendors that have been drafted/committed — disappear from Ordering immediately.
        // Seeded from sessionStorage so a hard refresh within 6h doesn't resurrect them
        // before the fresh recent-PO coverage overlay lands on GET.
        const [completedVendors, setCompletedVendors] = useState<Set<string>>(() => {
            if (typeof window === "undefined") return new Set();
            return new Set(Object.keys(readOrderedVendors()));
        });
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

        /**
         * Immediately drop a vendor from Ordering after draft/commit.
         * Persists to sessionStorage so remounts stay clean until Finale recent-PO
         * overlay (GET) is the durable source of truth.
         */
        function markVendorOrdered(vendorPartyId: string, orderId?: string) {
            writeOrderedVendor(vendorPartyId, orderId);
            setCompletedVendors(p => new Set(p).add(vendorPartyId));
            setData(prev => prev
                ? { ...prev, groups: prev.groups.filter(g => g.vendorPartyId !== vendorPartyId) }
                : prev);
            setCreatedPOs(prev => {
                const next = { ...prev };
                delete next[vendorPartyId];
                return next;
            });
            setCreatedPODetails(prev => {
                const next = { ...prev };
                delete next[vendorPartyId];
                return next;
            });
        }

    // validation modal for PO quantity and case rounding guardrails
    const [validationModal, setValidationModal] = useState<any | null>(null);

    // snooze
    const [snooze, setSnooze] = useState<SnoozeMap>({});
    const [showSnoozed, setShowSnoozed] = useState(false);
    // Always start with snoozed hidden — user can toggle to reveal
    useEffect(() => { setShowSnoozed(false); }, []);
    const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);
    const [qtyDropdownOpen, setQtyDropdownOpen] = useState<{ pid: string; productId: string } | null>(null);
    // Default TODAY (order_now). Sorted most-needed-first inside the window.
    // localStorage may override after mount.
    const [focusFilter, setFocusFilter] = useState<FocusFilter>("order_now");
        // STATUS filter UI removed — actionable filter is hardcoded in itemMatchesLifecycle.
        type ItemMode = 'all' | 'resale' | 'bom';
    // Both resale and BOM items visible together (no UI toggle — the BOM
    // treatment renders cleanly for BOM rows, resale rows show their own data).
    const [itemMode] = useState<ItemMode>('all');
    const [openPosDetail, setOpenPosDetail] = useState<Map<string, OpenPODetail>>(new Map());

    // ULINE direct ordering
    const [ulineOrdering, setUlineOrdering] = useState(false);
    const [ulineResult, setUlineResult] = useState<UlineOrderResult | null>(null);
    const [selectedItem, setSelectedItem] = useState<CrystalBallItem | null>(null);

    // ── Phase 2: Decision Dossier flyout — glass cockpit on the autonomous ordering agent
    const [flyoutPid, setFlyoutPid] = useState<string | null>(null);

    // collapse + resize
    const [isCollapsed, setIsCollapsed] = useState(false);
    const effectivelyCollapsed = embedded ? false : isCollapsed;
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
    useEffect(() => { try { localStorage.removeItem(LIFECYCLE_FILTER_LS); } catch { /* ignore */ } }, []);

    // Close vendor dropdown on outside click
    useEffect(() => {
        if (!vendorDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (vendorDropdownRef.current && !vendorDropdownRef.current.contains(e.target as Node)) {
                setVendorDropdownOpen(false);
                setVendorSearchQuery("");
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [vendorDropdownOpen]);

    // Auto-focus the vendor search input when dropdown opens
    useEffect(() => {
        if (vendorDropdownOpen && vendorSearchRef.current) {
            vendorSearchRef.current.focus();
        }
    }, [vendorDropdownOpen]);

    // Fetch open-PO detail
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
        const outlook = outlookByVendor[item.supplierPartyId];
        const held = isHoldActive(outlook?.holdUntilDate ?? decodeOutlookNotes(item.vendorPolicy?.notes ?? null).holdUntilDate);
        if (held && focusFilter === "order_now") return false;
        if (focusFilter === "order_now") {
            if (itemMatchesOrderingFocus(item, "order_now")) {
                return true;
            }
            if (itemMatchesOrderingFocus(item, "30")) {
                const group = data?.groups.find(g => g.vendorPartyId === item.supplierPartyId);
                const hasOrderNow = group?.items.some(i => itemMatchesOrderingFocus(i, "order_now"));
                if (hasOrderNow) {
                    return true;
                }
            }
            return false;
        }
        return itemMatchesOrderingFocus(item, focusFilter);
    }
    function itemMatchesMode(item: PurchasingItem): boolean {
        if (itemMode === "all") return true;
        if (itemMode === "bom") return item.itemType === "bom-component";
        return item.itemType !== "bom-component";
    }
    function itemMatchesLifecycle(item: PurchasingItem): boolean {
        return shouldListOnOrdering(item);
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
            // Cold only: first paint with no data. Warm/SWR refreshes never flip
            // the full-panel loading gate (that was locking the Re-scan button and
            // making the green badge look like a stuck state).
            if (!data) setLoading(true);
            else if (bust) setScanning(true);

            setLoadingTiers(new Set(['critical', 'warning', 'watch', 'ok']));
            try {
                const res = await fetch(`/api/dashboard/purchasing?mode=all${bust ? '&bust=1' : ''}`);
                const json: AssessmentData = await res.json();
                if (!res.ok) throw new Error(json.error || `Failed to load ordering`);

                // HERMIA(2026-07-28): Server `refreshing` means SWR is revalidating in
                                // the background (can run 12–15 min). Only spin while the list is
                                // still empty (cold path). Warm cache — even with a background
                                // refresh or after user Re-scan — keeps data painted and the
                                // green badge off. (Old code set scanning on every refreshing
                                // response + polled every 15s → perpetual spinner.)
                                const hasGroups = (json.groups?.length ?? 0) > 0;
                                setScanning(Boolean(json.refreshing && !hasGroups));

                                setData(json);
                                                                setLoading(false);

                                                // Keep just-ordered vendors out of the painted list even when SWR
                                                // still returns pre-order need math (full rescan is 12–15 min).
                                                // Server recent-PO overlay is the durable fix; this is the paint guard.
                                                const orderedIds = new Set([
                                                    ...completedVendors,
                                                    ...Object.keys(readOrderedVendors()),
                                                ]);
                                                if (orderedIds.size > 0) {
                                                    setCompletedVendors(orderedIds);
                                                    setData(prev => prev
                                                        ? {
                                                            ...prev,
                                                            groups: prev.groups.filter(g => !orderedIds.has(g.vendorPartyId)),
                                                        }
                                                        : prev);
                                                }

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

        useEffect(() => { load();   }, []);

        // RCV receipt event → bust ordering cache so need drops same day
        const prevReceiptAtRef = useRef<number>(0);
        useEffect(() => {
            const r = lifecycle.lastReceipt;
            if (!r || r.at === prevReceiptAtRef.current) return;
            prevReceiptAtRef.current = r.at;
            load(true);
            /* eslint-disable-next-line react-hooks/exhaustive-deps */
        }, [lifecycle.lastReceipt]);

        // Auto-poll ONLY while cold (empty list + server still refreshing).
        // Warm SWR revalidation no longer triggers a 15s poll loop — that was the
        // perpetual green "Refreshing…" badge (scan lasts 12–15 min every TTL miss).
        useEffect(() => {
            if (!data?.refreshing) return;
            if ((data.groups?.length ?? 0) > 0) return;
            const t = setTimeout(() => { load(); }, 15_000);
            return () => clearTimeout(t);
            /* eslint-disable-next-line react-hooks/exhaustive-deps */
        }, [data?.refreshing, data?.cachedAt, data?.groups?.length]);

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
        const anyChecked = Object.values(checked[pid] ?? {}).some(Boolean);
        const items = bundleVendorDraftLines({
            vendorName: group.vendorName,
            allItems: group.items,
            selected: applyTruckQty(
                selectForwardPoLines({
                    items: group.items,
                    focus: focusFilter,
                    qtyOverrides: qtys[pid],
                    isSnoozed,
                    isCovered: itemIsCovered,
                    checked: checked[pid],
                    requireChecked: false,
                }),
                outlookByVendor[pid]?.truckQty ?? null,
            ),
            allowPreempt: !anyChecked,
        }).map(line => ({
            ...line,
            leadTimeDays: outlookByVendor[pid]?.leadTimeOverrideDays ?? line.leadTimeDays ?? null,
        }));
        const preemptCount = items.filter((l: any) => l.preempt).length;
        if (items.length === 0) return null;
        const res = await fetch("/api/dashboard/purchasing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vendorPartyId: pid, items, memo: "Purchasing Intelligence draft — review and commit in Finale", ignoreCommitGuards, skipPreflight: true }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        return { ...(json as POResult), preemptCount };
    }

    async function handleCreateAllDrafts(groups: PurchasingGroup[]) {
        // Draft only. Send from Finale — Aria email is not the path.
        for (const group of groups) {
            const pid = group.vendorPartyId;
            const sel = group.items.filter(i =>
                !isSnoozed(i.productId) &&
                canIncludeInDraftPO(i.reorderMethod) &&
                i.suggestedQty > 0 &&
                (i as any).assessment?.decision === 'order'
            );
            if (sel.length === 0) continue;
            setCreatingPO(p => new Set(p).add(pid));
            try {
                const result = await createVendorPO(group, true);
                if (result?.orderId) {
                    setCreatedPOs(p => ({ ...p, [pid]: result }));
                    setPreemptByVendor(p => ({ ...p, [pid]: result.preemptCount ?? 0 }));
                    markVendorOrdered(pid, result.orderId);
                }
            } catch (e: any) {
                console.error(`[order-all] ${group.vendorName}:`, e.message);
            } finally {
                setCreatingPO(p => { const n = new Set(p); n.delete(pid); return n; });
            }
        }
        load(true);
    }
    async function handleCreateOne(group: PurchasingGroup, ignoreCommitGuards?: boolean) {
        const pid = group.vendorPartyId;

        // ── Draft PO: create immediately, no dialogs ──────────────────────
        // Bill's rule (2026-06-23): Draft creation is step one. Create the
        // draft in Finale immediately. Do not show commit/send dialogs —
        // the send function needs a separate fix. One click, one draft.
        const selectedItems = group.items.filter(
            i => !isSnoozed(i.productId) && checked[pid]?.[i.productId] && canIncludeInDraftPO(i.reorderMethod)
        );

        setCreatingPO(p => new Set(p).add(pid));
        try {
            const result = await createVendorPO(group, true); // bypass all server guards
            if (result) {
                            // Draft created in Finale — leave Ordering immediately (Active POs owns it).
                            setCreatedPOs(p => ({ ...p, [pid]: result }));
                            setPreemptByVendor(p => ({ ...p, [pid]: result.preemptCount ?? 0 }));
                            setCreatedPODetails(p => ({ ...p, [pid]: result }));
                            markVendorOrdered(pid, result.orderId);
                            const selItems = selectedItems;
                            const totalUnits = selItems.reduce((s, i) => s + (qtys[pid]?.[i.productId] ?? i.assessment?.recommendedQty ?? i.suggestedQty), 0);
                            lifecycle.notifyDraft({
                                vendorName: group.vendorName,
                                orderId: result.orderId || "pending",
                                itemCount: selItems.length || group.items.length,
                                totalUnits,
                            });
                            await load(true);
                        }
        } catch (e: any) {
            setError(`PO failed for ${group.vendorName}: ${e.message}`);
        } finally {
            setCreatingPO(p => { const n = new Set(p); n.delete(pid); return n; });
        }
    }

    async function toggleVendorAutoDraft(vendorName: string, enabled: boolean) {
        if (isNeverAutonomous(vendorName)) return;
        const prev = autonomyOverride[vendorName];
        setAutonomyOverride(p => ({ ...p, [vendorName]: enabled ? 1 : 0 }));
        try {
            const res = await fetch("/api/dashboard/vendor-autonomy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ vendorName, enabled }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || res.statusText);
            }
        } catch (e: any) {
            setAutonomyOverride(p => {
                const next = { ...p };
                if (prev === undefined) delete next[vendorName];
                else next[vendorName] = prev;
                return next;
            });
            setError(`Auto-draft for ${vendorName}: ${e.message}`);
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
            const emailSent = v?.emailSent ?? json.details?.emailSent ?? json.details?.finaleEmailSent ?? false;
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
                        // Notify Active POs when committed (email optional — native send often fails).
                        if (committed || details.finaleEmailSent || emailSent) {
                            if (details.finaleEmailSent || emailSent) {
                                setSentPOs(p => new Set(p).add(commitModal.review.orderId));
                            }
                            lifecycle.notifyDraft({
                                vendorName: commitModal.review.vendorName,
                                orderId: commitModal.review.orderId,
                                itemCount: commitModal.review.items.length,
                                totalUnits: commitModal.review.items.reduce((s, i) => s + i.quantity, 0),
                            });
                        }
                        // Bill: once PO is generated/committed, leave Ordering immediately.
                        markVendorOrdered(commitModal.review.vendorPartyId, commitModal.review.orderId);

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
    const activeGroups = sortedGroups.filter(g => !vendorSnoozed(g) && !completedVendors.has(g.vendorPartyId));
    const displayGroups = showSnoozed ? sortedGroups : activeGroups;

    // ── Helpers ──────────────────────────────────────────────────────────
    /** Map Finale PO status to a human-readable label */
    function poStatusLabel(status: string): string {
        const s = status.toLowerCase();
        if (s.includes('draft') || s.includes('created')) return 'Draft';
        if (s.includes('sent')) return 'Sent';
        if (s.includes('committed') || s.includes('locked')) return 'Committed';
        if (s.includes('received') || s.includes('partial')) return 'Received';
        return status;
    }

    /** Build a clear badge label from vendor cycle info */
    function cycleBadgeText(vc: VendorCycle): string {
        const po = vc.blockingPO?.orderId ? `#${vc.blockingPO.orderId}` : '';
        const st = vc.blockingPO?.status ? poStatusLabel(vc.blockingPO.status) : '';
        if (po && st) return `${st} PO ${po}`;
        if (po) return `PO ${po}`;
        if (vc.decision === 'routine_locked') return 'Active PO';
        if (vc.decision === 'reuse_draft') return 'Reuse Draft';
        return '';
    }

    /** An item is covered if existing PO incoming + stock ≥ lead_time + 30d demand */
        function itemIsCovered(item: PurchasingItem): boolean {
            if (!item.openPOs || item.openPOs.length === 0) return false;
            // Prefer openPOs qty when Finale stockOnOrder lags (common on labels/print).
            const openQty = item.openPOs.reduce((s, po) => s + Math.max(0, po.quantity || 0), 0);
            const incoming = Math.max(item.stockOnOrder ?? 0, openQty);
            const onHand = item.stockOnHand ?? 0;
            const daily = item.dailyRate ?? 0;
            const lead = item.leadTimeDays ?? 14;
            const needed = daily * (lead + 30);
            if (needed > 0 && (onHand + incoming) >= needed) return true;
            // Also cover when open PO qty alone meets or exceeds Aria's suggested reorder.
            if (openQty >= Math.max(1, item.suggestedQty ?? 1)) return true;
            // Policy already held for on-order coverage.
            if ((item.assessment?.reasonCodes ?? []).includes("on_order_already_covers_need")) return true;
            if ((item.assessment?.reasonCodes ?? []).includes("recent_draft_exists")) return true;
            return false;
        }

    // Phase 2: Decision Dossier flyout payload — snapshot group + derived props
    // (placed after displayGroups so useMemo factory sees initialized const)
    const flyoutPayload = React.useMemo(() => {
        if (!flyoutPid) return null;
        const group = displayGroups.find(g => g.vendorPartyId === flyoutPid);
        if (!group) return null;
        const pid = group.vendorPartyId;
        const activeItems = group.items.filter(i => !isSnoozed(i.productId));
        const selectedItems = activeItems.filter(i => checked[pid]?.[i.productId]);
        const groupQtys = qtys[pid] ?? {};
        return {
            group,
            selectedCount: selectedItems.length,
            selectedUnits: selectedItems.reduce((s, i) => s + (groupQtys[i.productId] ?? i.suggestedQty), 0),
            selectedValue: selectedItems.reduce((s, i) => s + (groupQtys[i.productId] ?? i.suggestedQty) * Math.max(0, i.unitPrice), 0),
            hasDraftPO: !!createdPOs[pid],
            vendorCycleBadge: group.vendorCycle && group.vendorCycle.decision !== "clear"
                ? {
                    text: cycleBadgeText(group.vendorCycle),
                    className: group.vendorCycle.decision === "routine_locked"
                        ? "text-amber-200 border-amber-500/40 bg-amber-500/10"
                        : group.vendorCycle.decision === "exception_allowed"
                        ? "text-cyan-200 border-cyan-500/40 bg-cyan-500/10"
                        : "text-emerald-200 border-emerald-500/40 bg-emerald-500/10",
                }
                : null,
        };
    }, [flyoutPid, displayGroups, checked, qtys, createdPOs, isSnoozed]);

    const focusGroups = displayGroups
        .map(group => {
            const hasDraftPO = !!createdPOs[group.vendorPartyId];
            return {
                ...group,
                items: hasDraftPO
                    ? []
                    : sortItemsByNeed(group.items.filter(item =>
                        itemMatchesFocus(item) && itemMatchesLifecycle(item) && !itemIsCovered(item) && item.suggestedQty > 0
                    )),
            };
        })
        .filter(group => group.items.length > 0 || !!createdPOs[group.vendorPartyId]);


    // Vendor dropdown: filtered list of groups based on search query
    const vendorDropdownItems = (() => {
        const q = vendorSearchQuery.trim().toLowerCase();
        if (!q) return focusGroups;
        return focusGroups.filter(g => {
            if (g.vendorName.toLowerCase().includes(q)) return true;
            if (g.vendorPartyId.toLowerCase().includes(q)) return true;
            // Also match against product IDs in the group
            return g.items.some(i =>
                i.productId.toLowerCase().includes(q) ||
                i.productName.toLowerCase().includes(q)
            );
        });
    })();
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
    const orderNowDollars = activeGroups
        .flatMap(g => g.items)
        .filter(i => itemMatchesOrderingFocus(i, "order_now") && itemMatchesLifecycle(i))
        .reduce((sum, i) => sum + (i.suggestedQty || 0) * Math.max(0, i.unitPrice || 0), 0);
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
        // (lifecycle status filter removed)
        setVendorTab(vendor.vendorPartyId);
        setExpanded(prev => {
            const next = new Set(prev);
            next.add(vendor.vendorPartyId);
            return next;
        });
    }, []);

    // ── render ─────────────────────────────────────────────────────────────
    return (
        <div className={embedded
            ? "h-full min-h-0 flex flex-col overflow-hidden"
            : "border-b border-zinc-800 shrink-0"
        }>
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
                                    { k: 'verify' as const, label: sendSteps.verify === 'verifying' ? '3. ✓ Email sent — verifying delivery…' : '3. Verify Finale state' },
                                ]).map(s => {
                                    const v = sendSteps[s.k];
                                    const icon = v === 'ok' ? <span className="text-emerald-400">✓</span>
                                        : v === 'fail' ? <span className="text-rose-400">✗</span>
                                        : v === 'skip' ? <span className="text-zinc-600">—</span>
                                        : v === 'verifying' ? <span className="text-cyan-400 animate-pulse">⟳</span>
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

            {/* ── Header ── cube icon + label + search + filters, outlined in thin white */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border border-zinc-300/40 rounded-md">
                <Package className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-200 uppercase tracking-widest">Ordering</span>
                <CrystalBallSearch onSelect={setSelectedItem} onVendorSelect={handleVendorSearchSelect} />
                {data && !scanning && <span className="text-[10px] text-[var(--dash-ts)] ml-auto mr-0 font-mono">{timeAgo(data.cachedAt)}</span>}
                {/* basauto third-opinion freshness — amber when the 07:00 recon cron failed and the comparison is stale */}
                {data && !scanning && (
                    <span
                        title={`basauto comparison crawled ${data.basautoReconAt ? new Date(data.basautoReconAt).toLocaleString([], { timeZone: "America/Denver" }) : "?"}${data.basautoReconStale ? " — STALE (recon cron overdue)" : ""}`}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${data.basautoReconStale
                            ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
                            : "text-violet-300 border-violet-500/25 bg-violet-500/5"}`}
                    >
                        BAS {data.basautoReconStale ? "stale" : "ok"}
                    </span>
                )}
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
                <span className="text-[10px] font-mono text-dash-l3 tracking-wider shrink-0 mr-1">WINDOW</span>
                {([
                    { k: "order_now" as const, label: "TODAY", count: orderNowCount, tone: "red" as const, title: "Items short within lead time (or already short with no PO coverage)" },
                    { k: "30" as const, label: "30", count: thirtyCount, tone: "amber" as const, title: "Show items projected short within 30 days" },
                    { k: "60" as const, label: "60", count: sixtyCount, tone: "default" as const, title: "Show items projected short within 60 days" },
                    { k: "90" as const, label: "90", count: ninetyCount, tone: "emerald" as const, title: "Show items projected short within 90 days" },
                    { k: "all" as const, label: "ALL", count: allCount, tone: "default" as const, title: "Every actionable item" },
                ]).map(b => (
                    <FilterChip
                        key={b.k}
                        label={b.label}
                        count={b.count}
                        active={focusFilter === b.k}
                        onClick={() => setFocusFilter(b.k)}
                        tone={b.tone}
                        title={b.title}
                    />
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

                {/* ORDER ALL: one-click drafts, commits, and sends all visible vendors.
                    No confirmation modal — hands off to Purchases panel. */}
                {(() => {
                    const filtered = activeGroups.map(g => ({
                        ...g,
                        items: g.items.filter(item => itemMatchesFocus(item) && itemMatchesLifecycle(item)),
                    })).filter(g => g.items.length > 0);
                    let vendorCount = 0;
                    for (const g of filtered) {
                        const sel = g.items.filter(i => !isSnoozed(i.productId) && canIncludeInDraftPO(i.reorderMethod) && i.suggestedQty > 0 && (i as any).assessment?.decision === 'order');
                        if (sel.length > 0) vendorCount++;
                    }
                    if (vendorCount === 0) return null;
                    return (
                        <ActionChip
                            label="ORDER ALL"
                            count={vendorCount}
                            onClick={() => handleCreateAllDrafts(filtered)}
                            disabled={anyCreating}
                            variant="primary"
                        />
                    );
                })()}
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
                {!embedded && (
                <button onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
                )}
            </div>

            {/* BAS-only strip: basauto flags SKUs Ordering has no row for (candidate
                gate / job supplies). Collapsed one-liner by default; expand for the
                high-severity list. Reason text on hover. */}
            {false && !effectivelyCollapsed && data && (data.basautoOnlyFlags?.length ?? 0) > 0 && (() => {
                const flags = data.basautoOnlyFlags!;
                const highCount = flags.filter(f => f.severity === "high").length;
                return (
                    <div className="border-b border-zinc-800/50 bg-zinc-950/60">
                        <button
                            onClick={() => setShowBasOnly(s => !s)}
                            className="w-full px-3 py-1 flex items-center gap-2 text-[10px] font-mono hover:bg-zinc-900/40 transition-colors"
                            title={showBasOnly ? "Collapse" : "SKUs basauto flags that have no row in Ordering"}
                        >
                            <span className="text-zinc-500 uppercase tracking-wider shrink-0">BAS only</span>
                            <span className={highCount > 0 ? "text-rose-300" : "text-violet-300"}>{flags.length} flagged</span>
                            {highCount > 0 && <span className="text-rose-300/90">{highCount} high</span>}
                            <span className="text-zinc-600 truncate">no Ordering row</span>
                            <ChevronDown className={`w-3 h-3 ml-auto shrink-0 transition-transform ${showBasOnly ? "" : "-rotate-90"}`} />
                        </button>
                        {showBasOnly && (
                            <div className="px-3 pb-2 space-y-1 max-h-56 overflow-y-auto">
                                {flags.map(f => (
                                    <div
                                        key={f.sku}
                                        title={f.reason}
                                        className={`flex items-center gap-2 pl-2 border-l-2 ${f.severity === "high" ? "border-rose-500/60" : "border-violet-500/40"}`}
                                    >
                                        <span className="font-semibold text-zinc-200">{f.sku}</span>
                                        <span className="text-zinc-500 truncate">{f.vendor ?? "no vendor"}</span>
                                        <span className={String(f.basauto.urgency ?? "").toUpperCase() === "OVERDUE" ? "text-rose-300" : "text-amber-300"}>
                                            {f.basauto.urgency ?? "?"}
                                        </span>
                                        {f.basauto.reorderQty != null && f.basauto.reorderQty > 0 && (
                                            <span className="text-zinc-400">reorder {f.basauto.reorderQty.toLocaleString()}</span>
                                        )}
                                        {f.basauto.stockDaysLeft != null && (
                                            <span className="text-zinc-600">{f.basauto.stockDaysLeft}d left</span>
                                        )}
                                        {f.description && <span className="text-zinc-600 truncate">{f.description}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* Accounting status — Ordering (separate from Active / Receivings) */}
            {!effectivelyCollapsed && data && (
                <div className="px-3 py-1 border-b border-zinc-800/50 bg-zinc-950/60 flex items-center gap-2 text-[10px] font-mono text-zinc-400">
                    <span className="text-zinc-600 uppercase tracking-wider shrink-0">Buy</span>
                    {orderNowCount > 0 ? (
                        <>
                            <span className="text-rose-300">{orderNowCount} SKU due</span>
                            {orderNowDollars > 0 && (
                                <span className="text-rose-200/90">${Math.round(orderNowDollars).toLocaleString()}</span>
                            )}
                        </>
                    ) : (
                        <span className="text-emerald-400/80">$0 due today</span>
                    )}
                    <span className="text-zinc-700">·</span>
                    <span>{activeGroups.length} vendor{activeGroups.length === 1 ? "" : "s"}</span>
                    {hiddenItemCount > 0 && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span className="text-zinc-500">{hiddenItemCount} snoozed</span>
                        </>
                    )}
                </div>
            )}

            {!effectivelyCollapsed && (
                <div className={embedded ? "flex-1 min-h-0 flex flex-col overflow-hidden" : undefined}>
                    {selectedItem ? (
                        <>
                            <div
                                className={embedded ? "flex-1 min-h-0 overflow-y-auto" : "overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full font-mono"}
                                style={embedded ? undefined : { height: bodyHeight }}
                            >
                                <CrystalBallDetail 
                                    item={selectedItem} 
                                    onClose={() => setSelectedItem(null)} 
                                    onCommitPO={handleReviewAndSend}
                                />
                            </div>

                            {!embedded && (
                            <div onMouseDown={startResize}
                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                title="Drag to resize" />
                            )}
                        </>
                    ) : (
                        <>
                    {/* ── Vendor dropdown combobox ── replaces horizontal tab strip */}
                    {focusGroups.length > 0 && (
                        <div className="relative border-b border-zinc-800/60 bg-zinc-950/30 px-3 py-1.5" ref={vendorDropdownRef}>
                            <div className="flex items-center gap-2">
                                {/* Dropdown trigger button */}
                                <button
                                    onClick={() => setVendorDropdownOpen(!vendorDropdownOpen)}
                                    className={`flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded border transition-colors ${
                                        vendorTab === "all"
                                            ? "border-zinc-300/60 text-zinc-100 bg-zinc-900/50 hover:bg-zinc-800/60 hover:border-zinc-200"
                                            : "border-zinc-300/80 text-zinc-50 bg-zinc-800/50 hover:bg-zinc-700/60 hover:border-zinc-100"
                                    }`}
                                >
                                    {vendorTab === "all" ? (
                                        <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0" />
                                            <span>All Vendors</span>
                                            <span className="text-zinc-500">{focusGroups.length}</span>
                                        </>
                                    ) : (
                                        (() => {
                                            const g = focusGroups.find(v => v.vendorPartyId === vendorTab);
                                            const cfg = g ? URGENCY[g.urgency] : URGENCY.ok;
                                            const hasPO = g ? !!createdPOs[g.vendorPartyId] : false;
                                            return (
                                                <>
                                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                                                    <span>{g ? g.vendorName : "…"}</span>
                                                    {hasPO && <span className="text-emerald-500">✓</span>}
                                                </>
                                            );
                                        })()
                                    )}
                                    <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${vendorDropdownOpen ? "rotate-180" : ""}`} />
                                </button>

                                {/* Quick summary when a specific vendor is selected */}
                                {vendorTab !== "all" && (() => {
                                    const g = focusGroups.find(v => v.vendorPartyId === vendorTab);
                                    if (!g || g.items.length === 0) return null;
                                    const earliestRunway = Math.min(...g.items.map(getEffectiveShortageDays));
                                    const totalNeed = g.items.reduce((s, i) => s + (i.suggestedQty || 0) * (i.unitPrice || 0), 0);
                                    const leadTime = g.items[0]?.leadTimeDays ?? 0;
                                    const selectedCount = g.items.filter(i => checked[g.vendorPartyId]?.[i.productId]).length;
                                    return (
                                        <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-500">
                                            <span>{g.items.length} SKUs</span>
                                            <span className={earliestRunway < 14 ? "text-red-400" : earliestRunway < 45 ? "text-yellow-400" : ""}>
                                                {Number.isFinite(earliestRunway) ? `${Math.round(earliestRunway)}d runway` : "—"}
                                            </span>
                                            <span>lead {leadTime}d</span>
                                            <span className="text-zinc-300">${totalNeed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                            {selectedCount > 0 && <span className="text-emerald-400">{selectedCount} selected</span>}
                                        </div>
                                    );
                                })()}

                                {/* "Show all" quick-action when filtered to a vendor */}
                                {vendorTab !== "all" && (
                                    <button
                                        onClick={() => { setVendorTab("all"); setExpanded(new Set()); }}
                                        className="text-[10px] font-mono text-zinc-600 hover:text-zinc-300 transition-colors ml-auto"
                                    >
                                        ← All vendors
                                    </button>
                                )}
                            </div>

                            {/* Dropdown panel */}
                            {vendorDropdownOpen && (
                                <div className="absolute left-0 right-0 z-50 mt-1 mx-2 border border-zinc-700/60 bg-zinc-950 rounded-lg shadow-2xl shadow-black/60 max-h-[420px] flex flex-col overflow-hidden">
                                    {/* Search header */}
                                    <div className="px-3 py-2 border-b border-zinc-800/80 flex items-center gap-2 bg-zinc-900/50 shrink-0">
                                        <Search className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                                        <input
                                            ref={vendorSearchRef}
                                            type="text"
                                            value={vendorSearchQuery}
                                            onChange={e => setVendorSearchQuery(e.target.value)}
                                            placeholder="Search vendors…"
                                            className="flex-1 bg-transparent border-none text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none"
                                            onKeyDown={e => {
                                                if (e.key === "Escape") {
                                                    setVendorDropdownOpen(false);
                                                    setVendorSearchQuery("");
                                                }
                                                if (e.key === "Enter") {
                                                    const filtered = vendorDropdownItems;
                                                    if (filtered.length === 1) {
                                                        setVendorTab(filtered[0].vendorPartyId);
                                                        setExpanded(prev => { const n = new Set(prev); n.add(filtered[0].vendorPartyId); return n; });
                                                        setVendorDropdownOpen(false);
                                                        setVendorSearchQuery("");
                                                    }
                                                }
                                            }}
                                        />
                                        <span className="text-[9px] text-zinc-600 shrink-0">
                                            {vendorSearchQuery ? `${vendorDropdownItems.length} match` : `${focusGroups.length} vendors`}
                                        </span>
                                    </div>

                                    {/* Scrollable vendor list */}
                                    <div className="overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-zinc-800 [&::-webkit-scrollbar-thumb]:rounded-full">
                                        {/* "All Vendors" option */}
                                        <button
                                            onClick={() => {
                                                setVendorTab("all");
                                                setExpanded(new Set());
                                                setVendorDropdownOpen(false);
                                                setVendorSearchQuery("");
                                            }}
                                            className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-zinc-800/40 transition-colors border-b border-zinc-900/60 ${
                                                vendorTab === "all" ? "bg-zinc-800/30 text-zinc-100" : "text-zinc-400"
                                            }`}
                                        >
                                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
                                            <span className="text-xs font-mono font-semibold flex-1">All Vendors</span>
                                            <span className="text-[10px] font-mono text-zinc-600">{focusGroups.length}</span>
                                        </button>

                                        {/* Vendor rows */}
                                        {vendorDropdownItems.map(g => {
                                            const cfg = URGENCY[g.urgency];
                                            const isActive = vendorTab === g.vendorPartyId;
                                            const hasPO = !!createdPOs[g.vendorPartyId];
                                            const vSnoozed = !hasPO && vendorSnoozed(g);
                                            const checkedCount = g.items.filter(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId]).length;
                                            const earliestRunway = g.items.length > 0
                                                ? Math.min(...g.items.map(getEffectiveShortageDays))
                                                : null;
                                            const leadTime = g.items.length > 0 ? (g.items[0].leadTimeDays ?? 0) : 0;
                                            const totalNeed = g.items.reduce((s, i) => s + (i.suggestedQty || 0) * (i.unitPrice || 0), 0);
                                            const totalOnHand = g.items.reduce((s, i) => s + (i.stockOnHand || 0), 0);
                                            const totalOnOrder = g.items.reduce((s, i) => s + (i.stockOnOrder || 0), 0);
                                            const topSkus = g.items.slice(0, 3).map(i => i.productId);
                                            const criticalItems = g.items.filter(i => i.urgency === "critical").length;

                                            return (
                                                <button
                                                    key={g.vendorPartyId}
                                                    onClick={() => {
                                                        setVendorTab(g.vendorPartyId);
                                                        setExpanded(prev => { const n = new Set(prev); n.add(g.vendorPartyId); return n; });
                                                        setVendorDropdownOpen(false);
                                                        setVendorSearchQuery("");
                                                    }}
                                                    className={`w-full text-left px-3 py-2 flex flex-col gap-1 hover:bg-zinc-800/40 transition-colors border-b border-zinc-900/40 ${
                                                        vSnoozed ? "opacity-30" : ""
                                                    } ${isActive ? "bg-zinc-800/30" : ""}`}
                                                >
                                                    {/* Row 1: vendor name + urgency + SKU count */}
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-2 h-2 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                                        <span className={`text-xs font-mono font-semibold flex-1 truncate ${vSnoozed ? "line-through text-zinc-700" : isActive ? "text-zinc-100" : "text-zinc-300"}`}>
                                                            {g.vendorName}
                                                        </span>
                                                        {hasPO && <span className="text-[10px] text-emerald-500 font-mono">✓ PO sent</span>}
                                                        {checkedCount > 0 && !hasPO && (
                                                            <span className="text-[10px] font-mono bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full border border-zinc-700">
                                                                {checkedCount} sel
                                                            </span>
                                                        )}
                                                        {criticalItems > 0 && !hasPO && (
                                                            <span className="text-[9px] font-mono text-red-400 bg-red-500/10 px-1 py-0.5 rounded border border-red-500/20">
                                                                {criticalItems} CRIT
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Row 2: data metrics */}
                                                    <div className="flex items-center gap-3 text-[9px] font-mono pl-4">
                                                        <span className="text-zinc-500">{g.items.length} SKUs</span>
                                                        {Number.isFinite(earliestRunway ?? NaN) && (
                                                            <span className={
                                                                (earliestRunway ?? 999) < leadTime
                                                                    ? "text-red-400 font-semibold"
                                                                    : (earliestRunway ?? 999) < 30
                                                                    ? "text-amber-400"
                                                                    : "text-zinc-500"
                                                            }>
                                                                {Math.round(earliestRunway ?? 0)}d runway
                                                            </span>
                                                        )}
                                                        <span className="text-zinc-600">lead {leadTime}d</span>
                                                        <span className="text-zinc-500">
                                                            on-hand {totalOnHand.toLocaleString()}
                                                        </span>
                                                        {totalOnOrder > 0 && (
                                                            <span className="text-emerald-600">+{totalOnOrder.toLocaleString()} on order</span>
                                                        )}
                                                        <span className="text-zinc-400 font-semibold ml-auto">
                                                            ${totalNeed.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                        </span>
                                                    </div>

                                                    {/* Row 3: affected SKUs */}
                                                    {topSkus.length > 0 && (
                                                        <div className="flex items-center gap-1 pl-4">
                                                            <span className="text-[8px] font-mono text-zinc-700">affects</span>
                                                            {topSkus.map(sku => (
                                                                <span key={sku} className="text-[8px] font-mono text-zinc-600 bg-zinc-900 px-1 py-0.5 rounded border border-zinc-800 truncate max-w-[80px]">
                                                                    {sku}
                                                                </span>
                                                            ))}
                                                            {g.items.length > 3 && (
                                                                <span className="text-[8px] text-zinc-700">+{g.items.length - 3} more</span>
                                                            )}
                                                        </div>
                                                    )}
                                                </button>
                                            );
                                        })}

                                        {/* Empty state */}
                                        {vendorDropdownItems.length === 0 && vendorSearchQuery && (
                                            <div className="px-4 py-6 text-center text-[10px] font-mono text-zinc-600">
                                                No vendors matching "{vendorSearchQuery}"
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
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
                                    {scanning ? "Re-scanning Finale…" : "Loading purchasing data…"}
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
                                className={embedded ? "flex-1 min-h-0 overflow-y-auto" : "overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full"}
                                style={embedded ? undefined : { height: bodyHeight }}
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
                                            text: cycleBadgeText(vendorCycle),
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
                                            {/* ── Simplified row: vendor · urgency · items · $ · [Quick Draft] ▾ */}
                                            <div className="flex items-center gap-2 px-4 py-2 hover:bg-zinc-800/30 transition-colors">
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                                <span className={`text-sm font-mono font-semibold ${vSnoozed ? "line-through text-zinc-600" : "text-zinc-100"}`}>
                                                    {group.vendorName}
                                                </span>
                                                {!vSnoozed && !isNeverAutonomous(group.vendorName) && !isAmazonVendor(group.vendorName) && (
                                                    <label
                                                        className="flex items-center gap-1 text-[10px] font-mono text-zinc-500 shrink-0"
                                                        title="Overnight auto-draft. Drafts only, never sends."
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={(autonomyOverride[group.vendorName] ?? group.autonomyLevel ?? 0) >= 1}
                                                            onChange={(e) => toggleVendorAutoDraft(group.vendorName, e.target.checked)}
                                                            className="w-3 h-3 rounded accent-emerald-500"
                                                        />
                                                        auto
                                                    </label>
                                                )}
                                                <span className="text-[10px] font-mono text-zinc-500">
                                                    {activeItems.slice(0, 4).map((i, idx) => (
                                                        <span key={i.productId}>
                                                            {idx > 0 && ', '}
                                                            <span className="text-zinc-400">{i.productId}</span>
                                                            <span className="text-zinc-600">({i.suggestedQty}</span>
                                                            {i.adjustedRunwayDays != null && <span className="text-zinc-600">·{(i.adjustedRunwayDays ?? 0).toFixed(0)}d</span>}
                                                            <span className="text-zinc-600">)</span>
                                                        </span>
                                                    ))}
                                                    {activeItems.length > 4 && <span className="text-zinc-600"> +{activeItems.length - 4} more</span>}
                                                    <span className="text-zinc-400 ml-1">
                                                        ${activeItems.reduce((s, i) => s + (i.suggestedQty || 0) * Math.max(0, i.unitPrice || 0), 0).toLocaleString(undefined, {maximumFractionDigits: 0})}
                                                    </span>
                                                </span>
                                                <div className="flex-1" />
                                                {(() => {
                                                    // Draft success: show PO # + Send button
                                                    if (createdPOs[pid] && !completedVendors.has(pid)) {
                                                        return (
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <span className="text-[10px] font-mono text-amber-300 px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10">
                                                                    {formatPoDraftLabel(createdPOs[pid].orderId)}
                                                                </span>
                                                                <a
                                                                    href={createdPOs[pid].finaleUrl}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="text-[10px] font-mono font-bold px-2 py-1 rounded border border-zinc-600 bg-zinc-800/40 hover:bg-zinc-700/50 text-zinc-200"
                                                                    title="Open in Finale — send from there"
                                                                >Finale</a>
                                                                {preemptByVendor[pid] > 0 && (
                                                                    <span className="text-[10px] font-mono text-zinc-500 shrink-0">+{preemptByVendor[pid]} preempt</span>
                                                                )}
                                                            </div>
                                                        );
                                                    }
                                                    // Order button: only when something still needs ordering (not already on open/draft PO)
                                                                                                        const orderableItems = selectForwardPoLines({
                                                                                                            items: activeItems,
                                                                                                            focus: focusFilter,
                                                                                                            qtyOverrides: groupQtys,
                                                                                                            isSnoozed,
                                                                                                            isCovered: itemIsCovered,
                                                                                                        });
                                                                                                        const coveredOnly = activeItems.length > 0 && orderableItems.length === 0
                                                                                                            && activeItems.some(i => itemIsCovered(i) || !!i.draftPO || (i.openPOs?.length ?? 0) > 0);
                                                                                                        if (!vSnoozed && coveredOnly) {
                                                                                                            const todayDraft = activeItems.find(i => isAutoDraftToday(i.draftPO))?.draftPO;
                                                                                                            if (!todayDraft) return null;
                                                                                                            return (
                                                                                                                <span
                                                                                                                    className="text-[10px] font-mono px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0"
                                                                                                                    title="Auto-drafted today. Send from Finale."
                                                                                                                >
                                                                                                                    {formatPoDraftLabel(todayDraft.orderId)}
                                                                                                                </span>
                                                                                                            );
                                                                                                        }
                                                                                                        if (!vSnoozed && orderableItems.length > 0) {
                                                                                                            const wasInspected = expanded.has(pid);
                                                                                                            return (
                                                                                                                <button
                                                                                                                    onClick={() => handleCreateOne(group, true)}
                                                                                                                    disabled={anyCreating}
                                                                                                                    className="text-[10px] font-mono px-2 py-1 rounded border bg-emerald-900/30 hover:bg-emerald-800/40 text-emerald-300 border-emerald-800 transition-colors disabled:opacity-40 shrink-0"
                                                                                                                    title="Draft in Finale — send from Finale"
                                                                                                                >
                                                                                                                    Order
                                                                                                                </button>
                                                                                                            );
                                                                                                        }
                                                    return null;
                                                })()}
                                                <button onClick={() => toggleExpand(pid)}
                                                    className="text-[10px] font-mono px-1.5 py-1 rounded border bg-transparent text-zinc-600 border-zinc-800 hover:text-zinc-400 shrink-0">
                                                    ▾
                                                </button>
                                            </div>
                                            {false && isExpanded && (
                                                <VendorOutlookBar
                                                    vendorPartyId={pid}
                                                    vendorName={group.vendorName}
                                                    initial={outlookByVendor[pid] ?? (() => {
                                                        const decoded = decodeOutlookNotes(activeItems[0]?.vendorPolicy?.notes ?? null);
                                                        return {
                                                            notes: decoded.notes,
                                                            holdUntilDate: decoded.holdUntilDate,
                                                            leadTimeOverrideDays: activeItems[0]?.vendorPolicy?.leadTimeOverrideDays ?? null,
                                                            targetCoverDays: activeItems[0]?.vendorPolicy?.targetCoverDays ?? null,
                                                            truckQty: null,
                                                        };
                                                    })()}
                                                    onSaved={(next) => setOutlookByVendor(p => ({ ...p, [pid]: next }))}
                                                />
                                            )}

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
                                                                {sentPOs.has(po.orderId) && (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                )}
                                                            </div>
                                                        ) : null}
                                                    </div>

                                                    {sortItemsByNeed(group.items)
                                                        .filter(item => showSnoozed || !isSnoozed(item.productId))
                                                        .map(item => {
                                                            const itemSnoozed = isSnoozed(item.productId);
                                                                                                                        const hasOpenPo = (item.openPOs?.length ?? 0) > 0;
                                                                                                                        const coveredByOpenPo = itemIsCovered(item)
                                                                                                                            || (hasOpenPo
                                                                                                                                && item.assessment?.decision === "hold"
                                                                                                                                && ((item.assessment?.reasonCodes ?? []).includes("on_order_already_covers_need")
                                                                                                                                    || (item.assessment?.reasonCodes ?? []).includes("recent_draft_exists")));
                                                                                                                        const draftBlocked = !canIncludeInDraftPO(item.reorderMethod) || !!item.draftPO || coveredByOpenPo;
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
                                                                                                                                                            title={item.draftPO
                                                                                                                                                                ? `Draft PO #${item.draftPO.orderId} already exists`
                                                                                                                                                                : coveredByOpenPo
                                                                                                                                                                    ? `Already on PO #${item.openPOs?.[0]?.orderId ?? "?"} — blocked to prevent duplicate`
                                                                                                                                                                    : undefined}
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
                                                                                {!itemSnoozed && isAutoDraftToday(item.draftPO) && item.draftPO && (
                                                                                    <a
                                                                                        href={item.draftPO.finaleUrl}
                                                                                        target="_blank"
                                                                                        rel="noreferrer"
                                                                                        onClick={(e) => e.stopPropagation()}
                                                                                        className="text-[10px] font-mono border rounded px-1 shrink-0 text-amber-300 border-amber-500/40 bg-amber-500/10 hover:border-amber-400"
                                                                                        title="Auto-drafted today"
                                                                                    >
                                                                                        {formatPoDraftLabel(item.draftPO.orderId)}
                                                                                    </a>
                                                                                )}

                                                                                <div className="flex-1" />
                                                                                {!itemSnoozed && (() => {
                                                                                    const effective = getEffectiveShortageDays(item);
                                                                                    return (
                                                                                        <span className={`text-xs font-mono shrink-0 ${rc}`}>
                                                                                            {Number.isFinite(effective) ? `${Math.round(effective)}d` : "—"}
                                                                                        </span>
                                                                                    );
                                                                                })()}

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
                                                                                            <button
                                                                                                type="button"
                                                                                                key={openPo.orderId}
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    lifecycle.setLockedFocus({
                                                                                                        source: "ordering",
                                                                                                        vendorName: group.vendorName,
                                                                                                        orderId: openPo.orderId,
                                                                                                        productIds: [item.productId],
                                                                                                    });
                                                                                                    lifecycle.requestScrollToOrder(openPo.orderId, "ordering");
                                                                                                }}
                                                                                                className={`flex items-center gap-2 text-[10.5px] font-mono px-2 py-1 rounded border w-full text-left cursor-pointer hover:brightness-110 ${chipClass}`}
                                                                                                title={`Jump to PO #${openPo.orderId} in Active Purchases`}
                                                                                            >
                                                                                                <span className="font-semibold shrink-0 text-cyan-200">Already ordered · PO {openPo.orderId}</span>
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
                                                                                                {/* Stuck/blocked next-action guidance */}
                                                                                                {(detail && (
                                                                                                    detail.lifecycleStage === "noncomm" ||
                                                                                                    detail.lifecycleStage === "tracking_unavailable" ||
                                                                                                    detail.lifecycleStage === "human_escalated" ||
                                                                                                    detail.lifecycleStage === "ap_follow_up" ||
                                                                                                    detail.lifecycleStage === "stalled" ||
                                                                                                    (detail.lifecycleStage === "delivered" && !detail.isReceived)
                                                                                                )) && (() => {
                                                                                                    if (detail!.lifecycleStage === "delivered" && !detail!.isReceived) {
                                                                                                        return (
                                                                                                            <span className="text-[10px] font-mono shrink-0 text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1 ml-auto" title="Carrier shows delivered but Finale has no receipt. Verify physical receipt and mark received.">
                                                                                                                ✅ Verify receipt →
                                                                                                            </span>
                                                                                                        );
                                                                                                    }
                                                                                                    const stuckMeta = STUCK_LABELS[detail!.lifecycleStage!];
                                                                                                    if (stuckMeta) {
                                                                                                        return (
                                                                                                            <span className={`text-[10px] font-mono shrink-0 rounded px-1 ml-auto ${stuckMeta.tone}`} title={`Stuck: ${stuckMeta.action}.`}>
                                                                                                                🚫 {stuckMeta.action}
                                                                                                            </span>
                                                                                                        );
                                                                                                    }
                                                                                                    return null;
                                                                                                })()}
                                                                                                <span className="text-[9px] text-cyan-400/70 shrink-0 ml-auto">→ Purchases</span>
                                                                                            </button>
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
                                                                                                {orderByDays <= 0 ? '⚠ TODAY — window closed' : `order by ${orderByDate}`}
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
                                                                                        {((item.finaleReorderQty ?? 0) > 0 || item.basautoRecon) && (
                                                                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                                                                {item.basautoRecon && item.basautoRecon.basautoQty != null && (
                                                                                                    <>
                                                                                                        <span
                                                                                                            title={`${item.basautoRecon.live ? "live verdict · " : ""}basauto (${item.basautoRecon.basautoUrgency ?? 'n/a'}) wants ${item.basautoRecon.basautoQty}. ${item.basautoRecon.reason}${item.basautoRecon.crawledAt ? ` · crawled ${new Date(item.basautoRecon.crawledAt).toLocaleString([], { timeZone: 'America/Denver' })}` : ''}`}
                                                                                                            className="text-[11px] font-mono italic text-violet-300"
                                                                                                        >
                                                                                                            basauto: {item.basautoRecon.basautoQty}
                                                                                                        </span>
                                                                                                        <span className="text-zinc-600 text-[10px]">·</span>
                                                                                                    </>
                                                                                                )}
                                                                                                {(item.finaleReorderQty ?? 0) > 0 && (
                                                                                                    <>
                                                                                                        <span className={`text-[11px] font-mono italic ${item.qtyDiverged ? 'text-amber-300' : 'text-cyan-300'}`}>
                                                                                                            Finale: {item.finaleReorderQty}
                                                                                                        </span>
                                                                                                        <span className="text-zinc-600 text-[10px]">→</span>
                                                                                                    </>
                                                                                                )}
                                                                                                <span className={`text-[11px] font-mono font-semibold ${item.qtyDiverged ? 'text-emerald-300' : 'text-zinc-200'}`}>
                                                                                                    Aria: {item.suggestedQty}
                                                                                                </span>
                                                                                                {item.qtyDiverged && item.qtyDivergencePct != null && (
                                                                                                    <span className="text-[9px] font-mono text-amber-400 border border-amber-500/20 rounded px-1">
                                                                                                        ⚠ {Math.abs(item.qtyDivergencePct)}% diff
                                                                                                    </span>
                                                                                                )}
                                                                                                {item.basautoRecon && (
                                                                                                    <span
                                                                                                        title={`${item.basautoRecon.live ? "live verdict · " : ""}${item.basautoRecon.reason}${item.basautoRecon.crawledAt ? ` · crawled ${new Date(item.basautoRecon.crawledAt).toLocaleString([], { timeZone: 'America/Denver' })}` : ''}`}
                                                                                                        className={`text-[9px] font-mono rounded px-1 border ${item.basautoRecon.severity === 'high'
                                                                                                            ? 'text-red-300 border-red-500/30'
                                                                                                            : 'text-violet-300 border-violet-500/25'}`}
                                                                                                    >
                                                                                                        {item.basautoRecon.verdict.replace(/_/g, ' ').toLowerCase()}
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

                                                                            {/* Row 4: one-line draft justification + Why drawer */}
                                                                            {!itemSnoozed && (
                                                                                <div className="mt-2 space-y-1">
                                                                                    <div className="flex items-start justify-between gap-2">
                                                                                        <div className="text-[11px] font-mono text-zinc-400 flex-1">
                                                                                            {orderDraftJustification({
                                                                                                suggestedQty: item.suggestedQty,
                                                                                                lastPurchaseQty: item.lastPurchaseQty,
                                                                                                runwayDays: item.runwayDays,
                                                                                                leadTimeDays: item.effectiveLeadTimeDays ?? item.leadTimeDays,
                                                                                                dailyRate: item.dailyRate,
                                                                                                draftPO: item.draftPO ?? null,
                                                                                                recommendation: item.recommendation ?? null,
                                                                                            })}
                                                                                        </div>
                                                                                        {item.recommendation && (
                                                                                            <button
                                                                                                onClick={(e) => { e.stopPropagation(); toggleWhy(`${pid}:${item.productId}`); }}
                                                                                                className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 shrink-0"
                                                                                                title="Show full reorder math trace"
                                                                                            >
                                                                                                {whyOpen.has(`${pid}:${item.productId}`) ? "Hide" : "Why"}
                                                                                            </button>
                                                                                        )}
                                                                                        {item.draftPO && (
                                                                                            <button
                                                                                                onClick={(e) => { e.stopPropagation(); handleCancelDraft(item.draftPO!.orderId); }}
                                                                                                className="text-[10px] font-mono text-zinc-600 hover:text-rose-300 shrink-0"
                                                                                                title="Cancel this draft in Finale"
                                                                                            >
                                                                                                Cancel
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

                            {!embedded && (
                            <div onMouseDown={startResize}
                                                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                                                title="Drag to resize" />
                            )}
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
                </div>
            )}

            {/* ── Phase 2: Decision Dossier flyout ── agentic audit surface over Ordering column */}
            {flyoutPayload && (
                <VendorDecisionFlyout
                    open={flyoutPid !== null}
                    onClose={() => setFlyoutPid(null)}
                    group={flyoutPayload.group}
                    selectedCount={flyoutPayload.selectedCount}
                    selectedUnits={flyoutPayload.selectedUnits}
                    selectedValue={flyoutPayload.selectedValue}
                    hasDraftPO={flyoutPayload.hasDraftPO}
                    vendorCycleBadge={flyoutPayload.vendorCycleBadge}
                />
            )}
        </div>
    );
}
