/**
 * @file    policy-types.ts
 * @purpose Shared types for purchasing assessment decisions and reason codes.
 * @author  Hermia
 * @created 2026-05-26
 * @updated 2026-07-10 — runway_healthy, residual_top_up, micro_velocity, runway_below_lead
 */
export type PurchasingDecision = "order" | "reduce" | "hold" | "manual_review";

export type PurchasingReasonCode =
    | "direct_demand_support"
    | "bom_support_for_low_fg_runway"
    | "bom_demand_suppressed"
    | "fg_coverage_sufficient"
    | "on_order_already_covers_need"
    | "pack_size_forced_overbuy"
    | "order_economics_unclear"
    | "mapping_missing"
    | "recent_draft_exists"
    | "no_order_quantity_recommended"
    | "runway_healthy"
    | "residual_top_up"
    | "micro_velocity_noise"
    | "runway_below_lead";

export interface PurchasingAssessmentMetrics {
    directDemand: number;
    bomDemand: number;
    sharedDemand: number;
    stockOnHand: number;
    stockOnOrder: number;
    adjustedRunwayDays: number | null;
    finishedGoodsCoverageDays: number | null;
    leadTimeDays: number | null;
}

export interface PurchasingAssessment {
    vendorName: string;
    productId: string;
    decision: PurchasingDecision;
    recommendedQty: number;
    confidence: "high" | "medium" | "low";
    reasonCodes: PurchasingReasonCode[];
    explanation: string;
    metrics: PurchasingAssessmentMetrics;
}

export interface VendorAutomationPolicy {
    trustedVendors: string[];
    defaultLookbackDays: number;
    autoDraftDelayHours: number;
}

const EMPTY_METRICS: PurchasingAssessmentMetrics = {
    directDemand: 0,
    bomDemand: 0,
    sharedDemand: 0,
    stockOnHand: 0,
    stockOnOrder: 0,
    adjustedRunwayDays: null,
    finishedGoodsCoverageDays: null,
    leadTimeDays: null,
};

export const DEFAULT_VENDOR_AUTOMATION_POLICY: VendorAutomationPolicy = {
    trustedVendors: ["ULINE", "Axiom", "Sustainable Village"],
    defaultLookbackDays: 14,
    autoDraftDelayHours: 24,
};

export function createPurchasingAssessment(
    input: Omit<PurchasingAssessment, "metrics"> & { metrics?: Partial<PurchasingAssessmentMetrics> },
): PurchasingAssessment {
    return {
        ...input,
        recommendedQty: Math.max(0, Math.round(input.recommendedQty)),
        metrics: {
            ...EMPTY_METRICS,
            ...input.metrics,
        },
    };
}
