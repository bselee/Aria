/**
 * @file    VendorDecisionFlyout.tsx
 * @purpose Phase 2 of ordering kanban: Decision Dossier flyout for agentic audit surface.
 *          Right-side flyout panel showing why Aria recommended a draft PO for a vendor.
 *          Two tabs: "Decision" (agentic audit) and "PO Lineage" (cross-column linking).
 * @author  Hermia
 * @created 2026-06-12
 * @deps    react, lucide-react, PurchasingLifecycleContext
 */

"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    X,
    ChevronRight,
    Package,
    ArrowRight,
    Circle,
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
} from "lucide-react";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";

// ── types (self-contained, mirrors PurchasingPanel) ────────────────────────

type UrgencyTier = "critical" | "warning" | "watch" | "ok";

type PurchasingItem = {
    productId: string;
    productName: string;
    supplierName: string;
    supplierPartyId: string;
    unitPrice: number;
    stockOnHand: number;
    stockOnOrder: number;
    purchaseVelocity: number;
    salesVelocity: number;
    demandVelocity: number;
    dailyRate: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;
    leadTimeProvenance: string;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    urgency: UrgencyTier;
    explanation: string;
    suggestedQty: number;
    orderIncrementQty: number | null;
    isBulkDelivery: boolean;
    finaleReorderQty: number | null;
    finaleStockoutDays: number | null;
    finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;
    reorderMethod?: string;
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
    candidate?: {
        directDemand: number;
        bomDemand: number;
        finishedGoodsCoverageDays?: number | null;
    };
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
    roundingMethod?: string | null;
    roundingAlternatives?: number[];
    itemType?: "resale" | "bom-component" | "resale-bom";
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    totalBurnRate?: number;
    medianPOGapDays?: number;
    projectedNextOrderDate?: string;
    receiptConfidence?: "high" | "medium" | "low";
    triggerReason?:
        | "build-driven"
        | "stockout-padded"
        | "runway-short"
        | "cadence"
        | null;
    triggerDetail?: string;
    lastPurchaseDate?: string | null;
    lastPurchaseQty?: number | null;
    isBulkVendor?: boolean;
};

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
    lifecycleStage?: string;
    lifecycleSummary?: string;
};

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    receiveDate: string;
    receiveDateTime?: string;
    receivedBy?: string | null;
    receiptStatus?: "full" | "partial" | "received";
    supplier: string;
    total: number;
    items: Array<{
        productId: string;
        quantity: number;
        orderedQuantity?: number;
        receivedQuantity?: number;
        openQuantity?: number;
    }>;
    receiptHistory?: Array<{
        shipmentId: string;
        receiveDate: string;
        receiveDateTime: string;
        receivedBy?: string | null;
        items: Array<{ productId: string; quantity: number }>;
    }>;
    finaleUrl: string;
};

// ── props ──────────────────────────────────────────────────────────────────

export interface VendorDecisionFlyoutProps {
    open: boolean;
    onClose: () => void;
    group: {
        vendorName: string;
        vendorPartyId: string;
        urgency: UrgencyTier;
        items: PurchasingItem[];
    };
    selectedCount: number;
    selectedUnits: number;
    selectedValue: number;
    hasDraftPO: boolean;
    vendorCycleBadge: { text: string; className: string } | null;
}

// ── constants (mirrors PurchasingPanel) ────────────────────────────────────

const URGENCY = {
    critical: {
        badge: "bg-red-500/20 text-red-300 border-red-500/40",
        dot: "bg-red-500",
        label: "CRIT",
    },
    warning: {
        badge: "text-amber-400",
        dot: "bg-amber-400",
        label: "WARN",
    },
    watch: {
        badge: "text-zinc-500",
        dot: "bg-emerald-500",
        label: "WTCH",
    },
    ok: {
        badge: "",
        dot: "bg-zinc-600",
        label: "",
    },
} as const;

