/**
 * @file    policy-engine.ts
 * @purpose Per-SKU purchasing decision gate: order vs hold with precise, human-readable reasons.
 * @author  Hermia
 * @created 2026-05-26
 * @updated 2026-07-10 — residual reorder language; runway-healthy hold
 */
import {
    createPurchasingAssessment,
    type PurchasingAssessment,
    type PurchasingReasonCode,
} from "./policy-types";

const HEALTHY_FINISHED_GOODS_COVERAGE_DAYS = 30;
const PACK_OVERBUY_MANUAL_REVIEW_RATIO = 3;
/** Days of post-lead buffer before we treat runway as comfortable (no order needed). */
const RUNWAY_SAFETY_BUFFER_DAYS = 30;
/** If suggested supply days exceed this at tiny daily rate, treat as noise. */
const MICRO_VELOCITY_MAX_SUPPLY_DAYS = 180;
const MICRO_VELOCITY_MAX_DAILY = 0.05;

export interface PurchasingCandidateInput {
    vendorName: string;
    productId: string;
    reorderMethod?: "do_not_reorder" | "manual" | "sales_velocity" | "demand_velocity" | "on_site_order" | "default";
    directDemand: number;
    bomDemand: number;
    stockOnHand: number;
    stockOnOrder: number;
    adjustedRunwayDays: number | null;
    finishedGoodsCoverageDays: number | null;
    leadTimeDays: number | null;
    suggestedQty: number;
    orderIncrementQty: number | null;
    minimumOrderQty: number | null;
    minimumOrderValue: number | null;
    unitPrice: number;
    /** True when the vendor has a committed PO in the cycle window — suppress all orders. */
    vendorCycleLocked?: boolean;
    /** Optional raw need before pack/historical floors (when known). */
    rawNeededEaches?: number | null;
}

function hasHealthyFinishedGoodsCoverage(days: number | null): boolean {
    return days !== null && days >= HEALTHY_FINISHED_GOODS_COVERAGE_DAYS;
}

function deriveEffectiveOrderQty(input: PurchasingCandidateInput): number {
    const minimum = Math.max(input.minimumOrderQty ?? 0, 0);
    const increment = Math.max(input.orderIncrementQty ?? 1, 1);
    const baseQty = Math.max(input.suggestedQty, minimum);
    return Math.ceil(baseQty / increment) * increment;
}

function isPackOverbuy(input: PurchasingCandidateInput, effectiveQty: number): boolean {
    if (input.suggestedQty <= 0) return false;
    return effectiveQty / input.suggestedQty >= PACK_OVERBUY_MANUAL_REVIEW_RATIO;
}

function resolveRunway(input: PurchasingCandidateInput): number | null {
    if (input.adjustedRunwayDays !== null && Number.isFinite(input.adjustedRunwayDays)) {
        return input.adjustedRunwayDays;
    }
    const daily = Math.max(input.directDemand, 0) + Math.max(input.bomDemand, 0);
    if (daily <= 0) return null;
    return (Math.max(input.stockOnHand, 0) + Math.max(input.stockOnOrder, 0)) / daily;
}

function orderPointDays(input: PurchasingCandidateInput): number {
    const lead = Math.max(0, input.leadTimeDays ?? 21);
    return lead + RUNWAY_SAFETY_BUFFER_DAYS;
}

function isOnOrderCoverageHealthy(input: PurchasingCandidateInput): boolean {
    if ((input.stockOnOrder ?? 0) <= 0) return false;
    const daily = Math.max(input.directDemand, 0) + Math.max(input.bomDemand, 0);
    const onHand = Math.max(input.stockOnHand, 0);
    const onOrder = Math.max(input.stockOnOrder, 0);
    // Prefer supply math over adjustedRunway field — that field can lag open-PO credit.
    if (daily > 0) {
        const needToOrderPoint = daily * orderPointDays(input);
        if (onHand + onOrder >= needToOrderPoint) return true;
    }
    const runway = resolveRunway(input);
    if (runway === null) {
        // Inbound supply, no demand signal — treat as covered.
        return true;
    }
    const baselineCoverage = Math.max(input.leadTimeDays ?? 0, HEALTHY_FINISHED_GOODS_COVERAGE_DAYS);
    return runway >= baselineCoverage;
}

/**
 * Runway already covers lead + 30d safety → do not recommend a new PO.
 * Historical floors / target-cover extras must not keep comfortable stock on the Order list.
 */
function isRunwayHealthy(input: PurchasingCandidateInput): boolean {
    const runway = resolveRunway(input);
    if (runway === null) return false;
    return runway >= orderPointDays(input);
}

function isUneconomicOrder(input: PurchasingCandidateInput, effectiveQty: number): boolean {
    if (!input.minimumOrderValue || input.minimumOrderValue <= 0) return false;
    return effectiveQty * input.unitPrice < input.minimumOrderValue;
}

