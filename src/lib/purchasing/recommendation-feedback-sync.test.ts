import { describe, expect, it, vi } from "vitest";

import {
    createEmptyVendorFeedbackMemory,
    mergeVendorFeedbackMemory,
} from "./recommendation-feedback";
import { syncRecommendationFeedbackForPurchaseOrders } from "./recommendation-feedback-sync";

describe("mergeVendorFeedbackMemory", () => {
    it("creates stable sku feedback from a validated PO outcome", () => {
        const memory = mergeVendorFeedbackMemory(createEmptyVendorFeedbackMemory(), {
            vendorName: "ULINE",
            poNumber: "124554",
            lines: [{ sku: "S-3902", qty: 2 }],
            completionSignal: {
                hasMatchedInvoice: true,
                reconciliationVerdict: "auto_approve",
                freightResolved: true,
                unresolvedBlockers: [],
                lastActivityAt: "2026-03-30T12:00:00.000Z",
            },
        });

        expect(memory.poHistory["124554"]).toMatchObject({
            status: "validated",
            score: 4,
        });
        expect(memory.skuFeedback["S-3902"]).toMatchObject({
            validatedCount: 1,
            reviewNeededCount: 0,
            cumulativeScore: 4,
            lastPoNumber: "124554",
            lastOrderedQty: 2,
        });
    });

    it("replaces the same PO snapshot instead of double-counting when the outcome changes", () => {
        const initial = mergeVendorFeedbackMemory(createEmptyVendorFeedbackMemory(), {
            vendorName: "ULINE",
            poNumber: "124555",
            lines: [{ sku: "S-4551", qty: 10 }],
            completionSignal: {
                hasMatchedInvoice: false,
                reconciliationVerdict: "needs_approval",
                freightResolved: false,
                unresolvedBlockers: ["needs_approval"],
                lastActivityAt: "2026-03-30T10:00:00.000Z",
            },
        });

        const updated = mergeVendorFeedbackMemory(initial, {
            vendorName: "ULINE",
            poNumber: "124555",
            lines: [{ sku: "S-4551", qty: 10 }],
            completionSignal: {
                hasMatchedInvoice: true,
                reconciliationVerdict: "auto_approve",
                freightResolved: true,
                unresolvedBlockers: [],
                lastActivityAt: "2026-03-30T14:00:00.000Z",
            },
        });

        expect(updated.skuFeedback["S-4551"]).toMatchObject({
            validatedCount: 1,
            reviewNeededCount: 0,
            cumulativeScore: 4,
            lastStatus: "validated",
            lastFeedbackAt: "2026-03-30T14:00:00.000Z",
        });
    });
});

describe("syncRecommendationFeedbackForPurchaseOrders", () => {
    it("preserves existing automation state while storing refreshed feedback memory", async () => {
        const getState = vi.fn().mockResolvedValue({
            vendorName: "ULINE",
            lastProcessedOrderRef: "205814897",
            lastProcessedAt: "2026-03-29T08:00:00.000Z",
            cooldownUntil: "2026-03-31T08:00:00.000Z",
            constraints: { minimumOrderValue: 150 },
            overrideMemory: { "S-3902": { quantityBias: 500 } },
            feedbackMemory: createEmptyVendorFeedbackMemory(),
        });
        const upsertState = vi.fn().mockResolvedValue("uline");

        const result = await syncRecommendationFeedbackForPurchaseOrders([{
            vendorName: "ULINE",
            poNumber: "124554",
            lines: [{ sku: "S-3902", qty: 1 }],
            completionSignal: {
                hasMatchedInvoice: true,
                reconciliationVerdict: "auto_approve",
                freightResolved: true,
                unresolvedBlockers: [],
                lastActivityAt: "2026-03-30T12:00:00.000Z",
            },
        }], { getState, upsertState });

        expect(getState).toHaveBeenCalledWith("ULINE");
        expect(upsertState).toHaveBeenCalledWith(expect.objectContaining({
            vendorName: "ULINE",
            lastProcessedOrderRef: "205814897",
            cooldownUntil: "2026-03-31T08:00:00.000Z",
            constraints: { minimumOrderValue: 150 },
            overrideMemory: { "S-3902": { quantityBias: 500 } },
            feedbackMemory: expect.objectContaining({
                skuFeedback: {
                    "S-3902": expect.objectContaining({
                        validatedCount: 1,
                    }),
                },
            }),
        }));
        expect(result).toEqual({
            updatedVendors: 1,
            skippedRecords: 0,
        });
    });
});
