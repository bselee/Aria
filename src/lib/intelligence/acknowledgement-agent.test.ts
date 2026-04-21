import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailSendMock,
    gmailModifyMock,
    gmailThreadsGetMock,
    gmailLabelsListMock,
    gmailLabelsCreateMock,
    getProfileMock,
    unifiedObjectGenerationMock,
    recallMock,
    enqueueDefaultInboxInvoiceMock,
    recordSimpleAutoReplyMock,
    recordHumanFollowUpRequiredMock,
    queueState,
} = vi.hoisted(() => ({
    gmailSendMock: vi.fn(),
    gmailModifyMock: vi.fn(),
    gmailThreadsGetMock: vi.fn(),
    gmailLabelsListMock: vi.fn(),
    gmailLabelsCreateMock: vi.fn(),
    getProfileMock: vi.fn(),
    unifiedObjectGenerationMock: vi.fn(),
    recallMock: vi.fn(),
    enqueueDefaultInboxInvoiceMock: vi.fn(),
    recordSimpleAutoReplyMock: vi.fn(),
    recordHumanFollowUpRequiredMock: vi.fn(),
    queueState: {
        messages: [] as Array<Record<string, any>>,
        processedUpdates: [] as Array<Record<string, any>>,
    },
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            getProfile: getProfileMock,
            messages: {
                send: gmailSendMock,
                modify: gmailModifyMock,
            },
            threads: {
                get: gmailThreadsGetMock,
            },
            labels: {
                list: gmailLabelsListMock,
                create: gmailLabelsCreateMock,
            },
        },
    })),
}));

vi.mock("./llm", () => ({
    unifiedObjectGeneration: unifiedObjectGenerationMock,
}));

vi.mock("./memory", () => ({
    recall: recallMock,
}));

vi.mock("./nightshift-agent", () => ({
    enqueueDefaultInboxInvoice: enqueueDefaultInboxInvoiceMock,
}));

vi.mock("./email-feedback", () => ({
    recordSimpleAutoReply: recordSimpleAutoReplyMock,
    recordHumanFollowUpRequired: recordHumanFollowUpRequiredMock,
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table !== "email_inbox_queue") {
                throw new Error(`Unexpected table ${table}`);
            }

            return {
                select: () => ({
                    eq: () => ({
                        eq: () => ({
                            limit: async () => ({ data: queueState.messages, error: null }),
                        }),
                    }),
                }),
                update: (values: Record<string, unknown>) => ({
                    eq: async (column: string, value: unknown) => {
                        queueState.processedUpdates.push({ values, column, value });
                        return { data: null, error: null };
                    },
                }),
            };
        },
    })),
}));

import { AcknowledgementAgent } from "./acknowledgement-agent";