/** Tiny burn + multi-year suggested supply = velocity noise, not a real buy. */
function isMicroVelocityNoise(input: PurchasingCandidateInput, effectiveQty: number): boolean {
    const daily = Math.max(input.directDemand, 0) + Math.max(input.bomDemand, 0);
    if (daily <= 0 || daily > MICRO_VELOCITY_MAX_DAILY) return false;
    if (effectiveQty <= 0) return false;
    const supplyDays = effectiveQty / daily;
    return supplyDays > MICRO_VELOCITY_MAX_SUPPLY_DAYS;
}

function fmtDays(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    if (n >= 100) return `${Math.round(n)}d`;
    return `${Math.round(n * 10) / 10}d`;
}

function fmtQty(n: number): string {
    return Math.round(n).toLocaleString("en-US");
}

function metricsOf(input: PurchasingCandidateInput, directDemand: number, bomDemand: number) {
    return {
        directDemand,
        bomDemand,
        sharedDemand: directDemand + bomDemand,
        stockOnHand: input.stockOnHand,
        stockOnOrder: input.stockOnOrder,
        adjustedRunwayDays: input.adjustedRunwayDays,
        finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
        leadTimeDays: input.leadTimeDays,
    };
}

function buildOrderExplanation(input: PurchasingCandidateInput, effectiveQty: number): {
    reasonCodes: PurchasingReasonCode[];
    explanation: string;
    confidence: "high" | "medium" | "low";
} {
    const runway = resolveRunway(input);
    const lead = Math.max(0, input.leadTimeDays ?? 21);
    const point = orderPointDays(input);
    const onOrder = input.stockOnOrder ?? 0;
    const onHand = input.stockOnHand ?? 0;
    const daily = Math.max(input.directDemand, 0) + Math.max(input.bomDemand, 0);

    if (onOrder > 0) {
        // Reorder shortfall = gap to order point after open PO credit (not full target cover).
        const supply = onHand + onOrder;
        const residualFromSupply = daily > 0
            ? Math.max(0, daily * point - supply)
            : Math.max(0, effectiveQty);
        const residual = Math.min(Math.max(0, effectiveQty), residualFromSupply);
        const dailyPart = daily > 0 ? ` at ${daily.toFixed(2)}/day` : "";
        // Open PO does not cover need → this is a reorder of the shortfall (can be critical).
        const critical = runway !== null && runway < lead;
        const codes: PurchasingReasonCode[] = ["residual_reorder", "direct_demand_support"];
        if (critical) codes.push("runway_below_lead");
        return {
            reasonCodes: codes,
            confidence: critical ? "high" : "medium",
            explanation:
                (critical ? "Reorder now (critical): " : "Reorder: ") +
                `on hand ${fmtQty(onHand)} + open PO ${fmtQty(onOrder)} is still short by ${fmtQty(residual)}` +
                `${dailyPart} (runway ${fmtDays(runway)} vs order point ${fmtDays(point)}). ` +
                `Order ${fmtQty(residual)} more — do not re-cover the open PO.`,
        };
    }

    if (runway !== null && runway < lead) {
        return {
            reasonCodes: ["direct_demand_support", "runway_below_lead"],
            confidence: "high",
            explanation:
                `Order now: runway ${fmtDays(runway)} is below lead ${fmtDays(lead)}. ` +
                `On hand ${fmtQty(onHand)}${daily > 0 ? ` at ${daily.toFixed(2)}/day` : ""}. ` +
                `Buy ${fmtQty(effectiveQty)} to restore cover.`,
        };
    }

    if (runway !== null && runway < point) {
        return {
            reasonCodes: ["direct_demand_support"],
            confidence: "high",
            explanation:
                `Order soon: runway ${fmtDays(runway)} is inside the order window ` +
                `(lead ${fmtDays(lead)} + ${RUNWAY_SAFETY_BUFFER_DAYS}d buffer = ${fmtDays(point)}). ` +
                `On hand ${fmtQty(onHand)}. Buy ${fmtQty(effectiveQty)}.`,
        };
    }

    return {
        reasonCodes: ["direct_demand_support"],
        confidence: "medium",
        explanation:
            `Buy ${fmtQty(effectiveQty)}: demand supports a reorder ` +
            `(runway ${fmtDays(runway)}, on hand ${fmtQty(onHand)}, lead ${fmtDays(lead)}).`,
    };
}

