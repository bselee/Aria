import type { AssessedPurchasingLine } from "./assessment-service";

export type POCommitGuardDecision = "commit" | "draft_only" | "block";

export interface POCommitGuardOptions {
    minimumPostLeadCoverageDays?: number;
    requireHighConfidence?: boolean;
}

export interface POCommitGuardResult {
    productId: string;
    decision: POCommitGuardDecision;
    targetCoverDays: number;
    minimumPostLeadCoverageDays: number;
    recommendedQty: number;
    dailyRate: number;
    leadTimeDays: number;
    projectedCoverageDays: number;
    projectedPostReceiptCoverageDays: number;
    blockReasons: string[];
    summary: string;
}

export interface POCommitGuardBatchResult {
    guards: Array<{ line: AssessedPurchasingLine; guard: POCommitGuardResult }>;
    commitReadyLines: Array<{ line: AssessedPurchasingLine; guard: POCommitGuardResult }>;
    manualLines: Array<{ line: AssessedPurchasingLine; guard: POCommitGuardResult }>;
    blockedLines: Array<{ line: AssessedPurchasingLine; guard: POCommitGuardResult }>;
    hasBlocks: boolean;
}

function finitePositive(value: number | null | undefined, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function summarizeGuard(result: Omit<POCommitGuardResult, "summary">): string {
    if (result.decision === "commit") {
        return `Commit-ready: ${Math.round(result.recommendedQty)} units covers ${Math.round(result.leadTimeDays)}d lead + ${result.minimumPostLeadCoverageDays}d supply.`;
    }
    if (result.decision === "block") {
        return `Blocked: ${result.blockReasons.join(", ")}`;
    }
    return `Draft only: ${result.blockReasons.join(", ")}`;
}

export function assessPOCommitGuard(
    line: AssessedPurchasingLine,
    options: POCommitGuardOptions = {},
): POCommitGuardResult {
    const minimumPostLeadCoverageDays = options.minimumPostLeadCoverageDays ?? 30;
    const requireHighConfidence = options.requireHighConfidence ?? true;
    const dailyRate = finitePositive(line.item.dailyRate || line.candidate.directDemand + line.candidate.bomDemand);
    const leadTimeDays = finitePositive(line.item.leadTimeDays, finitePositive(line.candidate.leadTimeDays, 14));
    const recommendedQty = Math.max(0, line.assessment.recommendedQty ?? 0);
    const stockOnHand = Math.max(0, line.item.stockOnHand ?? line.candidate.stockOnHand ?? 0);
    const stockOnOrder = Math.max(0, line.item.stockOnOrder ?? line.candidate.stockOnOrder ?? 0);
    const targetCoverDays = leadTimeDays + minimumPostLeadCoverageDays;

    const projectedCoverageDays = dailyRate > 0
        ? (stockOnHand + stockOnOrder + recommendedQty) / dailyRate
        : Number.POSITIVE_INFINITY;
    const projectedPostReceiptCoverageDays = dailyRate > 0
        ? Math.max(0, (stockOnHand + stockOnOrder + recommendedQty - (dailyRate * leadTimeDays)) / dailyRate)
        : Number.POSITIVE_INFINITY;

    const blockReasons: string[] = [];

    if (line.assessment.decision !== "order" && line.assessment.decision !== "reduce") {
        blockReasons.push("assessment_not_order");
    }
    if (recommendedQty <= 0) {
        blockReasons.push("no_recommended_qty");
    }
    if (dailyRate <= 0) {
        blockReasons.push("daily_rate_missing");
    }
    if (requireHighConfidence && line.assessment.confidence !== "high") {
        blockReasons.push("confidence_below_high");
    }
    if (line.item.reviewRequired) {
        blockReasons.push("recommendation_requires_review");
    }
    if (line.item.moqWarning) {
        blockReasons.push("moq_warn_only");
    }
    if (projectedPostReceiptCoverageDays + 0.0001 < minimumPostLeadCoverageDays) {
        blockReasons.push("recommended_qty_below_lead_plus_30");
    }
    const min30DaySupply = dailyRate > 0 ? Math.ceil(dailyRate * 30) : 0;
    if (recommendedQty > 0 && dailyRate > 0 && recommendedQty < min30DaySupply) {
        blockReasons.push("recommended_qty_below_30_day_supply");
    }

    const hardBlockReasons = new Set(["assessment_not_order", "no_recommended_qty", "daily_rate_missing"]);
    const decision: POCommitGuardDecision = blockReasons.some(reason => hardBlockReasons.has(reason))
        ? "block"
        : blockReasons.length > 0
            ? "draft_only"
            : "commit";

    const withoutSummary = {
        productId: line.item.productId,
        decision,
        targetCoverDays,
        minimumPostLeadCoverageDays,
        recommendedQty,
        dailyRate,
        leadTimeDays,
        projectedCoverageDays: Number.isFinite(projectedCoverageDays) ? Math.round(projectedCoverageDays) : projectedCoverageDays,
        projectedPostReceiptCoverageDays: Number.isFinite(projectedPostReceiptCoverageDays)
            ? Math.round(projectedPostReceiptCoverageDays)
            : projectedPostReceiptCoverageDays,
        blockReasons,
    };

    return {
        ...withoutSummary,
        summary: summarizeGuard(withoutSummary),
    };
}

export function assessPOCommitGuardsForLines(
    lines: AssessedPurchasingLine[],
    options: POCommitGuardOptions = {},
): POCommitGuardBatchResult {
    const guards = lines.map(line => ({
        line,
        guard: assessPOCommitGuard(line, options),
    }));

    const commitReadyLines = guards.filter(entry => entry.guard.decision === "commit");
    const manualLines = guards.filter(entry => entry.guard.decision === "draft_only");
    const blockedLines = guards.filter(entry => entry.guard.decision === "block");

    return {
        guards,
        commitReadyLines,
        manualLines,
        blockedLines,
        hasBlocks: blockedLines.length > 0,
    };
}
