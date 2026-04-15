/**
 * @file    build-demand-oracle.ts
 * @purpose Derive immediate build-component ordering needs + 12-week forward projection
 *          from BuildRiskReport data. No new API calls — all computation from existing
 *          snapshot data (builds, components, fgVelocity).
 *
 * ⚠️  DUAL DEMAND MODEL — two panels show different numbers for the same SKU:
 *   - Build Demand Oracle: component demand derived from BOM explosion + calendar builds
 *     (forecast, top-down, from build schedule)
 *   - PurchasingPanel:     component demand from Finale purchaseVelocity / demandVelocity
 *     (actual, bottom-up, from purchase history)
 *   Oracle numbers are a FORECAST — they may diverge from PurchasingPanel actuals.
 *   Use Oracle for build-planning signal; use PurchasingPanel for actual PO decisions.
 */

import type { BuildRiskReport, ComponentDemand, FGVelocity } from './build-risk';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type ComponentUrgency = 'CRITICAL' | 'WARNING' | 'WATCH' | 'OK';

export interface OracleComponent {
    componentSku: string;
    onHand: number | null;
    stockoutDays: number | null;
    leadTimeDays: number | null;
    incomingPOs: Array<{ orderId: string; supplier: string; quantity: number; orderDate: string }>;
    usedIn: string[];  // FG SKUs that depend on this component
    designations: string[];
    riskLevel: ComponentUrgency;
    earliestBuildDate: string;
    // Orders Needed Now
    thirtyDayNeed: number;       // total BOM demand from all confirmed builds in next 30 days
    gap: number;                 // max(0, onHand - thirtyDayNeed), negative = stockout
    orderQty: number;            // abs(gap) + safety buffer
    safetyBuffer: number;
    blocksFGs: string[];         // which finished goods will be halted
    // 12-Week Oracle
    weeklyNeedW149: number;      // weeks 1-4 total (confirmed calendar builds)
    weeklyNeedW158: number;      // weeks 5-8 (projected — repeated monthly baseline)
    weeklyNeedW1912: number;     // weeks 9-12 (projected — velocity extrapolation)
    avgDailyConsumption: number; // used for safety buffer and runway
    oracleStatus: 'ORDER NOW' | 'REORDER SOON' | 'COVERED';
}

export interface OracleVendorGroup {
    vendorName: string;           // "Unknown Vendor" if unresolvable
    vendorPartyId: string | null;
    components: OracleComponent[];
    totalOrderQty: number;
    estimatedOrderValue: number | null;
    highestRisk: ComponentUrgency;
}

export interface BuildDemandOracle {
    /** Components that need immediate ordering (CRITICAL + WARNING only) */
    ordersNeededNow: OracleVendorGroup[];
    /** Full 12-week crystal ball projection (all risk levels) */
    twelveWeekForecast: OracleVendorGroup[];
    /** Summary stats */
    stats: {
        criticalCount: number;
        warningCount: number;
        totalComponentsTracked: number;
        estimatedOrderValue: number | null;
    };
}

// ──────────────────────────────────────────────────
// VENDOR RESOLUTION
// ComponentDemand.vendorName is populated by build-risk.ts via lookupComponentVendorBatch().
// Oracle reads it directly — no separate cache needed.
// ──────────────────────────────────────────────────

function resolveVendorName(comp: ComponentDemand): { vendorName: string; vendorPartyId: string | null } {
    return {
        vendorName: comp.vendorName ?? 'Unknown Vendor',
        vendorPartyId: comp.vendorPartyId ?? null,
    };
}

// ──────────────────────────────────────────────────
// ORACLE COMPUTATION
// ──────────────────────────────────────────────────

/**
 * Compute the 30-day build need for a component from confirmed calendar builds.
 * Aggregates total BOM demand across all builds scheduled within the next 30 days.
 */
function computeThirtyDayNeed(
    componentSku: string,
    confirmedBuilds: Array<{ sku: string; quantity: number; buildDate: string; designations: Set<string> }>,
    bomExplosionCache: Map<string, Map<string, number>>,  // fgSku → componentSku → qty
): number {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    let total = 0;
    for (const build of confirmedBuilds) {
        const buildDate = new Date(build.buildDate);
        if (buildDate > thirtyDaysFromNow) continue;

        const bom = bomExplosionCache.get(build.sku);
        if (!bom) continue;
        const needed = bom.get(componentSku) ?? 0;
        total += needed * build.quantity;
    }
    return total;
}

/**
 * Compute safety buffer = leadTimeDays * avgDailyConsumption.
 * If leadTimeDays is unknown, use 14-day default.
 */