export function assessPurchasingCandidate(input: PurchasingCandidateInput): PurchasingAssessment {
    const effectiveQty = deriveEffectiveOrderQty(input);
    const directDemand = Math.max(input.directDemand, 0);
    const bomDemand = Math.max(input.bomDemand, 0);
    const sharedDemand = directDemand + bomDemand;
    const healthyFgCoverage = hasHealthyFinishedGoodsCoverage(input.finishedGoodsCoverageDays);
    const m = () => metricsOf(input, directDemand, bomDemand);

    if (isPackOverbuy(input, effectiveQty)) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "manual_review",
            recommendedQty: effectiveQty,
            confidence: "medium",
            reasonCodes: ["pack_size_forced_overbuy"],
            explanation:
                `Pack size would force ~${fmtQty(effectiveQty)} vs need ~${fmtQty(input.suggestedQty)} ` +
                `(≥${PACK_OVERBUY_MANUAL_REVIEW_RATIO}×). Review before ordering.`,
            metrics: m(),
        });
    }

    if (isOnOrderCoverageHealthy(input)) {
        const runway = resolveRunway(input);
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["on_order_already_covers_need"],
            explanation:
                `Hold: ${fmtQty(input.stockOnOrder)} on order already covers near-term need ` +
                `(runway ${fmtDays(runway)}, on hand ${fmtQty(input.stockOnHand)}). Chase that PO if delayed — do not re-order.`,
            metrics: m(),
        });
    }

    if (bomDemand > 0 && directDemand === 0 && healthyFgCoverage) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["fg_coverage_sufficient", "bom_demand_suppressed"],
            explanation:
                `Hold: finished goods have ≥${HEALTHY_FINISHED_GOODS_COVERAGE_DAYS}d coverage ` +
                `(${fmtDays(input.finishedGoodsCoverageDays)}). BOM pull is suppressed.`,
            metrics: m(),
        });
    }

    // Phantom qty from historical floors with comfortable runway → hold
    if (isRunwayHealthy(input)) {
        const runway = resolveRunway(input);
        const point = orderPointDays(input);
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["runway_healthy"],
            explanation:
                `Hold: runway ${fmtDays(runway)} is past the order point (${fmtDays(point)} = lead + ${RUNWAY_SAFETY_BUFFER_DAYS}d). ` +
                `On hand ${fmtQty(input.stockOnHand)}, on order ${fmtQty(input.stockOnOrder)}. No buy needed yet.`,
            metrics: m(),
        });
    }

    if (isMicroVelocityNoise(input, effectiveQty)) {
        const daily = sharedDemand;
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "medium",
            reasonCodes: ["micro_velocity_noise"],
            explanation:
                `Hold: burn ${daily.toFixed(3)}/day is near-zero; suggested ${fmtQty(effectiveQty)} is ` +
                `${Math.round(effectiveQty / daily)}d of supply (noise). Confirm real demand before buying.`,
            metrics: m(),
        });
    }

    if (isUneconomicOrder(input, effectiveQty)) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "medium",
            reasonCodes: ["order_economics_unclear"],
            explanation:
                `Hold: line value $${(effectiveQty * input.unitPrice).toFixed(0)} is below vendor min ` +
                `$${(input.minimumOrderValue ?? 0).toFixed(0)}. Batch with other SKUs or wait.`,
            metrics: m(),
        });
    }

    if (effectiveQty <= 0) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["no_order_quantity_recommended"],
            explanation:
                `Hold: after stock (${fmtQty(input.stockOnHand)}) and open POs (${fmtQty(input.stockOnOrder)}), ` +
                `recommended qty is 0.`,
            metrics: m(),
        });
    }

    // Cap residual reorder qty to order-point shortfall when open PO already exists.
    let orderQty = effectiveQty;
    if ((input.stockOnOrder ?? 0) > 0) {
        const daily = sharedDemand;
        if (daily > 0) {
            const supply = Math.max(input.stockOnHand, 0) + Math.max(input.stockOnOrder, 0);
            const residualAtPoint = Math.max(0, daily * orderPointDays(input) - supply);
            orderQty = Math.min(effectiveQty, residualAtPoint);
        }
        if (orderQty <= 0) {
            const runway = resolveRunway(input);
            return createPurchasingAssessment({
                vendorName: input.vendorName,
                productId: input.productId,
                decision: "hold",
                recommendedQty: 0,
                confidence: "high",
                reasonCodes: ["on_order_already_covers_need"],
                explanation:
                    `Hold: ${fmtQty(input.stockOnOrder)} on order already covers near-term need ` +
                    `(runway ${fmtDays(runway)}, on hand ${fmtQty(input.stockOnHand)}). Chase that PO if delayed — do not re-order.`,
                metrics: m(),
            });
        }
    }

    const orderMeta = buildOrderExplanation(input, orderQty);
    return createPurchasingAssessment({
        vendorName: input.vendorName,
        productId: input.productId,
        decision: "order",
        recommendedQty: orderQty,
        confidence: orderMeta.confidence,
        reasonCodes: orderMeta.reasonCodes,
        explanation: orderMeta.explanation,
        metrics: m(),
    });
}