function runwayColor(days: number): string {
    if (days < 14) return "text-red-400 font-semibold";
    if (days < 45) return "text-yellow-400 font-semibold";
    if (days < 90) return "text-green-400";
    return "text-zinc-500";
}

// ── helpers ────────────────────────────────────────────────────────────────

function confidenceColor(
    confidence: "high" | "medium" | "low" | undefined
): { text: string; bg: string } {
    switch (confidence) {
        case "high":
            return { text: "text-emerald-400", bg: "bg-emerald-500/10" };
        case "medium":
            return { text: "text-amber-400", bg: "bg-amber-500/10" };
        case "low":
            return { text: "text-red-400", bg: "bg-red-500/10" };
        default:
            return { text: "text-zinc-400", bg: "bg-zinc-800" };
    }
}

function decisionBadge(decision: string): { text: string; bg: string } {
    switch (decision) {
        case "order":
            return {
                text: "text-emerald-300",
                bg: "bg-emerald-500/15 border-emerald-500/30",
            };
        case "reduce":
            return {
                text: "text-amber-300",
                bg: "bg-amber-500/15 border-amber-500/30",
            };
        case "hold":
            return {
                text: "text-zinc-400",
                bg: "bg-zinc-700/30 border-zinc-700/40",
            };
        case "manual_review":
            return {
                text: "text-red-300",
                bg: "bg-red-500/15 border-red-500/30",
            };
        default:
            return {
                text: "text-zinc-400",
                bg: "bg-zinc-800 border-zinc-700",
            };
    }
}

function commitGuardPill(decision: string | undefined): {
    text: string;
    bg: string;
} {
    switch (decision) {
        case "commit":
            return {
                text: "text-emerald-400",
                bg: "bg-emerald-500/10 border-emerald-500/20",
            };
        case "draft_only":
            return {
                text: "text-amber-400",
                bg: "bg-amber-500/10 border-amber-500/20",
            };
        case "block":
            return {
                text: "text-red-400",
                bg: "bg-red-500/10 border-red-500/20",
            };
        default:
            return { text: "text-zinc-500", bg: "bg-zinc-800 border-zinc-700" };
    }
}

