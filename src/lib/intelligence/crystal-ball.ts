/**
 * @file    src/lib/intelligence/crystal-ball.ts
 * @purpose "Never Run Out" projection engine. For every purchasing
 *          item flagged urgent, answers: "If not ordered today,
 *          when will this stock out, and what builds does it kill?"
 *
 *          The Crystal Ball lives AT the purchasing interface — it
 *          takes the same PurchasingItem data the dashboard sees and
 *          enriches it with forward projections visible to Bill in
 *          one Telegram command (/ball).
 *
 *          Separates manufacturing impact from retail impact clearly.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/finale/purchasing (for item types)
 *
 * PHILOSOPHY:
 *   The reorder engine does velocity math. The Crystal Ball does
 *   consequence math. Velocity tells you "you're running out in
 *   12 days." Consequence tells you "and when that happens, you
 *   can't build 3.0 for 4 weeks, which is $12K in lost sales."
 *
 *   Manufacturing-first. Retail visible but secondary.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface ForwardProjection {
    /** The item that's being projected */
    productId: string;
    productName: string;
    vendorName: string;
    vendorPartyId: string;

    /** Runway math (from purchasing engine) */
    stockOnHand: number;
    stockOnOrder: number;
    dailyRate: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;

    /** "If not ordered today…" */
    projectedStockoutDate: string;         // ISO date when stock hits zero
    daysUntilStockout: number;
    reorderDeadline: string;               // Last day to order and still get before stockout
    daysUntilDeadline: number;

    /** Manufacturing impact (BOM components only) */
    itemType: "bom-component" | "resale" | "resale-bom";
    feedsFinishedBuilds: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        /** How many days this build can keep going after component stockout */
        buildBufferDays: number;
        /** Projected date this build can no longer be manufactured */
        buildStopsDate: string;
    }>;

    /** Retail impact (resale items) */
    monthlyRevenueImpact: number;           // $/day × 30 days until next restock
    daysLostSalesPerYear: number;          // forecast annual stockout days

    /** What should happen */
    suggestedAction: "order-today" | "order-this-week" | "monitor";
    suggestedQty: number;
    priorityScore: number;                  // 0-100 composite urgency score
}

export interface CrystalBallReport {
    /** Items that will kill builds if not ordered NOW */
    buildBlockers: ForwardProjection[];

    /** Items that need ordering this week */
    urgentItems: ForwardProjection[];

    /** Summary for Telegram */
    summary: {
        totalBuildBlockers: number;
        blockedBuildNames: string[];
        totalUrgentItems: number;
        totalMonthlyRisk: number;           // $ at risk this month
        itemsNeedingOrderToday: string[];   // product names, for Bill's quick scan
    };

