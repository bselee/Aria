import {
    createPurchasingAssessment,
    type PurchasingAssessment,
} from "./policy-types";

const HEALTHY_FINISHED_GOODS_COVERAGE_DAYS = 30;
const PACK_OVERBUY_MANUAL_REVIEW_RATIO = 3;

export interface PurchasingCandidateInput {
    vendorName: string;
    productId: string;
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

function isOnOrderCoverageHealthy(input: PurchasingCandidateInput): boolean {
    if ((input.stockOnOrder ?? 0) <= 0) return false;
    if (input.adjustedRunwayDays === null) return false;

    const baselineCoverage = Math.max(input.leadTimeDays ?? 0, HEALTHY_FINISHED_GOODS_COVERAGE_DAYS);
    return input.adjustedRunwayDays >= baselineCoverage;
}

function isUneconomicOrder(input: PurchasingCandidateInput, effectiveQty: number): boolean {
    if (!input.minimumOrderValue || input.minimumOrderValue <= 0) return false;
    return effectiveQty * input.unitPrice < input.minimumOrderValue;
}

export function assessPurchasingCandidate(input: PurchasingCandidateInput): PurchasingAssessment {
    const effectiveQty = deriveEffectiveOrderQty(input);
    const directDemand = Math.max(input.directDemand, 0);
    const bomDemand = Math.max(input.bomDemand, 0);
    const sharedDemand = directDemand + bomDemand;
    const healthyFgCoverage = hasHealthyFinishedGoodsCoverage(input.finishedGoodsCoverageDays);

    if (isPackOverbuy(input, effectiveQty)) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "manual_review",
            recommendedQty: effectiveQty,
            confidence: "medium",
            reasonCodes: ["pack_size_forced_overbuy"],
            explanation: "Vendor pack sizing would force a material overbuy, so this needs manual review.",
            metrics: {
                directDemand,
                bomDemand,
                sharedDemand,
                stockOnHand: input.stockOnHand,
                stockOnOrder: input.stockOnOrder,
                adjustedRunwayDays: input.adjustedRunwayDays,
                finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
                leadTimeDays: input.leadTimeDays,
            },
        });
    }

    if (isOnOrderCoverageHealthy(input)) {
        return createPurchasingAssessment({
            vendorName: input.vendorName,
            productId: input.productId,
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["on_order_already_covers_need"],
            explanation: "Existing on-order inventory already covers the near-term need.",
            metrics: {
                directDemand,
                bomDemand,
                sharedDemand,
                stockOnHand: input.stockOnHand,
                stockOnOrder: input.stockOnOrder,
                adjustedRunwayDays: input.adjustedRunwayDays,
                finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
                leadTimeDays: input.leadTimeDays,
            },
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
            explanation: "Finished goods already have healthy coverage, so BOM-driven reorder pressure is suppressed.",
            metrics: {
                directDemand,
                bomDemand,
                sharedDemand,
                stockOnHand: input.stockOnHand,
                stockOnOrder: input.stockOnOrder,
                adjustedRunwayDays: input.adjustedRunwayDays,
                finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
                leadTimeDays: input.leadTimeDays,
            },
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
            explanation: "This recommendation falls below a practical vendor order value and should wait for batching or review.",
            metrics: {
                directDemand,
                bomDemand,
                sharedDemand,
                stockOnHand: input.stockOnHand,
                stockOnOrder: input.stockOnOrder,
                adjustedRunwayDays: input.adjustedRunwayDays,
                finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
                leadTimeDays: input.leadTimeDays,
            },
        });
    }

    return createPurchasingAssessment({
        vendorName: input.vendorName,
        productId: input.productId,
        decision: "order",
        recommendedQty: effectiveQty,
        confidence: "high",
        reasonCodes: ["direct_demand_support"],
        explanation: "Current demand and supply position support placing a reorder now.",
        metrics: {
            directDemand,
            bomDemand,
            sharedDemand,
            stockOnHand: input.stockOnHand,
            stockOnOrder: input.stockOnOrder,
            adjustedRunwayDays: input.adjustedRunwayDays,
            finishedGoodsCoverageDays: input.finishedGoodsCoverageDays,
            leadTimeDays: input.leadTimeDays,
        },
    });
}
