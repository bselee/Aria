import { describe, expect, it } from "vitest";

import { summarizeRecommendationFeedback } from "./recommendation-feedback";

describe("summarizeRecommendationFeedback", () => {
    it("marks a recommendation validated when receipt, AP match, and freight resolution all align", () => {
        const feedback = summarizeRecommendationFeedback({
            poNumber: "124554",
            decision: "order",
            recommendedQty: 300,
            completionSignal: {
                hasMatchedInvoice: true,
                reconciliationVerdict: "auto_approve",
                freightResolved: true,
                unresolvedBlockers: [],
                lastActivityAt: "2026-03-30T12:00:00.000Z",
            },
        });

        expect(feedback.status).toBe("validated");
        expect(feedback.score).toBeGreaterThan(0);
        expect(feedback.reasons).toContain("invoice_matched");
    });

    it("marks a recommendation as needing review when AP or receiving still has blockers", () => {
        const feedback = summarizeRecommendationFeedback({
            poNumber: "124555",
            decision: "order",
            recommendedQty: 180,
            completionSignal: {
                hasMatchedInvoice: false,
                reconciliationVerdict: "needs_approval",
                freightResolved: false,
                unresolvedBlockers: ["needs_approval", "freight_review"],
                lastActivityAt: "2026-03-30T12:30:00.000Z",
            },
        });

        expect(feedback.status).toBe("review_needed");
        expect(feedback.score).toBeLessThan(0);
        expect(feedback.reasons).toEqual(
            expect.arrayContaining(["unmatched_invoice", "freight_unresolved", "needs_approval"]),
        );
    });
});
