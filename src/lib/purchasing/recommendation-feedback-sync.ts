import {
    createEmptyVendorFeedbackMemory,
    mergeVendorFeedbackMemory,
    type RecommendationFeedbackPORecord,
    type VendorFeedbackMemory,
} from "./recommendation-feedback";
import {
    getPurchasingAutomationState,
    upsertPurchasingAutomationState,
} from "../storage/purchasing-automation-state";

export interface RecommendationFeedbackStateGateway {
    getState: typeof getPurchasingAutomationState;
    upsertState: typeof upsertPurchasingAutomationState;
}

export interface RecommendationFeedbackSyncResult {
    updatedVendors: number;
    skippedRecords: number;
}

const defaultGateway: RecommendationFeedbackStateGateway = {
    getState: getPurchasingAutomationState,
    upsertState: upsertPurchasingAutomationState,
};

function isActionableFeedbackRecord(record: RecommendationFeedbackPORecord): boolean {
    return Boolean(
        record.vendorName &&
        record.poNumber &&
        record.lines.length > 0 &&
        record.completionSignal?.lastActivityAt,
    );
}

export async function syncRecommendationFeedbackForPurchaseOrders(
    records: RecommendationFeedbackPORecord[],
    gateway: RecommendationFeedbackStateGateway = defaultGateway,
): Promise<RecommendationFeedbackSyncResult> {
    const actionableRecords = records.filter(isActionableFeedbackRecord);
    const skippedRecords = records.length - actionableRecords.length;
    const grouped = new Map<string, RecommendationFeedbackPORecord[]>();

    for (const record of actionableRecords) {
        const key = record.vendorName.trim();
        const existing = grouped.get(key);
        if (existing) {
            existing.push(record);
        } else {
            grouped.set(key, [record]);
        }
    }

    let updatedVendors = 0;

    for (const [vendorName, vendorRecords] of grouped.entries()) {
        const existingState = await gateway.getState(vendorName);
        let feedbackMemory: VendorFeedbackMemory =
            existingState?.feedbackMemory ?? createEmptyVendorFeedbackMemory();

        for (const record of vendorRecords) {
            feedbackMemory = mergeVendorFeedbackMemory(feedbackMemory, record);
        }

        const upserted = await gateway.upsertState({
            vendorName,
            lastProcessedOrderRef: existingState?.lastProcessedOrderRef ?? null,
            lastProcessedAt: existingState?.lastProcessedAt ?? null,
            lastMappingSyncAt: existingState?.lastMappingSyncAt ?? null,
            cooldownUntil: existingState?.cooldownUntil ?? null,
            constraints: existingState?.constraints ?? {},
            overrideMemory: existingState?.overrideMemory ?? {},
            feedbackMemory,
        });

        if (upserted) {
            updatedVendors += 1;
        }
    }

    return {
        updatedVendors,
        skippedRecords,
    };
}
