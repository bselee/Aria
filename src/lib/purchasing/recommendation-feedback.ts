import type { POCompletionSignal } from "./po-completion-loader";
import type { PurchasingDecision } from "./policy-types";

export interface RecommendationFeedbackInput {
    poNumber: string;
    decision: PurchasingDecision;
    recommendedQty: number;
    completionSignal: POCompletionSignal;
}

export interface RecommendationFeedbackSummary {
    poNumber: string;
    status: "validated" | "review_needed";
    score: number;
    reasons: string[];
    lastActivityAt: string | null;
}

export function summarizeRecommendationFeedback(
    input: RecommendationFeedbackInput,
): RecommendationFeedbackSummary {
    const reasons: string[] = [];
    let score = 0;

    if (input.completionSignal.hasMatchedInvoice) {
        reasons.push("invoice_matched");
        score += 2;
    } else {
        reasons.push("unmatched_invoice");
        score -= 2;
    }

    if (input.completionSignal.freightResolved) {
        reasons.push("freight_resolved");
        score += 1;
    } else {
        reasons.push("freight_unresolved");
        score -= 1;
    }

    for (const blocker of input.completionSignal.unresolvedBlockers) {
        reasons.push(blocker);
        score -= 1;
    }

    if (input.completionSignal.reconciliationVerdict === "auto_approve" || input.completionSignal.reconciliationVerdict === "no_change") {
        reasons.push("reconciliation_closed");
        score += 1;
    }

    return {
        poNumber: input.poNumber,
        status: score > 0 && input.completionSignal.unresolvedBlockers.length === 0
            ? "validated"
            : "review_needed",
        score,
        reasons: [...new Set(reasons)],
        lastActivityAt: input.completionSignal.lastActivityAt,
    };
}
