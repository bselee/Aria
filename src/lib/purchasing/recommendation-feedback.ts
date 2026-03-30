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

export interface RecommendationFeedbackPOLine {
    sku: string;
    qty: number;
}

export interface RecommendationFeedbackPORecord {
    vendorName: string;
    poNumber: string;
    lines: RecommendationFeedbackPOLine[];
    completionSignal: POCompletionSignal | null;
}

export interface VendorFeedbackPOHistoryEntry {
    poNumber: string;
    status: RecommendationFeedbackSummary["status"];
    score: number;
    reasons: string[];
    lastActivityAt: string | null;
    lines: RecommendationFeedbackPOLine[];
}

export interface VendorFeedbackSkuSnapshot {
    validatedCount: number;
    reviewNeededCount: number;
    cumulativeScore: number;
    lastStatus: RecommendationFeedbackSummary["status"] | null;
    lastPoNumber: string | null;
    lastFeedbackAt: string | null;
    lastOrderedQty: number | null;
}

export interface VendorFeedbackMemory {
    poHistory: Record<string, VendorFeedbackPOHistoryEntry>;
    skuFeedback: Record<string, VendorFeedbackSkuSnapshot>;
}

const MAX_FEEDBACK_PO_HISTORY = 200;

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

export function createEmptyVendorFeedbackMemory(): VendorFeedbackMemory {
    return {
        poHistory: {},
        skuFeedback: {},
    };
}

function sortFeedbackHistory(entries: VendorFeedbackPOHistoryEntry[]): VendorFeedbackPOHistoryEntry[] {
    return [...entries].sort((left, right) =>
        (right.lastActivityAt || "").localeCompare(left.lastActivityAt || ""),
    );
}

function rebuildVendorSkuFeedback(poHistory: Record<string, VendorFeedbackPOHistoryEntry>): Record<string, VendorFeedbackSkuSnapshot> {
    const aggregated: Record<string, VendorFeedbackSkuSnapshot> = {};

    for (const entry of sortFeedbackHistory(Object.values(poHistory))) {
        for (const line of entry.lines) {
            const current = aggregated[line.sku] ?? {
                validatedCount: 0,
                reviewNeededCount: 0,
                cumulativeScore: 0,
                lastStatus: null,
                lastPoNumber: null,
                lastFeedbackAt: null,
                lastOrderedQty: null,
            };

            if (entry.status === "validated") {
                current.validatedCount += 1;
            } else {
                current.reviewNeededCount += 1;
            }

            current.cumulativeScore += entry.score;

            if (
                !current.lastFeedbackAt ||
                (entry.lastActivityAt || "") >= current.lastFeedbackAt
            ) {
                current.lastStatus = entry.status;
                current.lastPoNumber = entry.poNumber;
                current.lastFeedbackAt = entry.lastActivityAt;
                current.lastOrderedQty = line.qty;
            }

            aggregated[line.sku] = current;
        }
    }

    return aggregated;
}

function pruneFeedbackHistory(poHistory: Record<string, VendorFeedbackPOHistoryEntry>): Record<string, VendorFeedbackPOHistoryEntry> {
    const keptEntries = sortFeedbackHistory(Object.values(poHistory)).slice(0, MAX_FEEDBACK_PO_HISTORY);
    return Object.fromEntries(keptEntries.map(entry => [entry.poNumber, entry]));
}

export function mergeVendorFeedbackMemory(
    existing: VendorFeedbackMemory | null | undefined,
    record: RecommendationFeedbackPORecord,
): VendorFeedbackMemory {
    const base = existing ? {
        poHistory: { ...(existing.poHistory ?? {}) },
        skuFeedback: { ...(existing.skuFeedback ?? {}) },
    } : createEmptyVendorFeedbackMemory();

    if (!record.completionSignal?.lastActivityAt || record.lines.length === 0) {
        return base;
    }

    const summary = summarizeRecommendationFeedback({
        poNumber: record.poNumber,
        decision: "order",
        recommendedQty: record.lines.reduce((sum, line) => sum + Math.max(line.qty, 0), 0),
        completionSignal: record.completionSignal,
    });

    base.poHistory[record.poNumber] = {
        poNumber: record.poNumber,
        status: summary.status,
        score: summary.score,
        reasons: summary.reasons,
        lastActivityAt: summary.lastActivityAt,
        lines: record.lines.map(line => ({ sku: line.sku, qty: line.qty })),
    };

    base.poHistory = pruneFeedbackHistory(base.poHistory);
    base.skuFeedback = rebuildVendorSkuFeedback(base.poHistory);
    return base;
}
