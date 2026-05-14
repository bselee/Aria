import { describe, expect, it } from "vitest";
import {
    getActivityIntentLabel,
    getActivityLink,
    getAttentionRank,
    getCorrelationExplanation,
    getDefaultProcessState,
    getNextHumanAction,
    getTeachPayload,
    type StreamRow,
} from "./activityWorkflow";

function ap(overrides: Partial<StreamRow & { row: any }>["row"]): StreamRow {
    return {
        kind: "ap",
        row: {
            id: "act-1",
            created_at: "2026-05-14T14:00:00Z",
            email_from: "Vendor Support <vendor@example.com>",
            email_subject: "Payment question",
            intent: "EYES_NEEDED",
            action_taken: "Left email visible from Vendor Support <vendor@example.com>",
            metadata: {},
            reviewed_at: null,
            reviewed_action: null,
            human_note: null,
            process_state: null,
            resolution: null,
            learning_candidate: null,
            ...overrides,
        },
    };
}

describe("activity workflow helpers", () => {
    it("normalizes legacy human interaction labels", () => {
        expect(getActivityIntentLabel("HUMAN_INTERACTION")).toBe("EYES_NEEDED");
        expect(getActivityIntentLabel("HUMAN_INTERACT")).toBe("EYES_NEEDED");
        expect(getActivityIntentLabel("EYES_NEEDED")).toBe("EYES_NEEDED");
    });

    it("ranks unresolved attention rows ahead of routine activity", () => {
        expect(getAttentionRank(ap({ intent: "PROCESSING_ERROR" }))).toBe(10);
        expect(getAttentionRank(ap({ intent: "EYES_NEEDED" }))).toBe(20);
        expect(getAttentionRank(ap({ intent: "RECONCILIATION", action_taken: "Dashboard review required - awaiting approval" }))).toBe(30);
        expect(getAttentionRank(ap({ intent: "INVOICE", action_taken: "Forwarded to Bill.com" }))).toBeNull();
        expect(getAttentionRank(ap({ intent: "EYES_NEEDED", process_state: "handled" }))).toBeNull();
    });

    it("provides default process state and next human action", () => {
        const row = ap({ intent: "EYES_NEEDED" });

        expect(getDefaultProcessState(row)).toBe("new");
        expect(getNextHumanAction(row)).toBe("next: review/reply to email from vendor@example.com");
    });

    it("links attention emails to a Gmail search", () => {
        const link = getActivityLink(ap({ email_subject: "Payment question" }));

        expect(link?.label).toBe("open email");
        expect(link?.href).toContain("mail.google.com");
        expect(link?.href).toContain("from%3Avendor%40example.com");
        expect(link?.href).toContain("Payment%20question");
    });

    it("explains invoice to PO correlation from reconciliation metadata", () => {
        const explanation = getCorrelationExplanation(ap({
            intent: "RECONCILIATION",
            metadata: {
                invoiceNumber: "25428",
                orderId: "124800",
                vendorName: "ULINE",
                confidence: "medium",
                totalDollarImpact: 12.44,
                priceChanges: [
                    { productId: "ULS-1", verdict: "auto_approve" },
                    { productId: "ULS-2", verdict: "needs_approval" },
                ],
                feeChanges: [
                    { type: "freight", verdict: "needs_approval", to: 12.44 },
                ],
            },
        }));

        expect(explanation).toEqual({
            title: "Invoice 25428 -> PO 124800",
            confidence: "medium",
            positiveSignals: [
                "vendor matched ULINE",
                "invoice linked to PO 124800",
                "1 line/fee signal auto-approved",
            ],
            negativeSignals: [
                "2 line/fee signals need review",
                "$12.44 total impact",
            ],
        });
    });

    it("builds teach payloads from human corrections", () => {
        const payload = getTeachPayload(ap({
            intent: "RECONCILIATION",
            email_from: "Vendor <vendor@example.com>",
            email_subject: "Invoice 25428",
            metadata: {
                invoiceNumber: "25428",
                orderId: "124800",
                vendorName: "ULINE",
            },
            human_note: "Attachment had corrected PO; subject line was stale.",
            resolution: "rematched_po",
        }));

        expect(payload).toMatchObject({
            event: "activity_human_correction",
            activityLogId: "act-1",
            intent: "RECONCILIATION",
            vendor: "ULINE",
            invoiceNumber: "25428",
            suggestedPo: "124800",
            humanNote: "Attachment had corrected PO; subject line was stale.",
            resolution: "rematched_po",
        });
    });
});
