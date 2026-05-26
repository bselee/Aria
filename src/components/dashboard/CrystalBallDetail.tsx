/**
 * @file    CrystalBallDetail.tsx
 * @purpose Renders the comprehensive forward purchasing projections (Crystal Ball)
 *          for a selected SKU, showing milestones, open POs, historical POs,
 *          burn timeline, and BOM finished-good feeds.
 * @author  Aria
 * @created 2026-05-19
 * @updated 2026-05-19
 * @deps    react, lucide-react
 */

import React, { useState } from "react";
import { 
    X, 
    Package, 
    Clock, 
    TrendingDown, 
    AlertTriangle, 
    CheckCircle2, 
    History,
    Boxes,
    ChevronDown, 
    ChevronUp,
    ExternalLink
} from "lucide-react";

export interface CrystalBallItem {
    productId: string;
    productName: string;
    vendorName: string;
    vendorPartyId: string;
    itemType: 'resale' | 'bom-component';
    
    stockOnHand: number;
    stockOnOrder: number;
    dailyRate: number;
    dailyRateSource: string;
    dailyRateLabel: string;
    unitPrice: number;
    salesVelocity: number;
    demandVelocity: number;
    
    runwayDays: number;
    adjustedRunwayDays: number;
    projectedStockoutDate: string | null;
    
    leadTimeDays: number;
    leadTimeProvenance: string;
    
    projections: Array<{
        daysOut: number;
        projectedStock: number;
        consumed: number;
        incoming: number;
        surplus: number;
        needsOrder: boolean;
        orderByDate: string | null;
        coveragePct: number;
    }>;
    
    openPOs: Array<{
        orderId: string;
        quantity: number;
        orderDate: string;
        expectedDate?: string;
        lifecycleStage?: string;
    }>;
    
    recommendation: {
        suggestedQty: number;
        urgency: string;
        coverDays: number;
        provenance: Array<{ step: string; detail: string; value?: number | string }>;
        formulaVersion: string;
    };
    
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    
    medianPOGapDays?: number;
    projectedNextOrderDate?: string;
    
    historicalPOs?: Array<{
        orderId: string;
        orderDate: string;
        receiveDate: string | null;
        quantity: number;
        status: string;
    }>;
    
    // Existing active draft PO info to avoid duplicates
    draftPO?: {
        orderId: string;
        orderDate: string;
        quantity: number;
        supplierName: string;
        finaleUrl: string;
    } | null;
    
    // Channel allocation and forward planned demands
    stockAvailable?: number;
    forwardDemandEntry?: {
        requiredQty: number;
        earliestBuildDate: string;
        feedsBuilds: string[];
    };

    /** Fraction of past POs this vendor delivered on or before the expected date
     *  (0.0 – 1.0).  Computed by getVendorOnTimeRate() and stored on the item
     *  so the Crystal Ball drawer can surface a lateness risk badge without an
     *  extra API call.  Undefined = not yet measured (treat as 1.0 / on time). */
    vendorOnTimeRate?: number;
}

interface CrystalBallDetailProps {
    item: CrystalBallItem;
    onClose: () => void;
    onCommitPO?: (orderId: string) => void;
}

/**
 * Renders the detailed forward-purchasing projection card for a specific SKU.
 */