describe("AcknowledgementAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queueState.messages = [];
        queueState.processedUpdates = [];

        getProfileMock.mockResolvedValue({ data: { emailAddress: "bill.selee@buildasoil.com" } });
        gmailSendMock.mockResolvedValue({ data: { id: "reply-1" } });
        gmailModifyMock.mockResolvedValue({ data: {} });
        gmailThreadsGetMock.mockResolvedValue({ data: { messages: [] } });
        gmailLabelsListMock.mockResolvedValue({ data: { labels: [] } });
        gmailLabelsCreateMock.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
            data: { id: `${requestBody.name.toLowerCase().replace(/\s+/g, "-")}-label` },
        }));
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "ROUTINE_INFO",
            reasoning: "routine update",
        });
        recallMock.mockResolvedValue([]);
        enqueueDefaultInboxInvoiceMock.mockResolvedValue(undefined);
        recordSimpleAutoReplyMock.mockResolvedValue(undefined);
        recordHumanFollowUpRequiredMock.mockResolvedValue(undefined);
    });

    it("adds the Replied label and keeps a routine reply visible in inbox", async () => {
        queueState.messages = [
            {
                id: 1,
                gmail_message_id: "gmail-1",
                thread_id: "thread-1",
                rfc_message_id: "<msg-1>",
                from_email: "vendor@example.com",
                subject: "Tracking update",
                body_snippet: "Your order shipped",
                body_text: "Your order shipped",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).toHaveBeenCalledTimes(1);
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-1",
            requestBody: {
                addLabelIds: ["replied-label"],
            },
        });
        expect(recordSimpleAutoReplyMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-1",
            threadId: "thread-1",
            fromEmail: "vendor@example.com",
            subject: "Tracking update",
            replyBody: expect.any(String),
        });
    });

    it("does not auto-reply to marketplace shipping notices", async () => {
        queueState.messages = [
            {
                id: 11,
                gmail_message_id: "gmail-11",
                thread_id: "thread-11",
                rfc_message_id: "<msg-11>",
                from_email: "credit@notice.alibaba.com",
                subject: "Your order is on its way (296225130501024781)",
                body_snippet: "The supplier has shipped your products",
                body_text: "The supplier has shipped your products. Track package.",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        expect(recordHumanFollowUpRequiredMock).not.toHaveBeenCalled();
    });

    it("does not send a second thank-you on vendor PO threads that already have a buildasoil reply", async () => {
        queueState.messages = [
            {
                id: 12,
                gmail_message_id: "gmail-12",
                thread_id: "thread-12",
                rfc_message_id: "<msg-12>",
                from_email: "barends@jabbspe.com",
                subject: "Re: BuildASoil PO # 124564 - JABB of the Carolinas, Inc. - 3/30/2026",
                body_snippet: "This will ship today. ETA is next Monday, April 6.",
                body_text: "Thanks Bill! This will ship today. ETA is next Monday, April 6.",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];
        gmailThreadsGetMock.mockResolvedValue({
            data: {
                messages: [
                    {
                        payload: {
                            headers: [{ name: "From", value: "Bill Selee <bill.selee@buildasoil.com>" }],
                        },
                    },
                    {
                        payload: {
                            headers: [{ name: "From", value: "Ben Arends <barends@jabbspe.com>" }],
                        },
                    },
                    {
                        payload: {
                            headers: [{ name: "From", value: "Bill Selee <bill.selee@buildasoil.com>" }],
                        },
                    },
                ],
            },
        });

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        expect(recordHumanFollowUpRequiredMock).not.toHaveBeenCalled();
    });

    it("forces multi-turn conversation threads into human review without adding a follow-up label", async () => {
        queueState.messages = [
            {
                id: 2,
                gmail_message_id: "gmail-2",
                thread_id: "thread-2",
                rfc_message_id: "<msg-2>",
                from_email: "vendor@example.com",
                subject: "RE: Packaging update",
                body_snippet: "Please see below",
                body_text: "Thanks.\n\nOn Tue, Vendor wrote:\nCan you confirm the revised carton count?",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(recordHumanFollowUpRequiredMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-2",
            threadId: "thread-2",
            fromEmail: "vendor@example.com",
            subject: "RE: Packaging update",
            reason: "conversation_thread",
        });
    });

    it("queues inline invoices without archiving them out of view", async () => {
        queueState.messages = [
            {
                id: 3,
                gmail_message_id: "gmail-3",
                thread_id: "thread-3",
                rfc_message_id: "<msg-3>",
                from_email: "orders@uline.com",
                subject: "PO 124541 paid invoice",
                body_snippet: "Subtotal $100 Freight $20 Total $120",
                body_text: "PO #124541\nSubtotal $100.00\nFreight $20.00\nTotal $120.00",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "INLINE_INVOICE",
            reasoning: "paid invoice details in body",
        });

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(enqueueDefaultInboxInvoiceMock).toHaveBeenCalledWith(
            "gmail-3",
            "orders@uline.com",
            "PO 124541 paid invoice",
            "PO #124541\nSubtotal $100.00\nFreight $20.00\nTotal $120.00",
        );
        expect(gmailModifyMock).not.toHaveBeenCalled();
    });
});
