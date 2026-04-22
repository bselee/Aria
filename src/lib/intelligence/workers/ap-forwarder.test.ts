import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailFactoryMock,
    getAuthenticatedClientMock,
    createClientMock,
    applyMessageLabelPolicyMock,
    processInvoiceBufferMock,
} = vi.hoisted(() => ({
    gmailFactoryMock: vi.fn(),
    getAuthenticatedClientMock: vi.fn(),
    createClientMock: vi.fn(),
    applyMessageLabelPolicyMock: vi.fn(),
    processInvoiceBufferMock: vi.fn(),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: gmailFactoryMock,
}));

vi.mock("../../gmail/auth", () => ({
    getAuthenticatedClient: getAuthenticatedClientMock,
}));

vi.mock("../../supabase", () => ({
    createClient: createClientMock,
}));

vi.mock("../gmail-policy", () => ({
    applyMessageLabelPolicy: applyMessageLabelPolicyMock,
}));

vi.mock("../ap-agent", () => ({
    APAgent: class {
        processInvoiceBuffer = processInvoiceBufferMock;
    },
}));

import { APForwarderAgent } from "./ap-forwarder";

describe("APForwarderAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthenticatedClientMock.mockResolvedValue({});
        processInvoiceBufferMock.mockResolvedValue({
            success: true,
            state: "reconciled",
            matchedPO: true,
            invoiceNumber: "INV-1001",
            poNumber: "PO-12345",
        });
    });

    it("applies Invoice Forward and archives the source email only after the last related forward succeeds", async () => {
        const sendMock = vi.fn().mockResolvedValue({ data: { id: "sent-msg-1" } });
        const getMock = vi.fn().mockResolvedValue({ data: { labelIds: ["SENT"] } });
        gmailFactoryMock.mockReturnValue({
            users: {
                messages: {
                    send: sendMock,
                    get: getMock,
                },
            },
        });

        const queueItems = [
            {
                id: "queue-1",
                message_id: "gmail-source-1_0",
                email_from: "billing@fedex.com",
                email_subject: "FedEx Invoice",
                pdf_filename: "fedex-bill-1001.pdf",
                pdf_path: "gmail-source-1/fedex-bill-1001.pdf",
                status: "PENDING_FORWARD",
                source_inbox: "ap",
                extracted_json: {
                    source_gmail_message_id: "gmail-source-1",
                    completion_mode: "forward_success",
                },
            },
        ];

        const lockStatusEqMock = vi.fn().mockResolvedValue({ error: null });
        const lockIdEqMock = vi.fn(() => ({
            eq: lockStatusEqMock,
        }));
        const emailQueueUpdateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ error: null }),
        }));
        const updateEqMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn((payload: { status: string }) => {
            if (payload.status === "PROCESSING_FORWARD") {
                return {
                    eq: lockIdEqMock,
                };
            }
            return {
                eq: updateEqMock,
            };
        });
        const likeMock = vi.fn().mockResolvedValue({
            data: [
                {
                    message_id: "gmail-source-1_0",
                    status: "FORWARDED",
                    extracted_json: {
                        billcom_sent_message_id: "sent-msg-1",
                        processing_success: true,
                    },
                },
            ],
            error: null,
        });
        const selectMock = vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: queueItems, error: null }),
            like: likeMock,
        }));

        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "ap_inbox_queue") {
                    return {
                        select: selectMock,
                        update: updateMock,
                    };
                }
                if (table === "email_inbox_queue") {
                    return {
                        update: emailQueueUpdateMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    download: vi.fn().mockResolvedValue({
                        data: {
                            arrayBuffer: async () => Buffer.from("pdf-data"),
                        },
                        error: null,
                    }),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APForwarderAgent();
        await agent.processPendingForwards();

        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(processInvoiceBufferMock).toHaveBeenCalledWith(
            Buffer.from("pdf-data"),
            "fedex-bill-1001.pdf",
            "FedEx Invoice",
            "billing@fedex.com",
            supabase,
            false,
            "gmail-source-1",
            "gmail-source-1/fedex-bill-1001.pdf",
        );
        expect(getMock).toHaveBeenCalledWith({
            userId: "me",
            id: "sent-msg-1",
            format: "metadata",
        });
        expect(applyMessageLabelPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            gmailMessageId: "gmail-source-1",
            addLabels: ["Invoice Forward"],
            removeLabels: ["INBOX", "UNREAD"],
        }));
    });

    it("does not archive the source email when another related invoice is still pending", async () => {
        const sendMock = vi.fn().mockResolvedValue({ data: { id: "sent-msg-1" } });
        const getMock = vi.fn().mockResolvedValue({ data: { labelIds: ["SENT"] } });
        gmailFactoryMock.mockReturnValue({
            users: {
                messages: {
                    send: sendMock,
                    get: getMock,
                },
            },
        });

        const queueItems = [
            {
                id: "queue-1",
                message_id: "gmail-source-1_0",
                email_from: "billing@fedex.com",
                email_subject: "FedEx Invoice",
                pdf_filename: "fedex-bill-1001.pdf",
                pdf_path: "gmail-source-1/fedex-bill-1001.pdf",
                status: "PENDING_FORWARD",
                source_inbox: "ap",
                extracted_json: {
                    source_gmail_message_id: "gmail-source-1",
                    completion_mode: "forward_success",
                },
            },
        ];

        const lockStatusEqMock = vi.fn().mockResolvedValue({ error: null });
        const lockIdEqMock = vi.fn(() => ({
            eq: lockStatusEqMock,
        }));
        const emailQueueUpdateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ error: null }),
        }));
        const updateEqMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn((payload: { status: string }) => {
            if (payload.status === "PROCESSING_FORWARD") {
                return {
                    eq: lockIdEqMock,
                };
            }
            return {
                eq: updateEqMock,
            };
        });
        const likeMock = vi.fn().mockResolvedValue({
            data: [
                {
                    message_id: "gmail-source-1_0",
                    status: "FORWARDED",
                    extracted_json: {
                        billcom_sent_message_id: "sent-msg-1",
                        processing_success: true,
                    },
                },
                { message_id: "gmail-source-1_1", status: "PENDING_FORWARD" },
            ],
            error: null,
        });
        const selectMock = vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: queueItems, error: null }),
            like: likeMock,
        }));

        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "ap_inbox_queue") {
                    return {
                        select: selectMock,
                        update: updateMock,
                    };
                }
                if (table === "email_inbox_queue") {
                    return {
                        update: emailQueueUpdateMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    download: vi.fn().mockResolvedValue({
                        data: {
                            arrayBuffer: async () => Buffer.from("pdf-data"),
                        },
                        error: null,
                    }),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APForwarderAgent();
        await agent.processPendingForwards();

        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(applyMessageLabelPolicyMock).not.toHaveBeenCalled();
    });

    it("archives the source email and marks it processed when invoice processing fails after Bill.com send", async () => {
        processInvoiceBufferMock.mockResolvedValue({
            success: false,
            state: "processing_error",
            matchedPO: false,
            error: "Finale reconciliation did not complete",
        });

        const sendMock = vi.fn().mockResolvedValue({ data: { id: "sent-msg-1" } });
        const getMock = vi.fn().mockResolvedValue({ data: { labelIds: ["SENT"] } });
        gmailFactoryMock.mockReturnValue({
            users: {
                messages: {
                    send: sendMock,
                    get: getMock,
                },
            },
        });

        const queueItems = [
            {
                id: "queue-1",
                message_id: "gmail-source-1_0",
                email_from: "billing@fedex.com",
                email_subject: "FedEx Invoice",
                pdf_filename: "fedex-bill-1001.pdf",
                pdf_path: "gmail-source-1/fedex-bill-1001.pdf",
                status: "PENDING_FORWARD",
                source_inbox: "ap",
                extracted_json: {
                    source_gmail_message_id: "gmail-source-1",
                    completion_mode: "forward_success",
                },
            },
        ];

        const updateCalls: Array<{ status: string; extracted_json?: Record<string, unknown> }> = [];
        const emailQueueUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
        const emailQueueUpdateMock = vi.fn(() => ({
            eq: emailQueueUpdateEqMock,
        }));
        const lockStatusEqMock = vi.fn().mockResolvedValue({ error: null });
        const lockIdEqMock = vi.fn(() => ({
            eq: lockStatusEqMock,
        }));
        const updateEqMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn((payload: { status: string; extracted_json?: Record<string, unknown> }) => {
            updateCalls.push(payload);
            if (payload.status === "PROCESSING_FORWARD") {
                return {
                    eq: lockIdEqMock,
                };
            }
            return {
                eq: updateEqMock,
            };
        });
        const likeMock = vi.fn().mockResolvedValue({
            data: [
                {
                    message_id: "gmail-source-1_0",
                    status: "ERROR_PROCESSING",
                    extracted_json: {
                        billcom_sent_message_id: "sent-msg-1",
                        processing_success: false,
                    },
                },
            ],
            error: null,
        });
        const selectMock = vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: queueItems, error: null }),
            like: likeMock,
        }));

        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "ap_inbox_queue") {
                    return {
                        select: selectMock,
                        update: updateMock,
                    };
                }
                if (table === "email_inbox_queue") {
                    return {
                        update: emailQueueUpdateMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    download: vi.fn().mockResolvedValue({
                        data: {
                            arrayBuffer: async () => Buffer.from("pdf-data"),
                        },
                        error: null,
                    }),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APForwarderAgent();
        await agent.processPendingForwards();

        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(processInvoiceBufferMock).toHaveBeenCalledTimes(1);
        expect(emailQueueUpdateMock).toHaveBeenCalledWith({ processed_by_ap: true });
        expect(applyMessageLabelPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            gmailMessageId: "gmail-source-1",
            addLabels: ["Invoice Forward"],
            removeLabels: ["INBOX", "UNREAD"],
        }));
        expect(updateCalls).toContainEqual(expect.objectContaining({
            status: "ERROR_PROCESSING",
            extracted_json: expect.objectContaining({
                billcom_sent_message_id: "sent-msg-1",
                processing_state: "processing_error",
                processing_success: false,
            }),
        }));
    });
});