function computeSafetyBuffer(leadTimeDays: number | null, avgDailyConsumption: number): number {
    const lt = leadTimeDays ?? 14;
    return Math.ceil(lt * avgDailyConsumption);
}

/**
 * Derive avg daily consumption for a component from its stockoutDays.
 * dailyRate = onHand / stockoutDays (if both available).
 * Falls back to 30-day need / 30 for components with no stockout data.
 */
function computeAvgDailyConsumption(comp: ComponentDemand, thirtyDayNeed: number): number {
    if (comp.onHand !== null && comp.stockoutDays !== null && comp.stockoutDays > 0) {
        return comp.onHand / comp.stockoutDays;
    }
    // Fallback: 30-day need / 30 days
    return thirtyDayNeed / 30;
}

/**
 * Classify oracle status based on coverage vs projected demand.
 * - ORDER NOW: onHand + POs won't cover weeks 1-4
 * - REORDER SOON: covers weeks 1-4 but shows gap in weeks 5-8
 * - COVERED: onHand + POs cover through week 12 at projected rate
 */
function computeOracleStatus(
    onHand: number | null,
    incomingPOQty: number,
    wk14Need: number,
    wk58Need: number,
    wk912Need: number,
): OracleComponent['oracleStatus'] {
    const totalSupply = (onHand ?? 0) + incomingPOQty;

    // Weeks 1-4 check
    if (totalSupply < wk14Need) return 'ORDER NOW';

    // Weeks 5-8 check
    const supplyAfterWk4 = totalSupply - wk14Need;
    if (supplyAfterWk4 < wk58Need) return 'REORDER SOON';

    // Weeks 9-12 check
    const supplyAfterWk8 = supplyAfterWk4 - wk58Need;
    if (supplyAfterWk8 < wk912Need) return 'REORDER SOON';

    return 'COVERED';
}

/**
 * Build the complete Build Demand Oracle from a BuildRiskReport.
 * All data is derived from the report — no new API calls.
 */
