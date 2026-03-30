import type { PurchasingGroup, PurchasingItem } from "../finale/client";
import {
    assessPurchasingCandidate,
    type PurchasingCandidateInput,
} from "./policy-engine";
import {
    buildPurchasingCandidate,
    type PurchasingCandidate,
    type PurchasingCandidateContext,
} from "./policy-candidates";

export interface AssessedPurchasingLine {
    item: PurchasingItem;
    candidate: PurchasingCandidate;
    assessment: ReturnType<typeof assessPurchasingCandidate>;
}

export interface AssessedPurchasingGroup {
    vendorName: string;
    vendorPartyId: string;
    urgency: PurchasingGroup["urgency"];
    items: AssessedPurchasingLine[];
}

export interface VendorAssessmentSummary {
    vendorName: string;
    vendorPartyId: string;
    actionableCount: number;
    blockedCount: number;
    highestConfidence: "high" | "medium" | "low" | null;
}

export interface AssessPurchasingGroupsOptions {
    itemContexts?: Record<string, PurchasingCandidateContext>;
}

export interface PurchasingAssessmentResult {
    groups: AssessedPurchasingGroup[];
    actionableLines: AssessedPurchasingLine[];
    blockedLines: AssessedPurchasingLine[];
    vendorSummaries: VendorAssessmentSummary[];
}

const CONFIDENCE_RANK: Record<"high" | "medium" | "low", number> = {
    high: 3,
    medium: 2,
    low: 1,
};

function summarizeVendor(group: AssessedPurchasingGroup): VendorAssessmentSummary {
    const actionableCount = group.items.filter(item =>
        item.assessment.decision === "order" || item.assessment.decision === "reduce",
    ).length;
    const blockedCount = group.items.length - actionableCount;
    const highestConfidence = group.items.reduce<"high" | "medium" | "low" | null>((best, item) => {
        if (!best) return item.assessment.confidence;
        return CONFIDENCE_RANK[item.assessment.confidence] > CONFIDENCE_RANK[best]
            ? item.assessment.confidence
            : best;
    }, null);

    return {
        vendorName: group.vendorName,
        vendorPartyId: group.vendorPartyId,
        actionableCount,
        blockedCount,
        highestConfidence,
    };
}

export function assessPurchasingGroups(
    groups: PurchasingGroup[],
    options: AssessPurchasingGroupsOptions = {},
): PurchasingAssessmentResult {
    const assessedGroups = groups.map((group): AssessedPurchasingGroup => {
        const items = group.items.map((item) => {
            const candidate = buildPurchasingCandidate(
                item,
                options.itemContexts?.[item.productId],
            );
            const assessment = assessPurchasingCandidate(candidate as PurchasingCandidateInput);

            return {
                item,
                candidate,
                assessment,
            };
        });

        return {
            vendorName: group.vendorName,
            vendorPartyId: group.vendorPartyId,
            urgency: group.urgency,
            items,
        };
    });

    const allLines = assessedGroups.flatMap(group => group.items);
    const actionableLines = allLines.filter(line =>
        line.assessment.decision === "order" || line.assessment.decision === "reduce",
    );
    const blockedLines = allLines.filter(line =>
        line.assessment.decision === "hold" || line.assessment.decision === "manual_review",
    );

    return {
        groups: assessedGroups,
        actionableLines,
        blockedLines,
        vendorSummaries: assessedGroups.map(summarizeVendor),
    };
}
