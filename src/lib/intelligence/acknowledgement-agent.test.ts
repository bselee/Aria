import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailSendMock,
    gmailModifyMock,
    gmailThreadsGetMock,
    gmailLabelsListMock,
    gmailLabelsCreateMock,
    gmailDraftsCreateMock,
    getProfileMock,
    unifiedObjectGenerationMock,
    recallMock,
    enqueueDefaultInboxInvoiceMock,
    recordSimpleAutoReplyMock,
    recordHumanReviewRequiredMock,
    recordEmailDraftPreparedMock,
    notifyViaTaskMock,
    queueState,
} = vi.hoisted(() => ({
    gmailSendMock: vi.fn(),
    gmailModifyMock: vi.fn(),
    gmailThreadsGetMock: vi.fn(),
    gmailLabelsListMock: vi.fn(),
    gmailLabelsCreateMock: vi.fn(),
    gmailDraftsCreateMock: vi.fn(),
    getProfileMock: vi.fn(),
    unifiedObjectGenerationMock: vi.fn(),
    recallMock: vi.fn(),
    enqueueDefaultInboxInvoiceMock: vi.fn(),
    recordSimpleAutoReplyMock: vi.fn(),
    recordHumanReviewRequiredMock: vi.fn(),
    recordEmailDraftPreparedMock: vi.fn(),
    notifyViaTaskMock: vi.fn(),
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
            drafts: {
                create: gmailDraftsCreateMock,
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
    recordHumanReviewRequired: recordHumanReviewRequiredMock,
    recordEmailDraftPrepared: recordEmailDraftPreparedMock,
}));

vi.mock("./notify-via-task", () => ({
    notifyViaTask: notifyViaTaskMock,
}));

vi.mock("../db", () => ({
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
        gmailDraftsCreateMock.mockResolvedValue({ data: { id: "draft-opp-1" } });
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "ROUTINE_INFO",
            reasoning: "routine update",
        });
        recallMock.mockResolvedValue([]);
        enqueueDefaultInboxInvoiceMock.mockResolvedValue(undefined);
        recordSimpleAutoReplyMock.mockResolvedValue(undefined);
        recordHumanReviewRequiredMock.mockResolvedValue(undefined);
        recordEmailDraftPreparedMock.mockResolvedValue(undefined);
        notifyViaTaskMock.mockResolvedValue("task-1");
    });

    it("prepares a routine draft and NEVER auto-sends", async () => {
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

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(gmailDraftsCreateMock).toHaveBeenCalledTimes(1);
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-1",
            requestBody: {
                addLabelIds: ["draft-ready-label"],
            },
        });
        expect(recordEmailDraftPreparedMock).toHaveBeenCalledWith(
            expect.objectContaining({
                gmailMessageId: "gmail-1",
                kind: "routine",
            }),
        );
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
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
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-11",
            requestBody: {
                removeLabelIds: ["UNREAD"],
            },
        });
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        expect(recordHumanReviewRequiredMock).not.toHaveBeenCalled();
    });

    it("does not draft or send on vendor PO threads that already have a buildasoil reply", async () => {
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
        expect(gmailDraftsCreateMock).not.toHaveBeenCalled();
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        expect(recordEmailDraftPreparedMock).not.toHaveBeenCalled();
        expect(recordHumanReviewRequiredMock).not.toHaveBeenCalled();
    });

    it("forces multi-turn conversation threads into human review with draft stub + labels", async () => {
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
        expect(gmailDraftsCreateMock).toHaveBeenCalledTimes(1);
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-2",
            requestBody: {
                addLabelIds: expect.arrayContaining(["needs-response-label", "draft-ready-label"]),
            },
        });
        expect(recordHumanReviewRequiredMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-2",
            threadId: "thread-2",
            fromEmail: "vendor@example.com",
            subject: "RE: Packaging update",
            reason: "conversation_thread",
        });
        expect(queueState.processedUpdates.some((u) => u.values.status === "needs_response")).toBe(true);
    });

    it("does NOT escalate active conversation threads where BuildASoil has already replied", async () => {
        // Regression test for Invico PO 124392 ping-pong: each new vendor "Re:"
        // got a fresh gmail_message_id, dedup missed it, and the conversation-thread
        // upgrade re-escalated every 15 min. The fix: if BuildASoil has already
        // replied in the thread, keep it as ROUTINE_INFO and silently archive.
        queueState.messages = [
            {
                id: 22,
                gmail_message_id: "gmail-22",
                thread_id: "thread-22",
                rfc_message_id: "<msg-22>",
                from_email: "jade@invicoworldwide.com",
                subject: "Re: Invico Worldwide Order Confirmation (Ref IUSA26942 | PO 124392)",
                body_snippet: "Per our last call, confirming updated ship date.",
                body_text: "Per our last call, confirming updated ship date.\n\nOn Mon, Bill wrote:\nThanks for the update!",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];
        // Thread history: BuildASoil replied AFTER the vendor, so the conversation
        // is already active. The new vendor reply should NOT trigger human review.
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
                            headers: [{ name: "From", value: "Jade <jade@invicoworldwide.com>" }],
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

        // Must NOT escalate to human.
        expect(recordHumanReviewRequiredMock).not.toHaveBeenCalled();
        // Must NOT send a duplicate "Thanks!" on top of our own existing reply.
        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        // The message stays in the inbox (left visible for review) — the
        // dedup-on-processed_by_ack in the queue table prevents ping-pong.
        expect(gmailModifyMock).not.toHaveBeenCalled();
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
        expect(queueState.processedUpdates.some((u) => u.values.status === "invoice_queued")).toBe(true);
    });

    it("never auto-thanks vendor opportunity emails — drafts + needs_response (BioChar class)", async () => {
        queueState.messages = [
            {
                id: 40,
                gmail_message_id: "gmail-biochar",
                thread_id: "thread-biochar",
                rfc_message_id: "<msg-biochar>",
                from_email: "jessica@ambiochar.com",
                subject: "response to your BioChar inquiry",
                body_snippet: "I have attached our tier 2 distributor pricing schedule",
                body_text: [
                    "Hi Bill,",
                    "Thank you so much for reaching out. I have attached our tier 2 distributor pricing schedule",
                    "including NAKED Char and NAKED Char 5M tech sheets.",
                    "Our BioChar is IBI certified, OMRI listed, and USDA Bio-preferred.",
                    "I would love to schedule a call to address any additional questions.",
                    "Jessica Kusmiz",
                ].join("\n"),
                has_pdf: true,
                pdf_filenames: [
                    "2026 tier 2 distributor pricing.pdf",
                    "NAKED Char tds.pdf",
                    "NAKED Char 5M tds.pdf",
                ],
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];

        // Even if LLM wrongly says ROUTINE_INFO, detector must win.
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "ROUTINE_INFO",
            reasoning: "acknowledgement",
        });

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(recordSimpleAutoReplyMock).not.toHaveBeenCalled();
        expect(gmailDraftsCreateMock).toHaveBeenCalledTimes(1);
        expect(recordHumanReviewRequiredMock).toHaveBeenCalledWith(
            expect.objectContaining({
                gmailMessageId: "gmail-biochar",
                reason: "vendor_opportunity",
            }),
        );
        expect(notifyViaTaskMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "email_needs_response",
                sourceId: "email-opp:gmail-biochar",
            }),
        );
        expect(queueState.processedUpdates.some((u) => u.values.status === "needs_response")).toBe(true);
    });

    it("queues default-inbox paid PDF invoices to nightshift even if LLM says ROUTINE", async () => {
        queueState.messages = [
            {
                id: 60,
                gmail_message_id: "gmail-paid-pdf",
                thread_id: "thread-paid-pdf",
                rfc_message_id: "<msg-paid-pdf>",
                from_email: "billing@randomvendor.com",
                subject: "Invoice 99122 for your order",
                body_snippet: "Please find your paid invoice attached",
                body_text: "Invoice 99122 attached. Total $240.00 already charged to card.",
                has_pdf: true,
                pdf_filenames: ["Invoice-99122.pdf"],
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "ROUTINE_INFO",
            reasoning: "order update",
        });

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(enqueueDefaultInboxInvoiceMock).toHaveBeenCalledWith(
            "gmail-paid-pdf",
            "billing@randomvendor.com",
            "Invoice 99122 for your order",
            expect.stringContaining("Invoice 99122"),
        );
        expect(queueState.processedUpdates.some((u) => u.values.status === "invoice_queued")).toBe(true);
    });

    it("marks obvious promotional mail promotional in the queue status", async () => {
        queueState.messages = [
            {
                id: 50,
                gmail_message_id: "gmail-promo",
                thread_id: "thread-promo",
                rfc_message_id: "<msg-promo>",
                from_email: "zoro@e.zoro.com",
                subject: "Time to restock. Get all of your essentials at Zoro",
                body_snippet: "Shop now and save. Unsubscribe",
                body_text: "Shop now and save. Unsubscribe",
                has_pdf: false,
                processed_by_ack: false,
                source_inbox: "default",
            },
        ];

        await new AcknowledgementAgent("default").processUnreadEmails();

        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(unifiedObjectGenerationMock).not.toHaveBeenCalled();
        expect(queueState.processedUpdates.some((u) => u.values.status === "promotional")).toBe(true);
    });
});
