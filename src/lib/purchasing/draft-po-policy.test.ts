import { describe, expect, it } from "vitest";

import {
    buildDraftPOItemsFromAssessment,
    summarizeDraftPOPolicyResult,
} from "./draft-po-policy";

describe("buildDraftPOItemsFromAssessment", () => {
    it("keeps only order and reduce lines for draft creation", () => {
        const result = buildDraftPOItemsFromAssessment([
            {
                item: {
                    productId: "BOX-101",
                    unitPrice: 1.15,
                    orderIncrementQty: 25,
                    isBulkDelivery: false,
                },
                assessment: {
                    decision: "order",
                    recommendedQty: 300,
                    explanation: "Order now.",
                },
            },
            {
                item: {
                    productId: "VALVE-3MM",
                    unitPrice: 0.32,
                    orderIncrementQty: 50,
                    isBulkDelivery: false,
                },
                assessment: {
                    decision: "hold",
                    recommendedQty: 0,
                    explanation: "Hold for finished goods coverage.",
                },
            },
            {
                item: {
                    productId: "LABEL-42",
                    unitPrice: 0.12,
                    orderIncrementQty: 5000,
                    isBulkDelivery: false,
                },
                assessment: {
                    decision: "reduce",
                    recommendedQty: 500,
                    explanation: "Reduce to a practical order quantity.",
                },
            },
        ] as any);

        expect(result.items).toEqual([
            {
                productId: "BOX-101",
                quantity: 300,
                unitPrice: 1.15,
                orderIncrementQty: 25,
                isBulkDelivery: false,
            },
            {
                productId: "LABEL-42",
                quantity: 500,
                unitPrice: 0.12,
                orderIncrementQty: 5000,
                isBulkDelivery: false,
            },
        ]);
        expect(result.blockedLines).toHaveLength(1);
    });
});

describe("summarizeDraftPOPolicyResult", () => {
    it("preserves explanations so bot or dashboard responses stay understandable", () => {
        const summary = summarizeDraftPOPolicyResult({
            items: [
                {
                    productId: "BOX-101",
                    quantity: 300,
                    unitPrice: 1.15,
                    orderIncrementQty: 25,
                    isBulkDelivery: false,
                },
            ],
            blockedLines: [
                {
                    item: { productId: "VALVE-3MM" },
                    assessment: {
                        decision: "hold",
                        explanation: "Finished goods already have enough runway.",
                    },
                },
            ],
        } as any);

        expect(summary).toContain("1 actionable");
        expect(summary).toContain("VALVE-3MM");
        expect(summary).toContain("Finished goods already have enough runway.");
    });
});