    generatedAt: string;
    nextProjectionDue: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Lead time safety factor — order this many days before theoretical deadline */
const ORDER_SAFETY_DAYS = 3;

/** Items with negative or near-zero daily velocity get a conservative floor */
const MIN_DAILY_RATE = 0.05;

/** Max projection horizon (days) — anything beyond this is "monitor" */
const MAX_PROJECTION_HORIZON = 90;

/** Revenue multiplier for annualized stockout projection */
const ANNUALIZED_FACTOR = 365;

// ── Core Projection Logic ───────────────────────────────────────────────────

/**
 * Project forward: given current stock, daily consumption, and lead time,
 * compute the date stock reaches zero and the last safe reorder date.
 */
export function projectStockout(item: {
    stockOnHand: number;
    stockOnOrder: number;
    dailyRate: number;
    leadTimeDays: number;
}): { stockoutDate: string; daysUntilStockout: number; reorderDeadline: string; daysUntilDeadline: number } {
    const rate = Math.max(item.dailyRate, MIN_DAILY_RATE);
    const effectiveStock = item.stockOnHand + item.stockOnOrder;

    // Days until zero stock
    const daysUntilStockout = effectiveStock / rate;

    // Reorder deadline = stockout - leadTime - safety buffer
    const daysUntilDeadline = Math.max(0, daysUntilStockout - item.leadTimeDays - ORDER_SAFETY_DAYS);

    const now = new Date();
    const stockoutDate = new Date(now.getTime() + daysUntilStockout * 86400000);
    const deadlineDate = new Date(now.getTime() + daysUntilDeadline * 86400000);

    return {
        stockoutDate: stockoutDate.toISOString().split("T")[0],
        daysUntilStockout: Math.round(daysUntilStockout * 10) / 10,
        reorderDeadline: deadlineDate.toISOString().split("T")[0],
        daysUntilDeadline: Math.round(daysUntilDeadline * 10) / 10,
    };
}

/**
 * Composite priority score (0-100). Higher = more urgent.
 *
 * Components:
 *   - Runway risk:    40 points for stockout < leadTime, 30 for < 2× leadTime
 *   - Build impact:   30 points for each blocked build (cap 30)
 *   - Revenue impact: 20 points for high-revenue items
 *   - Timeline:       10 points if deadline has already passed or is today
 */
export function computePriorityScore(item: {
    adjustedRunwayDays: number;
    leadTimeDays: number;
    itemType: string;
    feedsFinishedBuilds?: Array<any>;
    dailyRate: number;
    unitPrice: number;
    daysUntilStockout: number;
    daysUntilDeadline: number;
}): number {
    let score = 0;

    // 1. Runway risk (0-40)
    const runwayRatio = item.adjustedRunwayDays / Math.max(item.leadTimeDays, 1);
    if (runwayRatio < 1) score += 40;
    else if (runwayRatio < 1.5) score += 30;
    else if (runwayRatio < 2) score += 20;
    else if (runwayRatio < 3) score += 10;

    // 2. Build impact (0-30)
    if (item.itemType === "bom-component" && item.feedsFinishedBuilds?.length) {
        score += Math.min(item.feedsFinishedBuilds.length * 10, 30);
    }

    // 3. Revenue impact (0-20)
    const dailyRevenue = item.dailyRate * (item.unitPrice || 0);
    if (dailyRevenue > 1000) score += 20;
    else if (dailyRevenue > 500) score += 15;
    else if (dailyRevenue > 100) score += 10;
    else if (dailyRevenue > 50) score += 5;

    // 4. Timeline urgency (0-10)
    if (item.daysUntilDeadline <= 0) score += 10;      // Already past deadline
    else if (item.daysUntilDeadline <= 1) score += 8;   // Today
    else if (item.daysUntilDeadline <= 3) score += 5;   // This week

    return Math.min(score, 100);
}

// ── Report Generation ───────────────────────────────────────────────────────

/**
 * Build the full Crystal Ball report from purchasing intelligence data.
 *
 * @param groups - The same PurchasingGroup[] that powers the dashboard and /ordernow
 * @returns CrystalBallReport with forward projections and build-blocker list
 */
export function buildCrystalBallReport(
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
            stockoutDays?: number | null;
        }>;
    }>,
): CrystalBallReport {
    const report: CrystalBallReport = {
        buildBlockers: [],
        urgentItems: [],
        summary: {
            totalBuildBlockers: 0,
            blockedBuildNames: [],
            totalUrgentItems: 0,
            totalMonthlyRisk: 0,
            itemsNeedingOrderToday: [],
        },
        generatedAt: new Date().toISOString(),
        nextProjectionDue: new Date(Date.now() + 6 * 3600000).toISOString(),
    };

    const blockedBuildNames = new Set<string>();
    const allProjections: ForwardProjection[] = [];

    for (const group of groups) {
        for (const item of group.items) {
            // Only project items that are actually at risk
            if (item.urgency !== "critical" && item.urgency !== "warning") continue;
            if (!item.suggestedQty || item.suggestedQty <= 0) continue;

            const projection = projectStockout({
                stockOnHand: item.stockOnHand,
                stockOnOrder: item.stockOnOrder,
                dailyRate: item.dailyRate || MIN_DAILY_RATE,
                leadTimeDays: item.leadTimeDays,
            });

            // Compute build impact
            const feedsFinishedBuilds = (item.feedsFinishedGoods || []).map(fg => {
                // Build buffer: how long the build's own stock lasts
                const buildComponentShare = 1 / Math.max(item.feedsFinishedGoods?.length || 1, 1);
                const buildBufferDays = (item.stockOnHand * buildComponentShare) / Math.max(fg.dailySalesRate, MIN_DAILY_RATE);

                const buildStopsDate = new Date(
                    Date.now() + buildBufferDays * 86400000
                ).toISOString().split("T")[0];

                return {
                    sku: fg.sku,
                    name: fg.name,
                    dailySalesRate: fg.dailySalesRate,
                    buildBufferDays: Math.round(buildBufferDays * 10) / 10,
                    buildStopsDate,
                };
            });

            // Revenue impact
            const dailyRevenue = (item.dailyRate || 0) * (item.unitPrice || 0);
            const monthlyRevenueImpact = Math.round(dailyRevenue * 30);
            const daysLostSalesPerYear = Math.max(0,
                ANNUALIZED_FACTOR - (item.adjustedRunwayDays * ANNUALIZED_FACTOR / 365)
            );

            // Suggested action
            let suggestedAction: ForwardProjection["suggestedAction"] = "monitor";
            if (item.urgency === "critical" && projection.daysUntilDeadline <= 1) {
                suggestedAction = "order-today";
            } else if (item.urgency === "critical" || (item.urgency === "warning" && projection.daysUntilDeadline <= 7)) {
                suggestedAction = "order-this-week";
            }

            const priorityScore = computePriorityScore({
                adjustedRunwayDays: item.adjustedRunwayDays,
                leadTimeDays: item.leadTimeDays,
                itemType: item.itemType,
                feedsFinishedBuilds: item.feedsFinishedGoods,
                dailyRate: item.dailyRate || 0,
                unitPrice: item.unitPrice || 0,
                daysUntilStockout: projection.daysUntilStockout,
                daysUntilDeadline: projection.daysUntilDeadline,
            });

            const fp: ForwardProjection = {
                productId: item.productId,
                productName: item.productName,
                vendorName: group.vendorName,
                vendorPartyId: group.vendorPartyId,
                stockOnHand: item.stockOnHand,
                stockOnOrder: item.stockOnOrder,
                dailyRate: item.dailyRate || 0,
                runwayDays: item.runwayDays,
                adjustedRunwayDays: item.adjustedRunwayDays,
                leadTimeDays: item.leadTimeDays,
                projectedStockoutDate: projection.stockoutDate,
                daysUntilStockout: projection.daysUntilStockout,
                reorderDeadline: projection.reorderDeadline,
                daysUntilDeadline: projection.daysUntilDeadline,
                itemType: (item.itemType === "bom-component" ? "bom-component" :
                    item.itemType === "resale-bom" ? "resale-bom" : "resale") as ForwardProjection["itemType"],
                feedsFinishedBuilds,
                monthlyRevenueImpact,
                daysLostSalesPerYear: Math.round(daysLostSalesPerYear),
                suggestedAction,
                suggestedQty: item.suggestedQty,
                priorityScore,
            };

            allProjections.push(fp);

            // Track blocked builds
            if (feedsFinishedBuilds.length > 0 && suggestedAction !== "monitor") {
                for (const b of feedsFinishedBuilds) {
                    blockedBuildNames.add(b.name || b.sku);
                }
                report.buildBlockers.push(fp);
            } else if (suggestedAction !== "monitor") {
                report.urgentItems.push(fp);
            }

            if (suggestedAction === "order-today") {
                report.summary.itemsNeedingOrderToday.push(item.productName);
            }

            report.summary.totalMonthlyRisk += monthlyRevenueImpact;
        }
    }

    // Sort by priority score descending
    report.buildBlockers.sort((a, b) => b.priorityScore - a.priorityScore);
    report.urgentItems.sort((a, b) => b.priorityScore - a.priorityScore);

    report.summary.totalBuildBlockers = report.buildBlockers.length;
    report.summary.blockedBuildNames = [...blockedBuildNames].slice(0, 15);
    report.summary.totalUrgentItems = report.buildBlockers.length + report.urgentItems.length;

    return report;
}