export function CrystalBallDetail({ item, onClose, onCommitPO }: CrystalBallDetailProps) {
    const [showProvenance, setShowProvenance] = useState(false);
    
    // Real-world allocation variables (no manual overrides)
    const salesSurge = 1.0;
    const priorityStrategy = 'sales-first'; // FIFO operational priority (direct sales and burn are satisfied first)
    const buildDelayDays = 0;
    
    const stockOnHand = item.stockOnHand ?? 0;
    const stockOnOrder = item.stockOnOrder ?? 0;
    const dailyRate = item.dailyRate ?? 0;
    const leadTime = item.leadTimeDays ?? 14;
    const runway = Number.isFinite(item.adjustedRunwayDays) ? item.adjustedRunwayDays : item.runwayDays;
    
    // Simulator Inputs & Setup
    const salesVelocity = item.salesVelocity ?? 0;
    const demandVelocity = item.demandVelocity ?? 0;
    const requiredQty = item.forwardDemandEntry?.requiredQty ?? 0;

    // 1. Direct Sales 30-day Demand
    const simSales30d = salesVelocity * 30 * salesSurge;

    // 2. BOM Exploded Burn 30-day Demand (raw ingredients used in downstream builds)
    const simBOM30d = Math.max(0, demandVelocity - salesVelocity) * 30;

    // 3. Calendar Scheduled Builds (30-day window)
    // Scale or delay planned builds. If delayed, they are shifted out.
    // E.g., if buildDelayDays is 30, it shifts completely out of the 30-day allocation pool (0% remaining).
    const effectiveCalendarDemand = Math.max(0, requiredQty * (1 - buildDelayDays / 30));

    const totalSimDemand = simSales30d + simBOM30d + effectiveCalendarDemand;

    // 4. Available Stock Pool: stockOnHand + open POs arriving within 30 days
    let incomingPOs30d = 0;
    const today = new Date();
    for (const po of item.openPOs ?? []) {
        let etaDate: Date;
        if (po.expectedDate) {
            etaDate = new Date(po.expectedDate);
        } else {
            etaDate = new Date(po.orderDate);
            etaDate.setDate(etaDate.getDate() + (item.leadTimeDays ?? 14));
        }
        const diffDays = Math.ceil((etaDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays <= 30) {
            incomingPOs30d += po.quantity;
        }
    }
    const stockPool = stockOnHand + incomingPOs30d;

    // 5. Solve Channel Allocation and Fulfillment Percentages
    let salesFulfillment = 0;
    let bomFulfillment = 0;
    let calendarFulfillment = 0;

    if (priorityStrategy === 'equitable') {
        if (stockPool >= totalSimDemand) {
            salesFulfillment = 100;
            bomFulfillment = 100;
            calendarFulfillment = 100;
        } else if (totalSimDemand > 0) {
            const ratio = Math.min(100, Math.round((stockPool / totalSimDemand) * 100));
            salesFulfillment = ratio;
            bomFulfillment = ratio;
            calendarFulfillment = ratio;
        } else {
            salesFulfillment = 100;
            bomFulfillment = 100;
            calendarFulfillment = 100;
        }
    } else if (priorityStrategy === 'sales-first') {
        let pool = stockPool;
        // Direct Sales gets priority 1
        if (pool >= simSales30d) {
            salesFulfillment = 100;
            pool -= simSales30d;
        } else {
            salesFulfillment = simSales30d > 0 ? Math.min(100, Math.round((pool / simSales30d) * 100)) : 100;
            pool = 0;
        }
        // BOM gets priority 2
        if (pool >= simBOM30d) {
            bomFulfillment = 100;
            pool -= simBOM30d;
        } else {
            bomFulfillment = simBOM30d > 0 ? Math.min(100, Math.round((pool / simBOM30d) * 100)) : 100;
            pool = 0;
        }
        // Planned Builds gets priority 3
        if (pool >= effectiveCalendarDemand) {
            calendarFulfillment = 100;
        } else {
            calendarFulfillment = effectiveCalendarDemand > 0 ? Math.min(100, Math.round((pool / effectiveCalendarDemand) * 100)) : 100;
        }
    } else { // builds-first
        let pool = stockPool;
        // Planned Builds gets priority 1
        if (pool >= effectiveCalendarDemand) {
            calendarFulfillment = 100;
            pool -= effectiveCalendarDemand;
        } else {
            calendarFulfillment = effectiveCalendarDemand > 0 ? Math.min(100, Math.round((pool / effectiveCalendarDemand) * 100)) : 100;
            pool = 0;
        }
        // BOM gets priority 2
        if (pool >= simBOM30d) {
            bomFulfillment = 100;
            pool -= simBOM30d;
        } else {
            bomFulfillment = simBOM30d > 0 ? Math.min(100, Math.round((pool / simBOM30d) * 100)) : 100;
            pool = 0;
        }
        // Direct Sales gets priority 3
        if (pool >= simSales30d) {
            salesFulfillment = 100;
        } else {
            salesFulfillment = simSales30d > 0 ? Math.min(100, Math.round((pool / simSales30d) * 100)) : 100;
        }
    }

    // 6. Compute Simulated Burn Rate & Depletion Runway
    const simDailyBurn = (salesVelocity * salesSurge) + Math.max(0, demandVelocity - salesVelocity);
    const simCalendarDaily = effectiveCalendarDemand / 30;
    const totalSimBurnRate = simDailyBurn + simCalendarDaily;
    const simulatedRunway = totalSimBurnRate > 0 ? (stockOnHand / totalSimBurnRate) : Number.POSITIVE_INFINITY;
    const runwayDifference = Number.isFinite(simulatedRunway) && Number.isFinite(runway) 
        ? Math.round(simulatedRunway - runway) 
        : 0;
    // Compute allocation & planned calendar demand metrics
    const stockAvailable = item.stockAvailable ?? stockOnHand;
    const stockReserved = Math.max(0, stockOnHand - stockAvailable);
    const totalAllocations = stockOnHand > 0 ? stockOnHand : 0;
    const availablePct = totalAllocations > 0 ? Math.round((stockAvailable / totalAllocations) * 100) : 0;
    const reservedPct = totalAllocations > 0 ? Math.round((stockReserved / totalAllocations) * 100) : 0;

    const earliestBuildDate = item.forwardDemandEntry?.earliestBuildDate || null;
    const feedsBuilds = item.forwardDemandEntry?.feedsBuilds || [];

    // Determine runway state and colors
    let runwayColor = "text-emerald-400";
    let runwayBg = "bg-emerald-500/10 border-emerald-500/20";
    let runwayLabel = "Healthy Runway";
    
    if (runway < leadTime) {
        runwayColor = "text-red-400";
        runwayBg = "bg-red-500/10 border-red-500/20";
        runwayLabel = "SHORTAGE (Below Lead Time)";
    } else if (runway < leadTime + 30) {
        runwayColor = "text-amber-400";
        runwayBg = "bg-amber-500/10 border-amber-500/20";
        runwayLabel = "Warning (Stockout within 30d of LT)";
    }
    
    // Compute timeline progress and gradient
    const maxDays = 365;
    const stockoutPositionPct = runway > 0 && runway <= maxDays 
        ? Math.min(100, (runway / maxDays) * 100) 
        : null;
        
    // Generate pure CSS linear gradient for depletion bar:
    // Green (surplus) up to stockout, then red (deficit) after stockout.
    // If runway is greater than 365, it remains green.
    let depletionGradient = "linear-gradient(to right, #10b981 0%, #10b981 100%)";
    if (stockoutPositionPct !== null) {
        // Color transition green -> red at the stockout mark
        depletionGradient = `linear-gradient(to right, #10b981 0%, #10b981 ${stockoutPositionPct}%, #ef4444 ${stockoutPositionPct}%, #ef4444 100%)`;
    }

    const firstTriggerProjection = item.projections.find(proj => proj.needsOrder || proj.surplus < 0);
    const lastCoveredProjection = [...item.projections]
        .filter(proj => !proj.needsOrder && proj.surplus >= 0)
        .sort((a, b) => a.daysOut - b.daysOut)
        .pop();
    const nextOrderByDate = firstTriggerProjection?.orderByDate ?? item.projectedNextOrderDate ?? null;
    const leadTimeRisk = Number.isFinite(runway) && runway < leadTime;
    const orderNow = leadTimeRisk || item.recommendation.urgency === "critical";
    const allocationShortageUnits = Math.max(0, totalSimDemand - stockPool);
    const hasAllocationShortage = allocationShortageUnits > 0;
    const historyCount = item.historicalPOs?.length ?? 0;
    const historyConfidence =
        historyCount >= 4 ? "high history confidence" :
        historyCount >= 2 ? "medium history confidence" :
        historyCount === 1 ? "low history confidence" :
        "no recent PO history";
    const verdictTitle = orderNow ? "Order now" : nextOrderByDate ? "No PO needed today" : "Covered";
    const nextActionLabel = orderNow
        ? (nextOrderByDate ? `Next action: order now, target ${nextOrderByDate}` : "Next action: order now")
        : (nextOrderByDate ? `Next action: order by ${nextOrderByDate}` : "Next action: monitor");
    const coveredWindowLabel = lastCoveredProjection ? `Covered for ${lastCoveredProjection.daysOut}d` : "No covered milestone";
    const suggestedQtyLabel = `Recommended PO qty: ${Math.round(item.recommendation.suggestedQty).toLocaleString()}`;
    
    return (
        <div className="p-4 space-y-6 bg-zinc-900 border-t border-zinc-800 animate-fadeIn">
            {/* Identity Header */}
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-lg font-mono font-bold text-zinc-100">{item.productId}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 bg-zinc-800/40">
                            {item.itemType === "bom-component" ? "BOM COMPONENT" : "RESALE SKU"}
                        </span>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border capitalize ${
                            item.recommendation.urgency === "critical" ? "text-red-400 border-red-500/30 bg-red-500/5" :
                            item.recommendation.urgency === "warning" ? "text-amber-400 border-amber-500/30 bg-amber-500/5" :
                            item.recommendation.urgency === "watch" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5" :
                            "text-zinc-400 border-zinc-700 bg-zinc-800/40"
                        }`}>
                            Urgency: {item.recommendation.urgency}
                        </span>
                        {/* Vendor on-time rate badge — shown when below 90%.
                            DECISION(2026-05-21): Threshold of 0.9 chosen because a vendor
                            delivering late >10% of the time materially risks the lead-time
                            assumption the recommender is built on. Below 0.75 = danger. */}
                        {item.vendorOnTimeRate != null && item.vendorOnTimeRate < 0.9 && (
                            <span
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                    item.vendorOnTimeRate < 0.75
                                        ? 'text-red-400 border-red-500/30 bg-red-500/5'
                                        : 'text-amber-400 border-amber-500/30 bg-amber-500/5'
                                }`}
                                title={`Vendor on-time delivery rate: ${Math.round(item.vendorOnTimeRate * 100)}%. Lead-time estimates may be optimistic — actual arrival risk is higher than the runway numbers suggest.`}
                            >
                                ⏱ Late {Math.round((1 - item.vendorOnTimeRate) * 100)}%
                            </span>
                        )}
                    </div>
                    <h2 className="text-sm text-zinc-400 font-sans tracking-wide leading-tight max-w-xl">
                        {item.productName}
                    </h2>
                    <div className="text-xs font-mono text-zinc-500">
                        Supplier: <span className="text-zinc-300 font-medium">{item.vendorName}</span>
                    </div>
                </div>
                
                <button 
                    onClick={onClose}
                    className="p-1.5 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-all shrink-0"
                    title="Back to all items"
                >
                    <div className="flex items-center gap-1.5 px-1">
                        <X className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-mono uppercase tracking-wider">Close</span>
                    </div>
                </button>
            </div>

            {/* Action Verdict */}
            <div className={`border rounded-lg p-3.5 font-mono ${
                orderNow
                    ? "bg-red-500/10 border-red-500/30"
                    : hasAllocationShortage
                        ? "bg-amber-500/10 border-amber-500/30"
                        : "bg-emerald-500/10 border-emerald-500/25"
            }`}>
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                    <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            {orderNow ? (
                                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                            ) : (
                                <CheckCircle2 className={`w-4 h-4 shrink-0 ${hasAllocationShortage ? "text-amber-400" : "text-emerald-400"}`} />
                            )}
                            <span className={`text-sm font-bold ${orderNow ? "text-red-300" : hasAllocationShortage ? "text-amber-300" : "text-emerald-300"}`}>
                                {verdictTitle}
                            </span>
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                {coveredWindowLabel}
                            </span>
                        </div>
                        <div className="text-xs text-zinc-300 leading-relaxed">
                            {nextActionLabel}. {suggestedQtyLabel}. {historyConfidence}.
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 lg:min-w-[420px]">
                        <div className="rounded border border-zinc-800/80 bg-zinc-950/45 px-2.5 py-2">
                            <span className="block text-[9px] uppercase tracking-wider text-zinc-500">Runway</span>
                            <span className={`block text-sm font-semibold ${runwayColor}`}>
                                {Number.isFinite(runway) ? `${Math.round(runway)}d` : "Infinite"}
                            </span>
                        </div>
                        <div className="rounded border border-zinc-800/80 bg-zinc-950/45 px-2.5 py-2">
                            <span className="block text-[9px] uppercase tracking-wider text-zinc-500">Lead Time</span>
                            <span className="block text-sm font-semibold text-zinc-200">{leadTime}d</span>
                        </div>
                        <div className="rounded border border-zinc-800/80 bg-zinc-950/45 px-2.5 py-2">
                            <span className="block text-[9px] uppercase tracking-wider text-zinc-500">Allocation</span>
                            <span className={`block text-sm font-semibold ${hasAllocationShortage ? "text-amber-300" : "text-emerald-300"}`}>
                                {hasAllocationShortage ? "Build risk" : "Balanced"}
                            </span>
                        </div>
                    </div>
                </div>
                {hasAllocationShortage && (
                    <div className="mt-3 rounded border border-amber-500/20 bg-zinc-950/35 px-3 py-2 text-[11px] text-amber-100 leading-relaxed">
                        Allocation risk is build-plan based: daily demand is satisfied first, but scheduled builds are short by {Math.round(allocationShortageUnits).toLocaleString()} units inside the 30-day allocation window.
                    </div>
                )}
            </div>
            
            {/* Draft PO Warning Banner */}
            {item.draftPO && (
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-lg p-4 font-mono text-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div className="space-y-1">
                            <span className="font-bold text-amber-400 block text-[13px]">Draft PO Detected</span>
                            <p className="leading-relaxed">
                                Draft PO #{item.draftPO.orderId} created on {item.draftPO.orderDate} by {item.draftPO.supplierName} contains {item.draftPO.quantity} units of this item. Please review and commit this PO instead of creating a duplicate.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                        <a 
                            href={item.draftPO.finaleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1.5 rounded border border-amber-500/40 hover:bg-amber-500/20 hover:text-amber-200 transition-all flex items-center gap-1.5 text-[11px] font-semibold"
                        >
                            <span>View Draft</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                        {onCommitPO && (
                            <button
                                onClick={() => onCommitPO(item.draftPO!.orderId)}
                                className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 transition-all font-semibold text-[11px]"
                            >
                                Commit & Send PO
                            </button>
                        )}
                    </div>
                </div>
            )}
            
            {/* Key Metrics Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {/* On Hand */}
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3 space-y-1">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 block">ON HAND</span>
                    <span className="text-xl font-mono font-semibold text-zinc-100 block">
                        {stockOnHand.toLocaleString()}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 block">
                        Value: ${(stockOnHand * item.unitPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                </div>
                
                {/* On Order */}
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3 space-y-1">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 block">ON ORDER</span>
                    <span className="text-xl font-mono font-semibold text-zinc-100 block">
                        {stockOnOrder.toLocaleString()}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 block">
                        {item.openPOs.length} active PO{item.openPOs.length !== 1 ? "s" : ""}
                    </span>
                </div>
                
                {/* Velocity */}
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3 space-y-1">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 block">DAILY BURN RATE</span>
                    <span className="text-xl font-mono font-semibold text-zinc-100 block">
                        {dailyRate.toFixed(2)}/day
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 block capitalize">
                        Source: {item.dailyRateLabel}
                    </span>
                </div>
                
                {/* Runway */}
                <div className={`border rounded-lg p-3 space-y-1 ${runwayBg}`}>
                    <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 block">EST. RUNWAY</span>
                    <span className={`text-xl font-mono font-bold block ${runwayColor}`}>
                        {Number.isFinite(runway) ? `${Math.round(runway)} days` : "Infinite"}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400 block truncate" title={item.projectedStockoutDate || ""}>
                        {item.projectedStockoutDate ? `Stockout: ${item.projectedStockoutDate}` : runwayLabel}
                    </span>
                </div>
            </div>
            
            {/* 30-Day Channel Allocation & Fulfillment */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-4 space-y-5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.02)]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
                    <span className="text-xs font-mono font-bold text-zinc-200 flex items-center gap-1.5">
                        <Boxes className="w-4 h-4 text-purple-400 animate-pulse" />
                        30-Day Channel Allocation & Fulfillment
                    </span>
                    <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded">
                        Google Calendar & Velocity Solver
                    </span>
                </div>

                {/* Stock Allocation Stacked Progress Bar */}
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                        <span>Physical Stock Allocation Stack ({stockOnHand.toLocaleString()} units)</span>
                        <span className="text-zinc-500">Available vs Committed Reserved</span>
                    </div>
                    
                    <div className="w-full h-3 rounded-full bg-zinc-900 border border-zinc-800/80 overflow-hidden flex">
                        {stockOnHand > 0 ? (
                            <>
                                {stockAvailable > 0 && (
                                    <div 
                                        className="h-full bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 transition-all duration-300 shadow-[0_0_12px_rgba(16,185,129,0.15)] cursor-help"
                                        style={{ width: `${availablePct}%` }}
                                        title={`Available to Promise: ${stockAvailable.toLocaleString()} (${availablePct}%)`}
                                    />
                                )}
                                {stockReserved > 0 && (
                                    <div 
                                        className="h-full bg-gradient-to-r from-purple-700 to-purple-500 hover:from-purple-600 hover:to-purple-400 transition-all duration-300 shadow-[0_0_12px_rgba(147,51,234,0.15)] cursor-help"
                                        style={{ width: `${reservedPct}%` }}
                                        title={`Committed Reservations: ${stockReserved.toLocaleString()} (${reservedPct}%)`}
                                    />
                                )}
                            </>
                        ) : (
                            <div className="w-full h-full bg-zinc-800/40 text-center text-[9px] font-mono text-zinc-650 flex items-center justify-center">
                                OUT OF STOCK (0 units)
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-0.5">
                        <div className="flex items-start gap-2">
                            <span className="w-2.5 h-2.5 rounded bg-emerald-500/80 mt-0.5 shrink-0 shadow-[0_0_4px_rgba(16,185,129,0.4)]" />
                            <div className="space-y-0.5 leading-none">
                                <span className="text-[10px] font-mono text-zinc-400 block font-semibold">Net Available to Promise</span>
                                <span className="text-[11px] font-mono text-emerald-400">{stockAvailable.toLocaleString()} units ({availablePct}%)</span>
                                <span className="text-[9px] text-zinc-500 block">Free stock, unpromised & sellable</span>
                            </div>
                        </div>

                        <div className="flex items-start gap-2">
                            <span className="w-2.5 h-2.5 rounded bg-purple-600/80 mt-0.5 shrink-0 shadow-[0_0_4px_rgba(147,51,234,0.4)]" />
                            <div className="space-y-0.5 leading-none">
                                <span className="text-[10px] font-mono text-zinc-400 block font-semibold">Committed Reservations</span>
                                <span className="text-[11px] font-mono text-purple-400">{stockReserved.toLocaleString()} units ({reservedPct}%)</span>
                                <span className="text-[9px] text-zinc-500 block">Promised to open orders/builds in Finale</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Fulfillment Sufficiency Dashboard (3-Column Channel Grid) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t border-zinc-800/50 pt-4">
                    {/* Channel 1: Resale Channel (Direct Sales) */}
                    <div className="bg-zinc-950/50 border border-zinc-800/85 rounded-lg p-3 flex flex-col justify-between space-y-3">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-mono font-bold tracking-wider text-zinc-400 uppercase">Resale Channel</span>
                                <span className={`text-[8px] font-mono px-1 py-0.2 rounded border ${
                                    salesFulfillment === 100 
                                        ? "text-emerald-400 border-emerald-950 bg-emerald-950/20" 
                                        : salesFulfillment >= 50 
                                            ? "text-amber-400 border-amber-950 bg-amber-950/20" 
                                            : "text-red-400 border-red-950 bg-red-950/20"
                                }`}>
                                    {salesFulfillment}% Met
                                </span>
                            </div>
                            
                            {/* Fulfillment slider-meter */}
                            <div className="space-y-1">
                                <div className="w-full h-1.5 rounded-full bg-zinc-900 border border-zinc-800/80 overflow-hidden flex">
                                    <div 
                                        className={`h-full transition-all duration-500 ${
                                            salesFulfillment === 100 ? "bg-emerald-500" : salesFulfillment >= 50 ? "bg-amber-500" : "bg-red-500"
                                        }`}
                                        style={{ width: `${salesFulfillment}%` }}
                                    />
                                </div>
                                <div className="flex justify-between text-[9px] font-mono text-zinc-500">
                                    <span>30d Demand: {Math.round(simSales30d).toLocaleString()} u</span>
                                    <span>Allocated: {Math.round((simSales30d * salesFulfillment) / 100).toLocaleString()} u</span>
                                </div>
                            </div>
                        </div>

                        <div className="pt-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-500 flex justify-between items-center">
                            <span>Velocity: {salesVelocity.toFixed(1)}/day</span>
                            <span className="text-zinc-400">Direct Orders</span>
                        </div>
                    </div>

                    {/* Channel 2: Manufacturing Channel (Indirect BOM Burn) */}
                    <div className="bg-zinc-950/50 border border-zinc-800/85 rounded-lg p-3 flex flex-col justify-between space-y-3">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-mono font-bold tracking-wider text-zinc-400 uppercase">BOM Consumption</span>
                                <span className={`text-[8px] font-mono px-1 py-0.2 rounded border ${
                                    bomFulfillment === 100 
                                        ? "text-emerald-400 border-emerald-950 bg-emerald-950/20" 
                                        : bomFulfillment >= 50 
                                            ? "text-amber-400 border-amber-950 bg-amber-950/20" 
                                            : "text-red-400 border-red-950 bg-red-950/20"
                                }`}>
                                    {bomFulfillment}% Met
                                </span>
                            </div>

                            {/* Fulfillment slider-meter */}
                            <div className="space-y-1">
                                <div className="w-full h-1.5 rounded-full bg-zinc-900 border border-zinc-800/80 overflow-hidden flex">
                                    <div 
                                        className={`h-full transition-all duration-500 ${
                                            bomFulfillment === 100 ? "bg-emerald-500" : bomFulfillment >= 50 ? "bg-amber-500" : "bg-red-500"
                                        }`}
                                        style={{ width: `${bomFulfillment}%` }}
                                    />
                                </div>
                                <div className="flex justify-between text-[9px] font-mono text-zinc-500">
                                    <span>30d Demand: {Math.round(simBOM30d).toLocaleString()} u</span>
                                    <span>Allocated: {Math.round((simBOM30d * bomFulfillment) / 100).toLocaleString()} u</span>
                                </div>
                            </div>
                        </div>

                        <div className="pt-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-500 flex justify-between items-center">
                            <span>Burn: {Math.max(0, demandVelocity - salesVelocity).toFixed(1)}/day</span>
                            <span className="text-zinc-400">{item.feedsFinishedGoods?.length || 0} FG Consumers</span>
                        </div>
                    </div>

                    {/* Channel 3: Planned Build Demand (Calendar Schedule) */}
                    <div className="bg-zinc-950/50 border border-zinc-800/85 rounded-lg p-3 flex flex-col justify-between space-y-3">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-mono font-bold tracking-wider text-zinc-400 uppercase">Calendar Builds</span>
                                <span className={`text-[8px] font-mono px-1 py-0.2 rounded border ${
                                    calendarFulfillment === 100 
                                        ? "text-emerald-400 border-emerald-950 bg-emerald-950/20" 
                                        : calendarFulfillment >= 50 
                                            ? "text-amber-400 border-amber-950 bg-amber-950/20" 
                                            : "text-red-400 border-red-950 bg-red-950/20"
                                }`}>
                                    {calendarFulfillment}% Met
                                </span>
                            </div>

                            {/* Fulfillment slider-meter */}
                            <div className="space-y-1">
                                <div className="w-full h-1.5 rounded-full bg-zinc-900 border border-zinc-800/80 overflow-hidden flex">
                                    <div 
                                        className={`h-full transition-all duration-500 ${
                                            calendarFulfillment === 100 ? "bg-emerald-500" : calendarFulfillment >= 50 ? "bg-amber-500" : "bg-red-500"
                                        }`}
                                        style={{ width: `${calendarFulfillment}%` }}
                                    />
                                </div>
                                <div className="flex justify-between text-[9px] font-mono text-zinc-500">
                                    <span>30d Demand: {Math.round(effectiveCalendarDemand).toLocaleString()} u</span>
                                    <span>Allocated: {Math.round((effectiveCalendarDemand * calendarFulfillment) / 100).toLocaleString()} u</span>
                                </div>
                            </div>
                        </div>

                        <div className="pt-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-500 flex justify-between items-center">
                            <span>Sched: {requiredQty.toLocaleString()} units</span>
                            <span className="text-zinc-500 truncate max-w-[55%]">
                                {earliestBuildDate ? `ETA: ${new Date(earliestBuildDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : "None scheduled"}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Allocation Warnings & Status Banners */}
                <div className="pt-1">
                    {totalSimDemand > stockPool ? (
                        <div className="bg-red-500/10 border border-red-550/30 text-red-300 rounded-lg p-3.5 font-mono text-xs flex gap-3 items-start shadow-[0_0_15px_rgba(239,68,68,0.08)]">
                            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                            <div className="space-y-1 leading-relaxed">
                                <span className="font-bold text-red-400 block text-[11px] tracking-wider uppercase">BUILD-ALLOCATION SHORTAGE DETECTED</span>
                                <p className="text-zinc-200">
                                    Current inventory + incoming PO receipts (<strong className="text-zinc-100">{stockPool.toLocaleString()}</strong> units) cover the daily-runway model first, but cannot fully satisfy scheduled calendar builds inside the 30-day allocation window (<strong className="text-zinc-100">{Math.round(totalSimDemand).toLocaleString()}</strong> units requested).
                                </p>
                                <div className="text-zinc-400 text-[11px] leading-relaxed">
                                    Daily resale orders and BOM consumption consume stock first, leaving a build-plan deficit of <strong className="text-red-400">{Math.round(allocationShortageUnits).toLocaleString()} units</strong>. This is separate from the headline stockout/runway date.
                                    {feedsBuilds.length > 0 && (
                                        <span className="block mt-1">
                                            Scheduled manufacturing runs at risk: <strong className="text-zinc-200">{feedsBuilds.join(', ')}</strong> on <strong className="text-zinc-200">{earliestBuildDate ? new Date(earliestBuildDate).toLocaleDateString() : 'N/A'}</strong>.
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-emerald-500/5 border border-emerald-500/20 text-emerald-450 rounded-lg p-3 font-mono text-xs flex gap-2.5 items-center">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            <span>Inventory allocation is balanced. Current physical stock and immediate PO receipts fully cover all customer orders and calendar-scheduled manufacturing builds.</span>
                        </div>
                    )}
                </div>
            </div>
            
            {/* Depletion Timeline Bar */}
            <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-semibold text-zinc-300 flex items-center gap-1.5">
                        <TrendingDown className="w-3.5 h-3.5 text-zinc-500" />
                        Burn & Depletion Timeline
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">
                        Lead Time: <span className="text-zinc-300 font-bold">{leadTime} days</span> ({item.leadTimeProvenance})
                    </span>
                </div>
                
                <div className="relative pt-6 pb-2 px-1">
                    {/* The burn track bar */}
                    <div 
                        className="w-full h-2.5 rounded-full relative border border-zinc-800/60"
                        style={{ background: depletionGradient }}
                    >
                        {/* Milestone Tick Lines */}
                        {item.projections.map(proj => {
                            const pct = (proj.daysOut / maxDays) * 100;
                            return (
                                <div 
                                    key={proj.daysOut}
                                    className="absolute top-1/2 -translate-y-1/2 w-0.5 h-4 bg-zinc-950 flex flex-col items-center"
                                    style={{ left: `${pct}%` }}
                                >
                                    {/* Tick label on top */}
                                    <span className="absolute bottom-5 text-[9px] font-mono font-semibold text-zinc-500 select-none">
                                        {proj.daysOut}d
                                    </span>
                                    {/* Stock value below */}
                                    <span className={`absolute top-5 text-[9px] font-mono ${proj.surplus < 0 ? "text-red-400 font-semibold" : "text-zinc-400"}`}>
                                        {proj.projectedStock >= 0 ? proj.projectedStock : proj.surplus}
                                    </span>
                                </div>
                            );
                        })}
                        
                        {/* Stockout indicator pointer */}
                        {stockoutPositionPct !== null && (
                            <div 
                                className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center"
                                style={{ left: `${stockoutPositionPct}%` }}
                            >
                                <div className="w-1 h-6 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)] z-10" />
                                <div className="absolute -top-7 whitespace-nowrap bg-red-950/90 text-red-300 border border-red-800/50 text-[9px] font-mono px-1 rounded shadow-md z-15 flex items-center gap-1">
                                    <AlertTriangle className="w-2.5 h-2.5 text-red-400 shrink-0" />
                                    <span>Stockout ({Math.round(runway)}d)</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                
                {/* Visual Legend */}
                <div className="flex items-center gap-4 text-[10px] font-mono text-zinc-500 justify-end pt-1">
                    <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded bg-emerald-500 inline-block" />
                        Surplus Stock
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded bg-red-500 inline-block" />
                        Deficit (Needs Order)
                    </span>
                </div>
            </div>
            
            {/* Window Breakdown Table */}
            <div className="space-y-2">
                <span className="text-xs font-mono font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-zinc-500" />
                    Milestone Windows & Purchasing Triggers
                </span>
                
                <div className="border border-zinc-800/80 rounded-lg overflow-hidden bg-zinc-950/20">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/35 text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                                <th className="py-2 px-3">Milestone</th>
                                <th className="py-2 px-3 text-right">Projected Stock</th>
                                <th className="py-2 px-3 text-right">Burn (Consumed)</th>
                                <th className="py-2 px-3 text-right">Incoming POs</th>
                                <th className="py-2 px-3 text-right">Surplus/Deficit</th>
                                <th className="py-2 px-3">Order-by Date</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50 text-xs font-mono">
                            {item.projections.map(proj => {
                                const isDeficit = proj.surplus < 0;
                                return (
                                    <tr key={proj.daysOut} className={`hover:bg-zinc-800/10 transition-colors ${isDeficit ? "bg-red-500/[0.02]" : ""}`}>
                                        <td className="py-2 px-3 font-semibold text-zinc-300">
                                            {proj.daysOut} Days Out
                                        </td>
                                        <td className={`py-2 px-3 text-right ${isDeficit ? "text-red-400 font-bold" : "text-zinc-200"}`}>
                                            {proj.projectedStock.toLocaleString()}
                                        </td>
                                        <td className="py-2 px-3 text-right text-zinc-500">
                                            {proj.consumed.toLocaleString()}
                                        </td>
                                        <td className={`py-2 px-3 text-right ${proj.incoming > 0 ? "text-emerald-400 font-medium" : "text-zinc-600"}`}>
                                            {proj.incoming > 0 ? `+${proj.incoming.toLocaleString()}` : "—"}
                                        </td>
                                        <td className="py-2 px-3 text-right">
                                            {isDeficit ? (
                                                <span className="text-red-400 bg-red-950/40 px-1.5 py-0.5 rounded border border-red-900/50 text-[10px]">
                                                    {proj.surplus.toLocaleString()} (Deficit)
                                                </span>
                                            ) : (
                                                <span className="text-emerald-400 bg-emerald-950/20 px-1.5 py-0.5 rounded border border-emerald-900/20 text-[10px]">
                                                    +{proj.surplus.toLocaleString()} (Surplus)
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 px-3">
                                            {proj.orderByDate ? (
                                                <span className={`px-1.5 py-0.5 rounded text-[10px] border ${
                                                    new Date(proj.orderByDate) < new Date()
                                                        ? "text-red-400 bg-red-950/40 border-red-950"
                                                        : "text-amber-400 bg-amber-950/30 border-amber-950"
                                                }`}>
                                                    ⚠ Order by {proj.orderByDate}
                                                </span>
                                            ) : (
                                                <span className="text-emerald-500 font-medium flex items-center gap-1 text-[10px]">
                                                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                                                    Covered
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
            
            {/* Open & Historical POs (Two Column Layout if both are present) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Active Open POs */}
                <div className="space-y-2">
                    <span className="text-xs font-mono font-semibold text-zinc-300 flex items-center gap-1.5">
                        <Package className="w-3.5 h-3.5 text-zinc-500" />
                        Active Open POs
                    </span>
                    
                    <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/20 min-h-[140px] flex flex-col justify-start">
                        {item.openPOs.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 text-xs font-mono py-8">
                                <span>No open POs found for this SKU</span>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                                {item.openPOs.map((po, index) => {
                                    const expected = po.expectedDate ? new Date(po.expectedDate) : null;
                                    const today = new Date();
                                    const diffDays = expected 
                                        ? Math.ceil((expected.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
                                        : null;
                                    
                                    return (
                                        <div key={index} className="flex items-center justify-between p-2 rounded border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/70 transition-colors">
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-mono font-bold text-zinc-200">PO #{po.orderId}</span>
                                                    {po.lifecycleStage && (
                                                        <span className="text-[9px] font-mono px-1 py-0.2 rounded border border-zinc-700 bg-zinc-800 text-zinc-400 capitalize">
                                                            {po.lifecycleStage}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] font-mono text-zinc-500">
                                                    Qty: <span className="text-zinc-300 font-bold">{po.quantity.toLocaleString()}</span> | Ordered: {po.orderDate}
                                                </div>
                                            </div>
                                            
                                            <div className="text-right">
                                                {po.expectedDate ? (
                                                    <div className="space-y-0.5">
                                                        <span className="text-[10px] font-mono text-emerald-400 font-medium block">
                                                            ETA: {po.expectedDate}
                                                        </span>
                                                        <span className="text-[9px] font-mono text-zinc-500 block">
                                                            {diffDays !== null ? (diffDays <= 0 ? "Due today/past" : `In ${diffDays} days`) : ""}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="text-[10px] font-mono text-amber-500/80 block">
                                                        No ETA Date
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                
                {/* Historical POs (Last 3-6 Months) */}
                <div className="space-y-2">
                    <span className="text-xs font-mono font-semibold text-zinc-300 flex items-center gap-1.5">
                        <History className="w-3.5 h-3.5 text-zinc-500" />
                        Historical POs (Last 6 Months)
                    </span>
                    
                    <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/20 min-h-[140px] flex flex-col justify-start">
                        {!item.historicalPOs || item.historicalPOs.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 text-xs font-mono py-8">
                                <span>No historical POs in the past 6 months</span>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                                {item.historicalPOs.map((po, index) => {
                                    const isReceived = po.status === "RECEIVED";
                                    return (
                                        <div key={index} className="flex items-center justify-between p-2 rounded border border-zinc-800/80 bg-zinc-900/20 hover:bg-zinc-900/40 transition-colors">
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-mono font-bold text-zinc-300">PO #{po.orderId}</span>
                                                    <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded border ${
                                                        isReceived 
                                                            ? "text-emerald-400 border-emerald-950 bg-emerald-950/20" 
                                                            : "text-zinc-400 border-zinc-700 bg-zinc-800/40"
                                                    }`}>
                                                        {po.status}
                                                    </span>
                                                </div>
                                                <div className="text-[10px] font-mono text-zinc-500">
                                                    Qty: <span className="text-zinc-300 font-medium">{po.quantity.toLocaleString()}</span> | Ordered: {po.orderDate}
                                                </div>
                                            </div>
                                            
                                            <div className="text-right text-[10px] font-mono text-zinc-500">
                                                {po.receiveDate ? (
                                                    <span>Received: {po.receiveDate}</span>
                                                ) : (
                                                    <span>—</span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            
            {/* BOM Feeds Finished Goods (If present) */}
            {item.feedsFinishedGoods && item.feedsFinishedGoods.length > 0 && (
                <div className="space-y-2 bg-zinc-950/20 border border-zinc-800/80 rounded-lg p-3">
                    <span className="text-xs font-mono font-semibold text-purple-300 flex items-center gap-1.5">
                        <Boxes className="w-3.5 h-3.5 text-purple-400" />
                        BOM Structure — Feeds Finished Goods
                    </span>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                        {item.feedsFinishedGoods.map((fg, index) => (
                            <div key={index} className="p-2 border border-purple-950/40 bg-purple-950/[0.05] rounded flex items-center justify-between text-xs font-mono">
                                <div className="truncate pr-2">
                                    <span className="text-purple-300 font-bold mr-1.5 shrink-0">{fg.sku}</span>
                                    <span className="text-zinc-400 truncate text-[11px]" title={fg.name}>{fg.name}</span>
                                </div>
                                <div className="shrink-0 text-right text-[10px] text-zinc-500">
                                    {fg.dailySalesRate > 0 && <span>{fg.dailySalesRate.toFixed(2)} sales/d | </span>}
                                    <span className={fg.buildsWorth < leadTime ? "text-red-400 font-medium" : "text-purple-400"}>
                                        {Math.round(fg.buildsWorth)} builds' runway
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            
            {/* Provenance Accordion */}
            <div className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950/30">
                <button
                    onClick={() => setShowProvenance(!showProvenance)}
                    className="w-full px-4 py-2 flex items-center justify-between text-left text-xs font-mono text-zinc-400 hover:bg-zinc-800/40 transition-colors"
                >
                    <span className="flex items-center gap-1.5">
                        <TrendingDown className="w-3.5 h-3.5 text-zinc-500" />
                        Aria Recommendation Provenance Trace ({item.recommendation.formulaVersion})
                    </span>
                    {showProvenance ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
                </button>
                
                {showProvenance && (
                    <div className="p-4 border-t border-zinc-800/80 space-y-3 bg-zinc-950/50 text-xs font-mono">
                        {/* Suggested Quantity Summary Box */}
                        <div className="p-2 rounded border border-zinc-800 bg-zinc-900/60 flex items-center justify-between">
                            <span className="text-zinc-400">Calculated Suggested Quantity:</span>
                            <span className="text-zinc-200 font-bold bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                                {item.recommendation.suggestedQty.toLocaleString()} units
                            </span>
                        </div>
                        
                        {/* Individual Trace Steps */}
                        <div className="relative border-l border-zinc-800 ml-2 pl-4 space-y-4">
                            {item.recommendation.provenance.map((step, idx) => (
                                <div key={idx} className="relative">
                                    <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full border border-zinc-800 bg-zinc-950" />
                                    <div className="space-y-0.5">
                                        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">
                                            {step.step}
                                        </span>
                                        <p className="text-zinc-300 leading-relaxed">
                                            {step.detail}
                                        </p>
                                        {step.value !== undefined && (
                                            <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/20 px-1 py-0.2 rounded border border-emerald-950 inline-block">
                                                value: {step.value}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
