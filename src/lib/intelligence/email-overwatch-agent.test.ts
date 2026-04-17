import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailModifyMock,
    gmailGetMessageMock,
    gmailGetThreadMock,
    gmailDraftCreateMock,
    gmailLabelsListMock,
    gmailLabelsCreateMock,
    unifiedObjectGenerationMock,
    enqueueDefaultInboxInvoiceMock,
    upsertShipmentEvidenceMock,
    queueState,
    threadState,
    poSendState,
    nightshiftState,
} = vi.hoisted(() => ({
    gmailModifyMock: vi.fn(),
    gmailGetMessageMock: vi.fn(),
    gmailGetThreadMock: vi.fn(),
    gmailDraftCreateMock: vi.fn(),
    gmailLabelsListMock: vi.fn(),
    gmailLabelsCreateMock: vi.fn(),
    unifiedObjectGenerationMock: vi.fn(),
    enqueueDefaultInboxInvoiceMock: vi.fn(),
    upsertShipmentEvidenceMock: vi.fn(),
    queueState: {
        messages: [] as Array<Record<string, any>>,
        updates: [] as Array<Record<string, any>>,
    },
    threadState: {
        rows: [] as Array<Record<string, any>>,
        upserts: [] as Array<Record<string, any>>,
        updates: [] as Array<Record<string, any>>,
    },
    poSendState: {
        rows: [] as Array<Record<string, any>>,
    },
    nightshiftState: {
        rows: [] as Array<Record<string, any>>,
    },
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                modify: gmailModifyMock,
                get: gmailGetMessageMock,
            },
            threads: {
                get: gmailGetThreadMock,
            },
            drafts: {
                create: gmailDraftCreateMock,
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

vi.mock("./nightshift-agent", () => ({
    enqueueDefaultInboxInvoice: enqueueDefaultInboxInvoiceMock,
}));

vi.mock("../tracking/shipment-intelligence", () => ({
    upsertShipmentEvidence: upsertShipmentEvidenceMock,
}));

vi.mock("./email-feedback", () => ({
    recordOverwatchArchive: vi.fn().mockResolvedValue(undefined),
    recordOverwatchDraftCreated: vi.fn().mockResolvedValue(undefined),
    recordOverwatchHeld: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "email_inbox_queue") {
                return {
                    select: () => ({
                        eq: (_column: string, processed: unknown) => ({
                            eq: (_column2: string, _source: unknown) => ({
                                limit: async () => ({
                                    data: queueState.messages.filter((row) => row.processed_by_overwatch === processed),
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                    update: (values: Record<string, unknown>) => ({
                        eq: async (column: string, value: unknown) => {
                            queueState.updates.push({ values, column, value });
                            const row = queueState.messages.find((item) => item[column as keyof typeof item] === value);
                            if (row) Object.assign(row, values);
                            return { data: null, error: null };
                        },
                    }),
                };
            }

            if (table === "email_overwatch_threads") {
                return {
                    select: () => ({
                        eq: (_column: string, _value: unknown) => ({
                            maybeSingle: async () => ({
                                data: threadState.rows[0] || null,
                                error: null,
                            }),
                            limit: async () => ({
                                data: threadState.rows,
                                error: null,
                            }),
                            lte: (_column2: string, _value2: unknown) => ({
                                limit: async () => ({
                                    data: threadState.rows,
                                    error: null,
                                }),
                            }),
                        }),
                        in: (_column: string, _values: unknown[]) => ({
                            limit: async () => ({
                                data: threadState.rows,
                                error: null,
                            }),
                        }),
                    }),
                    upsert: async (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
                        const rows = Array.isArray(values) ? values : [values];
                        threadState.upserts.push(...rows);
                        for (const row of rows) {
                            const existing = threadState.rows.find((item) => item.thread_id === row.thread_id);
                            if (existing) Object.assign(existing, row);
                            else threadState.rows.push({ ...row });
                        }
                        return { data: null, error: null };
                    },
                    update: (values: Record<string, unknown>) => ({
                        eq: async (column: string, value: unknown) => {
                            threadState.updates.push({ values, column, value });
                            const row = threadState.rows.find((item) => item[column as keyof typeof item] === value);
                            if (row) Object.assign(row, values);
                            return { data: null, error: null };
                        },
                    }),
                };
            }

            if (table === "po_sends") {
                return {
                    select: () => ({
                        is: (_column: string, _value: unknown) => ({
                            gte: (_column2: string, _value2: unknown) => ({
                                limit: async () => ({
                                    data: poSendState.rows,
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                };
            }

            if (table === "nightshift_queue") {
                return {
                    select: () => ({
                        eq: (_column: string, gmailMessageId: unknown) => ({
                            eq: (_column2: string, taskType: unknown) => ({
                                maybeSingle: async () => ({
                                    data: nightshiftState.rows.find(
                                        (row) => row.gmail_message_id === gmailMessageId && row.task_type === taskType,
                                    ) || null,
                                    error: null,
                                }),
                            }),
                        }),
                    }),
                };
            }

            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

import { EmailOverwatchAgent } from "./email-overwatch-agent";

function makeThreadMessage(from: string, snippet: string, internalDate: string) {
    return {
        id: `${from}-${internalDate}`,
        snippet,
        internalDate,
        payload: {
            headers: [
                { name: "From", value: from },
                { name: "Subject", value: "Re: BuildASoil PO # 124629 - Grassroots Fabric Pots - 4/10/2026" },
            ],
            body: {
                data: Buffer.from(snippet, "utf8").toString("base64"),
            },
        },
    };
}

describe("EmailOverwatchAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queueState.messages = [];
        queueState.updates = [];
        threadState.rows = [];
        threadState.upserts = [];
        threadState.updates = [];
        poSendState.rows = [];
        nightshiftState.rows = [];

        gmailModifyMock.mockResolvedValue({ data: {} });
        gmailGetMessageMock.mockResolvedValue({
            data: {
                id: "gmail-po-1",
                threadId: "thread-po-1",
            },
        });
        gmailGetThreadMock.mockResolvedValue({
            data: {
                messages: [],
            },
        });
        gmailDraftCreateMock.mockResolvedValue({ data: { id: "draft-1" } });
        gmailLabelsListMock.mockResolvedValue({ data: { labels: [] } });
        gmailLabelsCreateMock.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
            data: { id: `${requestBody.name.toLowerCase().replace(/\s+/g, "-")}-label` },
        }));
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "REQUIRES_HUMAN",
            reasoning: "default uncertain",
        });
        enqueueDefaultInboxInvoiceMock.mockResolvedValue(undefined);
        upsertShipmentEvidenceMock.mockResolvedValue(null);
    });

    it("archives promotional mail confidently", async () => {
        queueState.messages = [
            {
                id: 1,
                gmail_message_id: "gmail-promo-1",
                thread_id: "thread-promo-1",
                from_email: "promo@example.com",
                subject: "Spring sale now live",
                body_snippet: "Save 20% this week only",
                body_text: "Save 20% this week only",
                has_pdf: false,
                processed_by_overwatch: false,
                source_inbox: "default",
            },
        ];
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "PROMOTIONAL",
            reasoning: "marketing email",
        });

        await new EmailOverwatchAgent("default").processInboxQueue();

        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-promo-1",
            requestBody: {
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
        expect(threadState.rows[0]).toMatchObject({
            thread_id: "thread-promo-1",
            state: "closed_confident",
            intent: "PROMOTIONAL",
            uncertain_reason: null,
        });
    });

    it("routes paid invoices and closes them only after verified reconcile success", async () => {
        queueState.messages = [
            {
                id: 2,
                gmail_message_id: "gmail-invoice-1",
                thread_id: "thread-invoice-1",
                from_email: "orders@uline.com",
                subject: "PO #124541 paid invoice",
                body_snippet: "PO #124541 Total $120 Freight $20",
                body_text: "PO #124541 Total $120 Freight $20",
                has_pdf: false,
                processed_by_overwatch: false,
                source_inbox: "default",
            },
        ];
        unifiedObjectGenerationMock.mockResolvedValue({
            intent: "INLINE_INVOICE",
            reasoning: "paid invoice details in body",
        });

        const agent = new EmailOverwatchAgent("default");
        await agent.processInboxQueue();

        expect(enqueueDefaultInboxInvoiceMock).toHaveBeenCalledWith(
            "gmail-invoice-1",
            "orders@uline.com",
            "PO #124541 paid invoice",
            "PO #124541 Total $120 Freight $20",
        );
        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(threadState.rows[0]).toMatchObject({
            thread_id: "thread-invoice-1",
            state: "paid_invoice_routed_waiting_for_reconcile",
            downstream_status: "queued_for_nightshift",
        });

        threadState.rows = [{
            ...threadState.rows[0],
            gmail_message_id: "gmail-invoice-1",
        }];
        nightshiftState.rows = [{
            gmail_message_id: "gmail-invoice-1",
            task_type: "default_inbox_invoice",
            status: "completed",
            result: { outcome: "reconciled", summary: "done" },
        }];

        await agent.runReminderSweep();

        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-invoice-1",
            requestBody: {
                addLabelIds: ["invoices-label"],
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
        expect(threadState.rows[0]).toMatchObject({
            state: "closed_confident",
            downstream_status: "reconciled",
        });
    });

    it("keeps invoice threads unread when downstream reconciliation fails", async () => {
        threadState.rows = [{
            thread_id: "thread-invoice-2",
            gmail_message_id: "gmail-invoice-2",
            state: "paid_invoice_routed_waiting_for_reconcile",
            downstream_status: "queued_for_nightshift",
        }];
        nightshiftState.rows = [{
            gmail_message_id: "gmail-invoice-2",
            task_type: "default_inbox_invoice",
            status: "failed",
            result: { outcome: "no_po_number", summary: "missing po" },
            error: "missing po",
        }];

        await new EmailOverwatchAgent("default").runReminderSweep();

        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(threadState.rows[0]).toMatchObject({
            state: "human_review_required",
            uncertain_reason: "downstream_reconcile_failed",
            downstream_status: "no_po_number",
        });
    });

    it("creates a first follow-up draft after two days with no vendor reply", async () => {
        const sentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        poSendState.rows = [{
            po_number: "124629",
            vendor_name: "Grassroots Fabric Pots",
            sent_to_email: "orders@grassroots.com",
            sent_at: sentAt,
            gmail_message_id: "gmail-po-1",
        }];
        gmailGetThreadMock.mockResolvedValue({
            data: {
                messages: [
                    makeThreadMessage("Bill Selee <bill.selee@buildasoil.com>", "Please confirm receipt and ETA.", String(Date.now() - 3 * 24 * 60 * 60 * 1000)),
                ],
            },
        });

        await new EmailOverwatchAgent("default").runReminderSweep();

        expect(gmailDraftCreateMock).toHaveBeenCalledTimes(1);
        expect(threadState.rows[0]).toMatchObject({
            po_number: "124629",
            state: "po_sent_waiting_for_reply",
            follow_up_count: 1,
            last_draft_id: "draft-1",
        });
    });

    it("accepts soft ETA language and delays follow-up instead of drafting immediately", async () => {
        const sentAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        poSendState.rows = [{
            po_number: "124630",
            vendor_name: "Grassroots Fabric Pots",
            sent_to_email: "orders@grassroots.com",
            sent_at: sentAt,
            gmail_message_id: "gmail-po-2",
        }];
        gmailGetMessageMock.mockResolvedValue({
            data: {
                id: "gmail-po-2",
                threadId: "thread-po-2",
            },
        });
        gmailGetThreadMock.mockResolvedValue({
            data: {
                messages: [
                    makeThreadMessage("Bill Selee <bill.selee@buildasoil.com>", "Please confirm receipt and ETA.", String(Date.now() - 2 * 24 * 60 * 60 * 1000)),
                    makeThreadMessage("Vendor <orders@grassroots.com>", "Got it. This should ship next week.", String(Date.now() - 60 * 60 * 1000)),
                ],
            },
        });

        await new EmailOverwatchAgent("default").runReminderSweep();

        expect(gmailDraftCreateMock).not.toHaveBeenCalled();
        expect(threadState.rows[0]).toMatchObject({
            po_number: "124630",
            state: "eta_received_waiting_for_ship_or_tracking",
            eta_text: "next week",
        });
        expect(threadState.rows[0].next_follow_up_at).toBeTruthy();
    });
});