/**
 * Format the Crystal Ball report for Telegram. Clean and actionable.
 */
export function formatCrystalBallReport(report: CrystalBallReport): string {
    const lines: string[] = [];

    lines.push(`🔮 *Crystal Ball — What Happens If Nothing Is Ordered*`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (report.buildBlockers.length === 0 && report.urgentItems.length === 0) {
        lines.push(`✅ All stock + open POs cover demand. No projected stockouts.`);
        return lines.join("\n");
    }

    // BUILD BLOCKERS (manufacturing-first)
    if (report.buildBlockers.length > 0) {
        lines.push(`🏭 *${report.buildBlockers.length} BUILD BLOCKERS* — components that kill manufacturing`);
        lines.push("");

        for (const item of report.buildBlockers.slice(0, 5)) {
            lines.push(`• *${item.productName.slice(0, 45)}*`);
            lines.push(`  📉 Stockout: ${item.projectedStockoutDate} (${item.daysUntilStockout.toFixed(1)}d)`);
            lines.push(`  ⏰ Deadline: ${item.reorderDeadline} (${item.daysUntilDeadline < 0 ? "OVERDUE" : `${item.daysUntilDeadline.toFixed(1)}d`})`);

            if (item.feedsFinishedBuilds.length > 0) {
                const buildNames = item.feedsFinishedBuilds.slice(0, 3).map(b =>
                    `${b.sku}: stops ${b.buildStopsDate}`
                ).join(", ");
                lines.push(`  🔨 Kills: ${buildNames}`);
            }

            const cost = item.suggestedQty * (item.stockOnHand > 0 ? item.monthlyRevenueImpact / 30 : 0) || 0;
            lines.push(`  💰 ${item.vendorName} | Qty: ${item.suggestedQty} | Risk: $${item.monthlyRevenueImpact}/mo`);
            lines.push("");
        }

        if (report.buildBlockers.length > 5) {
            lines.push(`  _...and ${report.buildBlockers.length - 5} more_\n`);
        }
    }

    // URGENT RETAIL ITEMS
    if (report.urgentItems.length > 0) {
        lines.push(`📦 *${report.urgentItems.length} RETAIL ITEMS AT RISK*`);
        lines.push("");

        for (const item of report.urgentItems.slice(0, 4)) {
            lines.push(`• *${item.productName.slice(0, 45)}*`);
            lines.push(`  📉 Stockout: ${item.projectedStockoutDate} | ${item.vendorName}`);
            lines.push(`  💰 Risk: $${item.monthlyRevenueImpact}/mo | Qty: ${item.suggestedQty}`);
            lines.push("");
        }

        if (report.urgentItems.length > 4) {
            lines.push(`  _...and ${report.urgentItems.length - 4} more_\n`);
        }
    }

    // SUMMARY
    lines.push(`📊 *Risk Summary*`);
    lines.push(`  🏭 Build blockers: ${report.summary.totalBuildBlockers}`);
    lines.push(`  📦 Retail at risk: ${report.urgentItems.length}`);
    lines.push(`  💸 Monthly risk: $${report.summary.totalMonthlyRisk.toLocaleString()}`);
    lines.push(`  🔴 Order today: ${report.summary.itemsNeedingOrderToday.length}`);

    if (report.summary.blockedBuildNames.length > 0) {
        lines.push(`  🔨 Affected builds: ${report.summary.blockedBuildNames.join(", ")}`);
    }

    lines.push("");
    lines.push(`_Generated ${new Date(report.generatedAt).toLocaleTimeString()}. Next update in 6h._`);

    return lines.join("\n");
}
