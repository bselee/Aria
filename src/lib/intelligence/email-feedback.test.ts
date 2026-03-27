import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordFeedbackMock } = vi.hoisted(() => ({
    recordFeedbackMock: vi.fn(),
}));

vi.mock("./feedback-loop", () => ({
    recordFeedback: recordFeedbackMock,
}));

import {
    recordDefaultInboxInvoiceOutcome,
    recordHumanFollowUpRequired,
    recordSimpleAutoReply,
} from "./email-feedback";

describe("email feedback helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        recordFeedbackMock.mockResolvedValue(undefined);
    });

    it("records a simple auto-reply event with thread context", async () => {
        await recordSimpleAutoReply({
            gmailMessageId: "gmail-1",
            threadId: "thread-1",
            fromEmail: "vendor@example.com",
            subject: "Tracking update",
            replyBody: "Got it, thanks!",
        });

        expect(recordFeedbackMock).toHaveBeenCalledWith({
            category: "engagement",
            eventType: "email_auto_reply_sent",
            agentSource: "acknowledgement-agent",
            subjectType: "message",
            subjectId: "gmail-1",
            prediction: {
                action: "reply",
                threadId: "thread-1",
                replyBody: "Got it, thanks!",
            },
            actualOutcome: {
                fromEmail: "vendor@example.com",
                subject: "Tracking update",
            },
            contextData: {
                inbox: "default",
            },
        });
    });

    it("records a human handoff signal for Follow Up cases", async () => {
        await recordHumanFollowUpRequired({
            gmailMessageId: "gmail-2",
            threadId: "thread-2",
            fromEmail: "vendor@example.com",
            subject: "RE: Packaging update",
            reason: "conversation_thread",
        });

        expect(recordFeedbackMock).toHaveBeenCalledWith({
            category: "correction",
            eventType: "email_follow_up_required",
            agentSource: "acknowledgement-agent",
            subjectType: "message",
            subjectId: "gmail-2",
            prediction: {
                action: "human_review",
                threadId: "thread-2",
            },
            actualOutcome: {
                fromEmail: "vendor@example.com",
                subject: "RE: Packaging update",
            },
            contextData: {
                inbox: "default",
                reason: "conversation_thread",
            },
        });
    });

    it("records default inbox invoice outcomes for later reconciliation learning", async () => {
        await recordDefaultInboxInvoiceOutcome({
            gmailMessageId: "gmail-3",
            fromEmail: "orders@uline.com",
            subject: "PO #124541 paid invoice",
            outcome: "reconciled",
            vendorName: "ULINE",
            poNumber: "124541",
            total: 120,
            priceUpdates: 1,
        });

        expect(recordFeedbackMock).toHaveBeenCalledWith({
            category: "outcome",
            eventType: "default_inbox_invoice_reconciled",
            agentSource: "default-inbox-invoice",
            subjectType: "invoice",
            subjectId: "gmail-3",
            prediction: {
                poNumber: "124541",
                vendorName: "ULINE",
            },
            actualOutcome: {
                outcome: "reconciled",
                total: 120,
                priceUpdates: 1,
            },
            contextData: {
                fromEmail: "orders@uline.com",
                subject: "PO #124541 paid invoice",
            },
        });
    });
});
