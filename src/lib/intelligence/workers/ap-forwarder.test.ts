import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = new Database(":memory:");
mem.exec(`
  CREATE TABLE ap_local_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_message_id TEXT NOT NULL,
    email_from TEXT,
    email_subject TEXT,
    pdf_filename TEXT NOT NULL,
    pdf_content_hash TEXT NOT NULL,
    billcom_sent_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'FORWARDED',
    reconciliation_status TEXT,
    matched_po_number TEXT,
    reconciliation_notes TEXT,
    error_message TEXT,
    forwarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reconciled_at DATETIME,
    completed_at DATETIME,
    vendor_routing_action TEXT,
    verified INTEGER DEFAULT 0,
    billcom_processed INTEGER DEFAULT 0,
    ocr_raw_text TEXT,
    ocr_vendor_name TEXT,
    ocr_invoice_number TEXT,
    ocr_total TEXT,
    reconciliation_verdict TEXT,
    reconciliation_result_json TEXT,
    UNIQUE(gmail_message_id, pdf_filename)
  );
  CREATE TABLE billcom_bills_ref (
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    UNIQUE(invoice_number, vendor_name)
  );
  CREATE TABLE invoice_cache (
    invoice_number TEXT,
    expire_at DATETIME
  );
`);

const {
    gmailFactoryMock,
    getAuthenticatedClientMock,
    createClientMock,
    applyMessageLabelPolicyMock,
    processInvoiceBufferMock,
    downloadPDFMock,
} = vi.hoisted(() => ({
    gmailFactoryMock: vi.fn(),
    getAuthenticatedClientMock: vi.fn(),
    createClientMock: vi.fn(),
    applyMessageLabelPolicyMock: vi.fn(),
    processInvoiceBufferMock: vi.fn(),
    downloadPDFMock: vi.fn(),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: gmailFactoryMock,
}));

vi.mock("../../storage/supabase-storage", () => ({
    downloadPDF: downloadPDFMock,
}));

vi.mock("../../storage/local-db", () => ({
    getLocalDb: () => mem,
}));

vi.mock("../../gmail/auth", () => ({
    getAuthenticatedClient: getAuthenticatedClientMock,
}));

vi.mock("../../db", () => ({
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
        // The legacy forwarder path is env-gated (default off — ap-local-forwarder is the
        // live path). These tests exercise the legacy path deliberately.
        process.env.DEPRECATED_FORWARDER_ENABLED = "true";
        mem.prepare("DELETE FROM ap_local_forwards").run();
        mem.prepare("DELETE FROM billcom_bills_ref").run();
        getAuthenticatedClientMock.mockResolvedValue({});
        downloadPDFMock.mockResolvedValue(Buffer.from("pdf-data"));
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

        const lockStatusInMock = vi.fn().mockResolvedValue({ error: null });
                const lockIdEqMock = vi.fn(() => ({
                    in: lockStatusInMock,
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

        // The single-forward gate dedups the second loop iteration (the mock returns
        // the same queue item for both the PENDING and ERROR queries), so exactly ONE
        // send reaches Bill.com — the invariant, not a bug.
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
            format: "full",
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

        const lockStatusInMock = vi.fn().mockResolvedValue({ error: null });
                const lockIdEqMock = vi.fn(() => ({
                    in: lockStatusInMock,
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

    it("archives the source email once Bill.com has the invoice even if post-processing fails", async () => {
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
        const lockStatusInMock = vi.fn().mockResolvedValue({ error: null });
                const lockIdEqMock = vi.fn(() => ({
                    in: lockStatusInMock,
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
                // Bill.com send verified → email marked processed and archived even
                // though OCR/PO-match failed (retry lives in /aphealth, not the inbox).
                expect(applyMessageLabelPolicyMock).toHaveBeenCalledTimes(1);
                expect(emailQueueUpdateMock).toHaveBeenCalledWith({ processed_by_ap: true });
        expect(updateCalls).toContainEqual(expect.objectContaining({
                    status: "FORWARDED",
                    extracted_json: expect.objectContaining({
                        billcom_sent_message_id: "sent-msg-1",
                        processing_state: "processing_error",
                        processing_success: false,
            }),
        }));
    });
});