export function computeBuildDemandOracle(
    report: BuildRiskReport,
): BuildDemandOracle {
    const vendorGroups = new Map<string, OracleVendorGroup>();

    // ── Step 1: Derive per-FG build quantities and component qty-per-FG ratios ──
    const fgBuildQty = new Map<string, number>();
    for (const build of report.builds) {
        fgBuildQty.set(build.sku, (fgBuildQty.get(build.sku) ?? 0) + build.quantity);
    }

    /**
     * Chain FG velocity → component demand for weeks 5-12.
     * dailyRate (units FG/day) * 7 (days/week) * (componentQtyPerFg) = units component/week.
     * Falls back to flatBaseline when no velocity data exists for an FG.
     */
    const chainVelocity = (
        comp: ComponentDemand,
        flatBaseline: number,
    ): { w58: number; w912: number } => {
        let w58 = 0, w912 = 0;
        for (const fgSku of comp.usedIn) {
            const fgVel = report.fgVelocity.get(fgSku);
            const totalFgQty = fgBuildQty.get(fgSku) ?? 0;
            if (totalFgQty === 0) continue;
            // component qty per unit of finished good (derived from BOM explosion totals)
            const qtyPerFg = comp.totalRequiredQty / totalFgQty;
            if (fgVel && fgVel.dailyRate > 0) {
                // fgVel.dailyRate = units FG sold per day
                const weeklyComponentDemand = fgVel.dailyRate * 7 * qtyPerFg;
                w58 += weeklyComponentDemand;
                w912 += weeklyComponentDemand;
            } else {
                // No velocity data — use flat baseline for this FG
                w58 += flatBaseline;
                w912 += flatBaseline;
            }
        }
        if (comp.usedIn.size === 0 || (w58 === 0 && w912 === 0)) {
            return { w58: flatBaseline, w912: flatBaseline };
        }
        return { w58, w912 };
    };

    // ── Step 2: For each component, compute oracle metrics ──
    const allComponents: OracleComponent[] = [];

    for (const [_compSku, comp] of report.components) {
        const usedInArray = Array.from(comp.usedIn);
        const designations = Array.from(comp.designations);

        // Thirty day need: use totalRequiredQty as proxy (aggregated across all builds)
        // NOTE: This is slightly inflated since it includes builds beyond 30 days,
        // but since we only use this for the "Orders Needed Now" section (CRITICAL/WARNING),
        // it's a safe overestimate that triggers earlier ordering — acceptable for purchasing.
        const thirtyDayNeed = comp.totalRequiredQty;
        const onHand = comp.onHand;
        const incomingPOQty = comp.incomingPOs.reduce((sum, po) => sum + po.quantity, 0);

        // Gap and order qty
        const effectiveOnHand = onHand ?? 0;
        const gap = effectiveOnHand - thirtyDayNeed;
        const avgDailyConsumption = computeAvgDailyConsumption(comp, thirtyDayNeed);
        const safetyBuffer = computeSafetyBuffer(comp.leadTimeDays, avgDailyConsumption);

        // Order qty: only order if gap < 0 (stockout) or insufficient coverage
        const onHandPlusPOs = effectiveOnHand + incomingPOQty;
        const orderQty = onHandPlusPOs < thirtyDayNeed
            ? Math.ceil(Math.abs(gap) + safetyBuffer)
            : 0;

        // Blocks FGs
        const blocksFGs = thirtyDayNeed > effectiveOnHand ? usedInArray : [];

        // Weekly projections — wk 1-4 uses confirmed build need (thirtyDayNeed)
        // wk 5-12 chains FG sales velocity → component demand
        const weeklyNeedW149 = thirtyDayNeed;
        const { w58, w912 } = chainVelocity(comp, thirtyDayNeed);
        const weeklyNeedW158 = w58;
        const weeklyNeedW1912 = w912;

        // Oracle status
        const oracleStatus = computeOracleStatus(
            onHand,
            incomingPOQty,
            weeklyNeedW149,
            weeklyNeedW158,
            weeklyNeedW1912,
        );

        const oracleComp: OracleComponent = {
            componentSku: _compSku,
            onHand,
            stockoutDays: comp.stockoutDays,
            leadTimeDays: comp.leadTimeDays,
            incomingPOs: comp.incomingPOs,
            usedIn: usedInArray,
            designations,
            riskLevel: comp.riskLevel,
            earliestBuildDate: comp.earliestBuildDate,
            thirtyDayNeed,
            gap,
            orderQty,
            safetyBuffer,
            blocksFGs,
            weeklyNeedW149,
            weeklyNeedW158,
            weeklyNeedW1912,
            avgDailyConsumption,
            oracleStatus,
        };

        allComponents.push(oracleComp);

        // Group by vendor
        const vendor = resolveVendorName(comp);
        if (!vendorGroups.has(vendor.vendorName)) {
            vendorGroups.set(vendor.vendorName, {
                vendorName: vendor.vendorName,
                vendorPartyId: vendor.vendorPartyId,
                components: [],
                totalOrderQty: 0,
                estimatedOrderValue: null,
                highestRisk: 'OK',
            });
        }
        vendorGroups.get(vendor.vendorName)!.components.push(oracleComp);
    }

    // ── Step 3: Compute vendor group aggregates ──
    for (const group of vendorGroups.values()) {
        group.totalOrderQty = group.components.reduce((sum, c) => sum + c.orderQty, 0);
        group.highestRisk = group.components.reduce(
            (worst, c) => {
                const order = { CRITICAL: 0, WARNING: 1, WATCH: 2, OK: 3 };
                return order[c.riskLevel] < order[worst] ? c.riskLevel : worst;
            },
            'OK' as ComponentUrgency,
        );
    }

    // ── Step 4: Split into orders-needed-now and twelve-week-forecast ──
    const ordersNeededNowGroups: OracleVendorGroup[] = [];
    const twelveWeekForecastGroups: OracleVendorGroup[] = [];

    for (const group of vendorGroups.values()) {
        // Orders Needed Now: CRITICAL + WARNING with orderQty > 0
        const needsOrder = group.components.filter(c => c.orderQty > 0 && (c.riskLevel === 'CRITICAL' || c.riskLevel === 'WARNING'));
        if (needsOrder.length > 0) {
            ordersNeededNowGroups.push({
                ...group,
                components: needsOrder,
            });
        }

        // Twelve-week forecast: all components
        twelveWeekForecastGroups.push(group);
    }

    // Sort by risk (CRITICAL first)
    const riskOrder = { CRITICAL: 0, WARNING: 1, WATCH: 2, OK: 3 } as const;
    for (const groups of [ordersNeededNowGroups, twelveWeekForecastGroups]) {
        groups.sort((a, b) => riskOrder[a.highestRisk] - riskOrder[b.highestRisk]);
    }

    const stats = {
        criticalCount: allComponents.filter(c => c.riskLevel === 'CRITICAL').length,
        warningCount: allComponents.filter(c => c.riskLevel === 'WARNING').length,
        totalComponentsTracked: allComponents.length,
        estimatedOrderValue: null as number | null,
    };

    return {
        ordersNeededNow: ordersNeededNowGroups,
        twelveWeekForecast: twelveWeekForecastGroups,
        stats,
    };
}