function fmtDollars(n: number): string {
    if (!n || n <= 0) return "$0";
    return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtNumber(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// ── sub-components ─────────────────────────────────────────────────────────

/** Compact provenance chain: "velocity 2.4/d -> needed 180 for 75d -> rounded to 180" */
function ProvenanceChain({
    provenance,
}: {
    provenance: Array<{ step: string; detail: string; value?: number | string }>;
}) {
    if (!provenance || provenance.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-0.5 text-[10px] font-mono text-zinc-500 leading-tight">
            {provenance.map((p, i) => (
                <React.Fragment key={i}>
                    {i > 0 && (
                        <ArrowRight className="w-2.5 h-2.5 text-zinc-700 shrink-0 mx-0.5" />
                    )}
                    <span className="text-zinc-400">{p.detail}</span>
                </React.Fragment>
            ))}
        </div>
    );
}

// ── main component ─────────────────────────────────────────────────────────

export default function VendorDecisionFlyout({
    open,
    onClose,
    group,
    selectedCount,
    selectedUnits,
    selectedValue,
    hasDraftPO,
    vendorCycleBadge,
}: VendorDecisionFlyoutProps) {
    const lifecycle = usePurchasingLifecycle();
    const [activeTab, setActiveTab] = useState<"decision" | "lineage">("decision");

    // PO Lineage state
    const [openPOs, setOpenPOs] = useState<ActivePurchase[]>([]);
    const [receipts, setReceipts] = useState<ReceivedPO[]>([]);
    const [lineageLoading, setLineageLoading] = useState(false);
    const [lineageError, setLineageError] = useState<string | null>(null);

    // Guardrail summary collapse state
    const [guardrailOpen, setGuardrailOpen] = useState(false);

    // Reset tab when flyout opens/closes
    useEffect(() => {
        if (open) {
            setActiveTab("decision");
            setGuardrailOpen(false);
        }
    }, [open]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [open, onClose]);

    // Fetch PO Lineage data when tab or vendor changes
    useEffect(() => {
        if (!open || activeTab !== "lineage") return;

        setLineageLoading(true);
        setLineageError(null);

        Promise.all([
            fetch("/api/dashboard/active-purchases").then(
                (r) => r.json() as Promise<{ purchases: ActivePurchase[] }>
            ),
            fetch("/api/dashboard/receivings?days=30").then(
                (r) => r.json() as Promise<{ received: ReceivedPO[] }>
            ),
        ])
            .then(([purchasesRes, receivingsRes]) => {
                const filteredPOs = (purchasesRes.purchases ?? []).filter(
                    (po) =>
                        po.vendorName?.toLowerCase() ===
                        group.vendorName.toLowerCase()
                );
                const filteredReceipts = (receivingsRes.received ?? []).filter(
                    (rcpt) =>
                        rcpt.supplier?.toLowerCase() ===
                        group.vendorName.toLowerCase()
                );
                setOpenPOs(filteredPOs);
                setReceipts(filteredReceipts);
            })
            .catch((err) => {
                console.error("Failed to fetch PO lineage:", err);
                setLineageError("Failed to load PO lineage data.");
            })
            .finally(() => setLineageLoading(false));
    }, [open, activeTab, group.vendorName]);

    // ── computed values ────────────────────────────────────────────────────

    // Agent confidence from items
    const confidenceCounts = useMemo(() => {
        const counts = { high: 0, medium: 0, low: 0 };
        for (const item of group.items) {
            const c = item.assessment?.confidence;
            if (c === "high") counts.high++;
            else if (c === "medium") counts.medium++;
            else if (c === "low") counts.low++;
        }
        return counts;
    }, [group.items]);

    const majorityConfidence = useMemo((): "high" | "medium" | "low" => {
        const total = group.items.length;
        if (total === 0) return "medium";
        if (confidenceCounts.high > total / 2) return "high";
        if (confidenceCounts.low > total / 2) return "low";
        if (confidenceCounts.high + confidenceCounts.medium >= total / 2)
            return "medium";
        return "low";
    }, [confidenceCounts, group.items.length]);

    const confColor = confidenceColor(majorityConfidence);

    // Guardrail counters
    const guardrailCounts = useMemo(() => {
        const result = {
            commit: 0,
            draft_only: 0,
            block: 0,
            qtyDiverged: 0,
            velocityInflated: 0,
            moqWarning: 0,
            reviewRequired: 0,
        };
        for (const item of group.items) {
            const d = item.commitGuard?.decision;
            if (d === "commit") result.commit++;
            else if (d === "draft_only") result.draft_only++;
            else if (d === "block") result.block++;
            if (item.qtyDiverged) result.qtyDiverged++;
            if (item.velocityInflated) result.velocityInflated++;
            if (item.moqWarning) result.moqWarning++;
            if (item.reviewRequired) result.reviewRequired++;
        }
        return result;
    }, [group.items]);

    const totalFired =
        guardrailCounts.block +
        guardrailCounts.draft_only +
        guardrailCounts.qtyDiverged +
        guardrailCounts.velocityInflated +
        guardrailCounts.moqWarning +
        guardrailCounts.reviewRequired;

    // ── render ─────────────────────────────────────────────────────────────

    if (!open) return null;

    return (
        <>
            {/* Backdrop scrim */}
            <div
                className="fixed inset-0 bg-black/60 z-50"
                onClick={onClose}
                aria-hidden="true"
            />

            {/* Flyout panel */}
            <div
                className="fixed inset-y-0 right-0 z-50 w-[45vw] min-w-[560px] max-w-[1100px] 
                            bg-zinc-950 border-l border-zinc-800 shadow-2xl
                            flex flex-col font-mono
                            translate-x-0 transition-transform duration-200 ease-out"
                role="dialog"
                aria-modal="true"
                aria-label={`Decision dossier for ${group.vendorName}`}
            >
                {/* ── Header ──────────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        {/* Urgency dot */}
                        <span
                            className={`w-2 h-2 rounded-full shrink-0 ${URGENCY[group.urgency].dot}`}
                        />
                        {/* Vendor name */}
                        <div className="flex flex-col min-w-0">
                            <span className="text-sm font-mono text-zinc-100 truncate">
                                {group.vendorName}
                            </span>
                            <span className="text-[10px] text-zinc-500 font-mono">
                                {group.vendorPartyId}
                            </span>
                        </div>
                        {/* Urgency label */}
                        {URGENCY[group.urgency].label && (
                            <span
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider ${URGENCY[group.urgency].badge}`}
                            >
                                {URGENCY[group.urgency].label}
                            </span>
                        )}
                    </div>

                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 
                                   rounded text-zinc-400 hover:text-zinc-200 transition-all shrink-0"
                        title="Close dossier"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* ── Tabs ────────────────────────────────────────────────── */}
                <div className="flex border-b border-zinc-800 shrink-0 px-4">
                    <button
                        onClick={() => setActiveTab("decision")}
                        className={`px-4 py-2 text-[11px] font-mono uppercase tracking-wider transition-colors 
                                    border-b-2 ${
                            activeTab === "decision"
                                ? "border-zinc-100 text-zinc-100"
                                : "border-transparent text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        Decision
                    </button>
                    <button
                        onClick={() => setActiveTab("lineage")}
                        className={`px-4 py-2 text-[11px] font-mono uppercase tracking-wider transition-colors 
                                    border-b-2 ${
                            activeTab === "lineage"
                                ? "border-zinc-100 text-zinc-100"
                                : "border-transparent text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        PO Lineage
                    </button>
                </div>

                {/* ── Scrollable body ─────────────────────────────────────── */}
                <div
                    className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 
                                [&::-webkit-scrollbar-thumb]:bg-zinc-800"
                >
                    {activeTab === "decision" ? (
                        <div className="flex flex-col h-full">
                            {/* Agent Verdict Card */}
                            <div className="mx-4 mt-4 p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                                        Agent Verdict
                                    </span>
                                    <span
                                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${confColor.bg} ${confColor.text} border-zinc-700 capitalize`}
                                    >
                                        {majorityConfidence} confidence
                                    </span>
                                </div>

                                {/* Metrics row */}
                                <div className="flex items-center gap-4 text-xs font-mono">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-zinc-500">SKUs</span>
                                        <span className="text-zinc-200 tabular-nums">
                                            {fmtNumber(selectedCount)}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-zinc-500">Units</span>
                                        <span className="text-zinc-200 tabular-nums">
                                            {fmtNumber(selectedUnits)}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-zinc-500">Value</span>
                                        <span className="text-zinc-200 tabular-nums">
                                            {fmtDollars(selectedValue)}
                                        </span>
                                    </div>
                                </div>

                                {/* Vendor cycle badge */}
                                {vendorCycleBadge && (
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${vendorCycleBadge.className}`}
                                        >
                                            {vendorCycleBadge.text}
                                        </span>
                                        {hasDraftPO && (
                                            <span className="text-[10px] font-mono text-emerald-400 border border-emerald-500/30 bg-emerald-500/5 px-1.5 py-0.5 rounded">
                                                DRAFT PO ACTIVE
                                            </span>
                                        )}
                                    </div>
                                )}

                                {/* Confidence distribution */}
                                <div className="flex items-center gap-3 text-[10px] font-mono">
                                    <span className="text-zinc-500">Confidence:</span>
                                    <span className="text-emerald-400">
                                        {confidenceCounts.high} high
                                    </span>
                                    <span className="text-amber-400">
                                        {confidenceCounts.medium} med
                                    </span>
                                    <span className="text-red-400">
                                        {confidenceCounts.low} low
                                    </span>
                                </div>
                            </div>

                            {/* Per-SKU Decision Table */}
                            <div className="mx-4 mt-4 space-y-1">
                                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-1">
                                    SKU Decisions
                                </span>

                                {group.items.map((item) => {
                                    const decision = item.assessment?.decision ?? "hold";
                                    const badge = decisionBadge(decision);
                                    const d = decision as
                                        | "order"
                                        | "reduce"
                                        | "hold"
                                        | "manual_review";
                                    const cg = item.commitGuard?.decision;
                                    const cgPill = commitGuardPill(cg);
                                    const lineTotal =
                                        item.unitPrice * item.suggestedQty;
                                    const R = Number.isFinite(
                                        item.adjustedRunwayDays
                                    )
                                        ? item.adjustedRunwayDays
                                        : item.runwayDays;
                                    const rColor = runwayColor(R);

                                    return (
                                        <div
                                            key={item.productId}
                                            className="p-3 rounded border border-zinc-800 bg-zinc-900/30 space-y-2"
                                        >
                                            {/* Row 1: SKU + product name + decision badge */}
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="text-[11px] font-mono text-zinc-200 font-semibold shrink-0">
                                                        {item.productId}
                                                    </span>
                                                    <span className="text-[11px] font-mono text-zinc-400 truncate">
                                                        {item.productName}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    {/* Decision badge */}
                                                    <span
                                                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border capitalize ${badge.bg} ${badge.text}`}
                                                    >
                                                        {d === "manual_review"
                                                            ? "review"
                                                            : d}
                                                    </span>
                                                    {/* Commit guard pill */}
                                                    {cg && (
                                                        <span
                                                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cgPill.bg} ${cgPill.text}`}
                                                        >
                                                            {cg === "draft_only"
                                                                ? "draft"
                                                                : cg}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Row 2: Provenance chain */}
                                            {item.recommendation?.provenance &&
                                                item.recommendation.provenance
                                                    .length > 0 && (
                                                    <ProvenanceChain
                                                        provenance={
                                                            item.recommendation
                                                                .provenance
                                                        }
                                                    />
                                                )}

                                            {/* Row 3: Metrics row */}
                                            <div className="flex items-center gap-4 text-[10px] font-mono">
                                                <span className={rColor}>
                                                    {Number.isFinite(R)
                                                        ? `${Math.round(R)}d runway`
                                                        : "inf runway"}
                                                </span>
                                                <span className="text-zinc-500">
                                                    {fmtDollars(item.unitPrice)} x{" "}
                                                    {fmtNumber(item.suggestedQty)}{" "}
                                                    ={" "}
                                                    <span className="text-zinc-300">
                                                        {fmtDollars(lineTotal)}
                                                    </span>
                                                </span>
                                                {item.assessment?.reasonCodes &&
                                                    item.assessment.reasonCodes
                                                        .length > 0 && (
                                                        <span
                                                            className="text-zinc-600 truncate"
                                                            title={item.assessment.reasonCodes.join(
                                                                ", "
                                                            )}
                                                        >
                                                            {item.assessment.reasonCodes.join(
                                                                ", "
                                                            )}
                                                        </span>
                                                    )}
                                            </div>

                                            {/* Row 4: Warnings */}
                                            <div className="flex items-center gap-2 flex-wrap">
                                                {item.qtyDiverged && (
                                                    <span className="text-[10px] font-mono text-amber-400 border border-amber-500/20 bg-amber-500/5 px-1 py-0.5 rounded">
                                                        qty diverged
                                                        {item.qtyDivergencePct !=
                                                            null &&
                                                            ` (${Math.round(
                                                                item.qtyDivergencePct
                                                            )}%)`}
                                                    </span>
                                                )}
                                                {item.velocityInflated && (
                                                    <span className="text-[10px] font-mono text-amber-400 border border-amber-500/20 bg-amber-500/5 px-1 py-0.5 rounded">
                                                        velocity inflated
                                                    </span>
                                                )}
                                                {item.moqWarning && (
                                                    <span className="text-[10px] font-mono text-amber-400 border border-amber-500/20 bg-amber-500/5 px-1 py-0.5 rounded">
                                                        MOQ warning
                                                    </span>
                                                )}
                                                {item.reviewRequired && (
                                                    <span className="text-[10px] font-mono text-red-400 border border-red-500/20 bg-red-500/5 px-1 py-0.5 rounded">
                                                        review required
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Guardrail Summary */}
                            <div className="mx-4 mt-4 mb-6 border border-zinc-800 rounded-lg bg-zinc-900/30">
                                <button
                                    onClick={() => setGuardrailOpen((v) => !v)}
                                    className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors"
                                >
                                    <span className="uppercase tracking-wider text-[10px]">
                                        Guardrail Summary
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-mono text-zinc-500">
                                            {totalFired === 0
                                                ? "0 fired"
                                                : `${totalFired} flagged`}
                                        </span>
                                        {guardrailOpen ? (
                                            <ChevronUp className="w-3 h-3" />
                                        ) : (
                                            <ChevronDown className="w-3 h-3" />
                                        )}
                                    </div>
                                </button>

                                {guardrailOpen && (
                                    <div className="px-3 pb-3 space-y-2 text-[10px] font-mono">
                                        {/* Commit guard distribution */}
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="text-zinc-500">
                                                Commit guard:
                                            </span>
                                            <span className="text-emerald-400">
                                                commit {guardrailCounts.commit}
                                            </span>
                                            <span className="text-amber-400">
                                                draft {guardrailCounts.draft_only}
                                            </span>
                                            <span className="text-red-400">
                                                block {guardrailCounts.block}
                                            </span>
                                        </div>

                                        {/* Flagged items */}
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="text-zinc-500">
                                                Flags:
                                            </span>
                                            {guardrailCounts.qtyDiverged > 0 && (
                                                <span className="text-amber-400">
                                                    qty diverged{" "}
                                                    {guardrailCounts.qtyDiverged}
                                                </span>
                                            )}
                                            {guardrailCounts.velocityInflated >
                                                0 && (
                                                <span className="text-amber-400">
                                                    velocity inflated{" "}
                                                    {guardrailCounts.velocityInflated}
                                                </span>
                                            )}
                                            {guardrailCounts.moqWarning > 0 && (
                                                <span className="text-amber-400">
                                                    MOQ {guardrailCounts.moqWarning}
                                                </span>
                                            )}
                                            {guardrailCounts.reviewRequired > 0 && (
                                                <span className="text-red-400">
                                                    review{" "}
                                                    {guardrailCounts.reviewRequired}
                                                </span>
                                            )}
                                            {totalFired === 0 && (
                                                <span className="text-zinc-500">
                                                    none
                                                </span>
                                            )}
                                        </div>

                                        {/* Summary line */}
                                        <div className="pt-1 text-[11px] font-mono text-zinc-300 border-t border-zinc-800">
                                            {totalFired === 0
                                                ? "Aria recommends committing this draft. 0 guardrails fired."
                                                : `${totalFired} item${
                                                      totalFired !== 1 ? "s" : ""
                                                  } flagged for review — see table above.`}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        /* ── PO Lineage Tab ───────────────────────────────── */
                        <div className="p-4 space-y-6">
                            {lineageLoading ? (
                                <div className="flex items-center justify-center py-12">
                                    <span className="text-[11px] font-mono text-zinc-500 animate-pulse">
                                        Loading lineage data...
                                    </span>
                                </div>
                            ) : lineageError ? (
                                <div className="flex items-center justify-center py-12">
                                    <span className="text-[11px] font-mono text-red-400">
                                        {lineageError}
                                    </span>
                                </div>
                            ) : (
                                <>
                                    {/* Open POs Section */}
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <Package className="w-3.5 h-3.5 text-zinc-500" />
                                            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">
                                                Open POs
                                            </span>
                                            <span className="text-[10px] font-mono text-zinc-600">
                                                ({openPOs.length})
                                            </span>
                                        </div>

                                        {openPOs.length === 0 ? (
                                            <div className="text-[11px] font-mono text-zinc-600 py-4 text-center border border-dashed border-zinc-800 rounded-lg">
                                                No open POs
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {openPOs.map((po) => (
                                                    <button
                                                        key={po.orderId}
                                                        onClick={() => {
                                                            lifecycle.setLockedFocus(
                                                                {
                                                                    source: "active_purchases",
                                                                    orderId:
                                                                        po.orderId,
                                                                }
                                                            );
                                                            onClose();
                                                        }}
                                                        className="w-full flex items-center justify-between p-3 rounded border border-zinc-800 
                                                                   bg-zinc-900/30 hover:bg-zinc-800/40 transition-colors text-left"
                                                    >
                                                        <div className="flex flex-col gap-0.5 min-w-0">
                                                            <span className="text-[11px] font-mono text-zinc-200">
                                                                {po.orderId}
                                                            </span>
                                                            <span className="text-[10px] font-mono text-zinc-500">
                                                                Expected:{" "}
                                                                {po.expectedDate
                                                                    ? new Date(
                                                                          po.expectedDate
                                                                      ).toLocaleDateString(
                                                                          "en-US",
                                                                          {
                                                                              month: "short",
                                                                              day: "numeric",
                                                                          }
                                                                      )
                                                                    : "—"}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center gap-3 shrink-0">
                                                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 capitalize">
                                                                {po.status}
                                                            </span>
                                                            <span className="text-[11px] font-mono text-zinc-200 tabular-nums">
                                                                {fmtDollars(
                                                                    po.total
                                                                )}
                                                            </span>
                                                            <ChevronRight className="w-3 h-3 text-zinc-600" />
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Receipts Section */}
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <CheckCircle2 className="w-3.5 h-3.5 text-zinc-500" />
                                            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">
                                                Recent Receipts
                                            </span>
                                            <span className="text-[10px] font-mono text-zinc-600">
                                                ({receipts.length})
                                            </span>
                                        </div>

                                        {receipts.length === 0 ? (
                                            <div className="text-[11px] font-mono text-zinc-600 py-4 text-center border border-dashed border-zinc-800 rounded-lg">
                                                No receipts last 30d
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {receipts.map((rcpt) => (
                                                    <div
                                                        key={
                                                            rcpt.orderId +
                                                            rcpt.receiveDate
                                                        }
                                                        className="flex items-start justify-between p-3 rounded border border-zinc-800 
                                                                    bg-zinc-900/30"
                                                    >
                                                        <div className="flex flex-col gap-0.5 min-w-0">
                                                            <span className="text-[11px] font-mono text-zinc-200">
                                                                {rcpt.orderId}
                                                            </span>
                                                            <span className="text-[10px] font-mono text-zinc-500">
                                                                Received:{" "}
                                                                {new Date(
                                                                    rcpt.receiveDate
                                                                ).toLocaleDateString(
                                                                    "en-US",
                                                                    {
                                                                        month: "short",
                                                                        day: "numeric",
                                                                    }
                                                                )}
                                                            </span>
                                                            {rcpt.items &&
                                                                rcpt.items
                                                                    .length >
                                                                    0 && (
                                                                    <span className="text-[10px] font-mono text-zinc-600">
                                                                        {rcpt.items.length}{" "}
                                                                        item{rcpt.items.length !== 1 ? "s" : ""}
                                                                        {rcpt.items.every(
                                                                            (
                                                                                i
                                                                            ) =>
                                                                                i.receivedQuantity !=
                                                                                    null &&
                                                                                i.orderedQuantity !=
                                                                                    null &&
                                                                                i.receivedQuantity >=
                                                                                    i.orderedQuantity
                                                                        )
                                                                            ? " (full)"
                                                                            : " (partial)"}
                                                                    </span>
                                                                )}
                                                        </div>
                                                        <span className="text-[11px] font-mono text-zinc-200 tabular-nums shrink-0">
                                                            {fmtDollars(
                                                                rcpt.total
                                                            )}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
