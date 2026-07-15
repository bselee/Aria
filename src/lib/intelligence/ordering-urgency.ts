/**
 * @file    src/lib/intelligence/ordering-urgency.ts
 * @purpose "Right Now" ordering intelligence. Cuts through the noise of
 *          121 items across 65 vendors to surface ONLY what needs ordering
 *          immediately. Separates BOM (manufacturing-impact) from resale
 *          (retail-impact) with clear build-level consequences.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db, @/lib/finale/purchasing
 *
 * BILL'S RULE: "If I am chatting, it is a needed item and should be
 * deemed important." — natural language ordering via Telegram takes
 * priority over automated recommendations.
 */

import { createClient } from "@/lib/db";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UrgentOrderItem {
    productId: string;
    productName: string;
    vendorName: string;
    vendorPartyId: string;
    urgency: "critical" | "warning";
    itemType: "bom-component" | "resale" | "resale-bom";
    // Stock
    stockOnHand: number;
    stockOnOrder: number;
    suggestedQty: number;
    unitPrice: number;
    // Velocity
    dailyRate: number;
    dailyRateSource: string;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;
    // Manufacturing impact (BOM only)
    feedsBuilds?: Array<{ sku: string; name: string; dailySalesRate: number }>;
    earliestBuildDate?: string;
    buildShortfall?: number;
    // Retail impact
    projectedStockoutDate?: string;
    // What triggered this recommendation
    triggerReason?: string;
    triggerDetail?: string;
}

export interface OrderingReport {
    rightNow: UrgentOrderItem[];       // Order today or lose money
    thisWeek: UrgentOrderItem[];       // Order this week
    buildAtRisk: UrgentOrderItem[];    // BOM components blocking builds
    retailAtRisk: UrgentOrderItem[];   // Resale items about to stock out
    summary: {
        totalUrgent: number;
        buildBlockers: number;
        retailStockouts: number;
        estimatedCost: number;
    };
}

