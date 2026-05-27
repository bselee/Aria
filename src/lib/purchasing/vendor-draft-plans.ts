import type { PurchasingGroup } from "../finale/client";
import { assessPurchasingGroups, type AssessPurchasingGroupsOptions } from "./assessment-service";
import { buildDraftPOItemsFromAssessment } from "./draft-po-policy";
import { assessPOCommitGuardsForLines, type POCommitGuardBatchResult } from "./po-commit-guard";
import { shouldAutoCreateDraftPO } from "./vendor-automation-policy";
import type { VendorOrderCycleResult } from "./vendor-order-cycle";

export interface VendorDraftPlan {
    vendorName: string;
    vendorPartyId: string;
    urgency: PurchasingGroup["urgency"];
    actionableItems: ReturnType<typeof buildDraftPOItemsFromAssessment>["items"];
    commitReadyItems: ReturnType<typeof buildDraftPOItemsFromAssessment>["items"];
    blockedLines: ReturnType<typeof buildDraftPOItemsFromAssessment>["blockedLines"];
    assessedItems: ReturnType<typeof assessPurchasingGroups>["groups"][number]["items"];
    guardedLines: POCommitGuardBatchResult["guards"];
    guardSummary: {
        commitReadyCount: number;
        manualCount: number;
        blockedCount: number;
        cooldownActive: boolean;
    };
    vendorCycle?: VendorOrderCycleResult;
    autoDraftEligible: boolean;
}

export interface VendorDraftPlanOptions extends AssessPurchasingGroupsOptions {
    vendorCooldowns?: Record<string, boolean>;
    vendorCycles?: Record<string, VendorOrderCycleResult>;
}

export function buildVendorDraftPlans(
    groups: PurchasingGroup[],
    options: VendorDraftPlanOptions = {},
    vendorFilter?: string | null,
): VendorDraftPlan[] {
    const normalizedFilter = vendorFilter?.trim().toLowerCase() ?? "";
    const scopedGroups = normalizedFilter
        ? groups.filter(group => group.vendorName.toLowerCase().includes(normalizedFilter))
        : groups;

    const assessment = assessPurchasingGroups(scopedGroups, options);

    return assessment.groups.map(group => {
        const draftPolicy = buildDraftPOItemsFromAssessment(group.items);
        const guardBatch = assessPOCommitGuardsForLines(group.items);
        const commitReadyProductIds = new Set(
            guardBatch.commitReadyLines.map(entry => entry.line.item.productId),
        );
        const commitReadyItems = draftPolicy.items.filter(item =>
            commitReadyProductIds.has(item.productId),
        );
        const vendorCycle = options.vendorCycles?.[group.vendorPartyId];
        const cooldownActive = options.vendorCooldowns?.[group.vendorPartyId] === true
            || vendorCycle?.decision === "routine_locked";
        const highestConfidence = group.items.reduce<"high" | "medium" | "low" | null>((best, item) => {
            if (!best) return item.assessment.confidence;
            const rank = { high: 3, medium: 2, low: 1 } as const;
            return rank[item.assessment.confidence] > rank[best] ? item.assessment.confidence : best;
        }, null);

        return {
            vendorName: group.vendorName,
            vendorPartyId: group.vendorPartyId,
            urgency: group.urgency,
            actionableItems: draftPolicy.items,
            commitReadyItems,
            blockedLines: draftPolicy.blockedLines,
            assessedItems: group.items,
            guardedLines: guardBatch.guards,
            guardSummary: {
                commitReadyCount: guardBatch.commitReadyLines.length,
                manualCount: guardBatch.manualLines.length,
                blockedCount: guardBatch.blockedLines.length,
                cooldownActive,
            },
            vendorCycle,
            autoDraftEligible: shouldAutoCreateDraftPO({
                vendorName: group.vendorName,
                actionableCount: commitReadyItems.length,
                blockedCount: draftPolicy.items.length - commitReadyItems.length + draftPolicy.blockedLines.length,
                highestConfidence,
                cooldownActive: cooldownActive && vendorCycle?.decision !== "exception_allowed",
            }),
        };
    });
}
