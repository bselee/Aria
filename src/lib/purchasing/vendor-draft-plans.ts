import type { PurchasingGroup } from "../finale/client";
import { assessPurchasingGroups, type AssessPurchasingGroupsOptions } from "./assessment-service";
import { buildDraftPOItemsFromAssessment } from "./draft-po-policy";
import { shouldAutoCreateDraftPO } from "./vendor-automation-policy";

export interface VendorDraftPlan {
    vendorName: string;
    vendorPartyId: string;
    urgency: PurchasingGroup["urgency"];
    actionableItems: ReturnType<typeof buildDraftPOItemsFromAssessment>["items"];
    blockedLines: ReturnType<typeof buildDraftPOItemsFromAssessment>["blockedLines"];
    assessedItems: ReturnType<typeof assessPurchasingGroups>["groups"][number]["items"];
    autoDraftEligible: boolean;
}

export function buildVendorDraftPlans(
    groups: PurchasingGroup[],
    options: AssessPurchasingGroupsOptions = {},
    vendorFilter?: string | null,
): VendorDraftPlan[] {
    const normalizedFilter = vendorFilter?.trim().toLowerCase() ?? "";
    const scopedGroups = normalizedFilter
        ? groups.filter(group => group.vendorName.toLowerCase().includes(normalizedFilter))
        : groups;

    const assessment = assessPurchasingGroups(scopedGroups, options);

    return assessment.groups.map(group => {
        const draftPolicy = buildDraftPOItemsFromAssessment(group.items);
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
            blockedLines: draftPolicy.blockedLines,
            assessedItems: group.items,
            autoDraftEligible: shouldAutoCreateDraftPO({
                vendorName: group.vendorName,
                actionableCount: draftPolicy.items.length,
                blockedCount: draftPolicy.blockedLines.length,
                highestConfidence,
                cooldownActive: false,
            }),
        };
    });
}