export interface BuildRisk {
    buildSku: string;
    buildName: string;
    buildDate: string;
    missingComponents: Array<{
        productId: string;
        productName: string;
        shortage: number;
        vendorName: string;
    }>;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Determine if an item needs ordering RIGHT NOW (today) vs this week vs later.
 *
 * Rules:
 *   - RIGHT NOW: runway < lead time, OR build shortage with build in < 3 days
 *   - THIS WEEK: runway < lead time + 7 days, OR build shortage in < 7 days
 *   - LATER: everything else
 */
export function classifyUrgencyTier(item: {
    urgency: string;
    runwayDays: number;
    leadTimeDays: number;
    adjustedRunwayDays: number;
    suggestedQty: number;
    itemType: string;
    triggerReason?: string;
    earliestBuildDate?: string;
}): "right-now" | "this-week" | "later" {
    const effectiveRunway = item.adjustedRunwayDays || item.runwayDays;

    // BOM component with imminent build shortage
    if (item.itemType === "bom-component" && item.triggerReason === "build-driven") {
        if (item.earliestBuildDate) {
            const buildDate = new Date(item.earliestBuildDate);
            const daysUntilBuild = Math.ceil((buildDate.getTime() - Date.now()) / 86400000);
            if (daysUntilBuild <= 3 && item.suggestedQty > 0) return "right-now";
            if (daysUntilBuild <= 7 && item.suggestedQty > 0) return "this-week";
        }
    }

    // Stock-based urgency
    if (item.urgency === "critical") {
        if (effectiveRunway < item.leadTimeDays && item.suggestedQty > 0) return "right-now";
        if (effectiveRunway < item.leadTimeDays + 7) return "this-week";
    }

    // Warning items with very low runway
    if (item.urgency === "warning" && effectiveRunway < 14 && item.suggestedQty > 0) {
        return "this-week";
    }

    return "later";
}

// ── Report Generation ───────────────────────────────────────────────────────

/**
 * Build the ordering urgency report from purchasing intelligence data.
 * This is designed to be called from Telegram (/ordernow) to give Bill
 * exactly what he needs to see — nothing more, nothing less.
 */
export function buildOrderingReport(
    groups: Array<{
        vendorName: string;
        vendorPartyId: string;
        urgency: string;
        items: Array<{
            productId: string;
            productName: string;
            unitPrice: number;
            stockOnHand: number;
            stockOnOrder: number;
            suggestedQty: number;
            dailyRate?: number;
            dailyRateSource?: string;
            runwayDays: number;
            adjustedRunwayDays: number;
            leadTimeDays: number;
            urgency: string;
            itemType: string;
            triggerReason?: string;
            triggerDetail?: string;
            feedsFinishedGoods?: Array<{ sku: string; name: string; dailySalesRate: number }>;
            forwardDemandEntry?: {
                earliestBuildDate?: string;
                requiredQty?: number;
            };
            openPOs?: Array<{ orderId: string; quantity: number }>;
        }>;
    }>,
): OrderingReport {
    const report: OrderingReport = {
        rightNow: [],
        thisWeek: [],
        buildAtRisk: [],
        retailAtRisk: [],
        summary: { totalUrgent: 0, buildBlockers: 0, retailStockouts: 0, estimatedCost: 0 },
    };

    for (const group of groups) {
        for (const item of group.items) {
            const tier = classifyUrgencyTier({
                ...item,
                earliestBuildDate: item.forwardDemandEntry?.earliestBuildDate,
            });

            const urgentItem: UrgentOrderItem = {
                productId: item.productId,
                productName: item.productName,
                vendorName: group.vendorName,
                vendorPartyId: group.vendorPartyId,
                urgency: item.urgency as "critical" | "warning",
                itemType: item.itemType as "bom-component" | "resale" | "resale-bom",
                stockOnHand: item.stockOnHand,
                stockOnOrder: item.stockOnOrder,
                suggestedQty: item.suggestedQty,
                unitPrice: item.unitPrice || 0,
                dailyRate: item.dailyRate || 0,
                dailyRateSource: item.dailyRateSource || "unknown",
                runwayDays: item.runwayDays,
                adjustedRunwayDays: item.adjustedRunwayDays,
                leadTimeDays: item.leadTimeDays,
                feedsBuilds: item.feedsFinishedGoods,
                earliestBuildDate: item.forwardDemandEntry?.earliestBuildDate,
                buildShortfall: item.forwardDemandEntry?.requiredQty
                    ? item.forwardDemandEntry.requiredQty - item.stockOnHand
                    : undefined,
                triggerReason: item.triggerReason,
                triggerDetail: item.triggerDetail,
            };

            if (tier === "right-now") {
                report.rightNow.push(urgentItem);
                report.summary.totalUrgent++;
                if (item.itemType === "bom-component") report.summary.buildBlockers++;
                else report.summary.retailStockouts++;
                report.summary.estimatedCost += item.suggestedQty * (item.unitPrice || 0);
            } else if (tier === "this-week") {
                report.thisWeek.push(urgentItem);
            }

            if (item.itemType === "bom-component") {
                report.buildAtRisk.push(urgentItem);
            } else if (item.urgency === "critical" || item.urgency === "warning") {
                report.retailAtRisk.push(urgentItem);
            }
        }
    }

    // Sort right-now by urgency then runway
    report.rightNow.sort((a, b) => {
        if (a.itemType === "bom-component" && b.itemType !== "bom-component") return -1;
        if (a.itemType !== "bom-component" && b.itemType === "bom-component") return 1;
        return a.adjustedRunwayDays - b.adjustedRunwayDays;
    });

    report.thisWeek.sort((a, b) => a.adjustedRunwayDays - b.adjustedRunwayDays);

    return report;
}

/**
 * Format the ordering report for Telegram.
 * Designed for Bill: actionable, concise, manufacturing-first.
 */
export function formatOrderingReport(report: OrderingReport): string {
    if (report.rightNow.length === 0 && report.thisWeek.length === 0) {
        return "✅ *No urgent orders needed.* Current stock + open POs cover all demand.";
    }

    const lines: string[] = [];

    // RIGHT NOW section
    if (report.rightNow.length > 0) {
        lines.push(`🔴 *ORDER RIGHT NOW — ${report.rightNow.length} items*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const item of report.rightNow.slice(0, 8)) {
            const icon = item.itemType === "bom-component" ? "🏭" : "📦";
            const cost = item.suggestedQty * item.unitPrice;
            lines.push(`${icon} *${item.productName.slice(0, 40)}*`);
            lines.push(`   ${item.vendorName} — Qty: ${item.suggestedQty} | $${cost.toFixed(0)}`);
            lines.push(`   Runway: ${item.adjustedRunwayDays.toFixed(1)}d | Lead: ${item.leadTimeDays}d`);

            if (item.itemType === "bom-component" && item.feedsBuilds?.length) {
                const buildNames = item.feedsBuilds.slice(0, 3).map(b => b.sku).join(", ");
                lines.push(`   Feeds: ${buildNames}${item.feedsBuilds.length > 3 ? ` +${item.feedsBuilds.length - 3} more` : ""}`);
            }
            if (item.triggerDetail) {
                lines.push(`   _${item.triggerDetail.slice(0, 80)}_`);
            }
            lines.push("");
        }

        if (report.rightNow.length > 8) {
            lines.push(`   _...and ${report.rightNow.length - 8} more_\n`);
        }
    }

    // THIS WEEK section
    if (report.thisWeek.length > 0) {
        lines.push(`🟡 *ORDER THIS WEEK — ${report.thisWeek.length} items*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const item of report.thisWeek.slice(0, 5)) {
            const icon = item.itemType === "bom-component" ? "🏭" : "📦";
            const cost = item.suggestedQty * item.unitPrice;
            lines.push(`${icon} ${item.productName.slice(0, 40)} — ${item.vendorName}`);
            lines.push(`   Qty: ${item.suggestedQty} | $${cost.toFixed(0)} | ${item.adjustedRunwayDays.toFixed(1)}d`);
        }

        if (report.thisWeek.length > 5) {
            lines.push(`   _...and ${report.thisWeek.length - 5} more_\n`);
        }
    }

    // Summary
    lines.push(`\n📊 *Summary*`);
    lines.push(`   Urgent: ${report.summary.totalUrgent} | Build blockers: ${report.summary.buildBlockers}`);
    lines.push(`   Est. cost: $${report.summary.estimatedCost.toFixed(0)}`);

    return lines.join("\n");
}
