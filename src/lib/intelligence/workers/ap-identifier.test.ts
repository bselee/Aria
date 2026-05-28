import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailFactoryMock,
    getAuthenticatedClientMock,
    createClientMock,
    queueStatementEmailIntakeMock,
    queueStatementMetadataOnlyMock,
    applyMessageLabelPolicyMock,
    unifiedObjectGenerationMock,
    getPreClassificationMock,
    pdfDocumentLoadMock,
    pdfDocumentCreateMock,
    extractPDFMock,
    extractPDFWithLLMMock,
} = vi.hoisted(() => ({
    gmailFactoryMock: vi.fn(),
    getAuthenticatedClientMock: vi.fn(),
    createClientMock: vi.fn(),
    queueStatementEmailIntakeMock: vi.fn(),
    queueStatementMetadataOnlyMock: vi.fn(),
    applyMessageLabelPolicyMock: vi.fn(),
    unifiedObjectGenerationMock: vi.fn(),
    getPreClassificationMock: vi.fn(),
    pdfDocumentLoadMock: vi.fn(),
    pdfDocumentCreateMock: vi.fn(),
    extractPDFMock: vi.fn(),
    extractPDFWithLLMMock: vi.fn(),
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

vi.mock("../llm", () => ({
    unifiedObjectGeneration: unifiedObjectGenerationMock,
    unifiedTextGeneration: vi.fn(),
}));

vi.mock("../memory", () => ({
    recall: vi.fn().mockResolvedValue([]),
}));

vi.mock("../inline-invoice-parser", () => ({
    detectPaidInvoice: vi.fn().mockReturnValue(false),
    parsePaidInvoice: vi.fn(),
}));

vi.mock("../nightshift-agent", () => ({
    getPreClassification: getPreClassificationMock,
}));

vi.mock("../../finale/client", () => ({
    FinaleClient: class {},
}));

vi.mock("../gmail-policy", () => ({
    applyMessageLabelPolicy: applyMessageLabelPolicyMock,
}));

vi.mock("./ap-identifier-policy", () => ({
    getAPHumanInteractionPolicy: vi.fn(() => ({
        addLabels: [],
        removeLabels: [],
        activityNote: "Human interaction",
        reasonCode: "human",
    })),
    getAPMissingPdfPolicy: vi.fn(() => ({
        addLabels: [],
        removeLabels: [],
        activityNote: "Missing PDF",
        reasonCode: "missing_pdf",
    })),
    getInvoiceInboxPolicy: vi.fn(() => ({
        queueForBillCom: true,
        addLabels: [],
        removeLabels: ["INBOX", "UNREAD"],
        activityNote: "Queued for Bill.com forward",
        reasonCode: "queued_for_billcom",
    })),
}));

vi.mock("@/lib/statements/email-intake", () => ({
    queueStatementEmailIntake: queueStatementEmailIntakeMock,
    queueStatementMetadataOnly: queueStatementMetadataOnlyMock,
}));


vi.mock("pdf-lib", () => ({
    PDFDocument: {
        load: pdfDocumentLoadMock,
        create: pdfDocumentCreateMock,
    },
}));

vi.mock("../../pdf/extractor", () => ({
    extractPDF: extractPDFMock,
    extractPDFWithLLM: extractPDFWithLLMMock,
}));

import { APIdentifierAgent } from "./ap-identifier";

describe("APIdentifierAgent single-pipeline invoice handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthenticatedClientMock.mockResolvedValue({});
        getPreClassificationMock.mockResolvedValue(null);
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "HUMAN_INTERACTION" });
        extractPDFMock.mockResolvedValue({
            rawText: "INVOICE",
            pages: [{ pageNumber: 1, text: "INVOICE", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 0 },
            hasImages: false,
            ocrStrategy: "test",
            ocrDurationMs: 1,
        });
    });

    it("queues FedEx PDF invoices without relying on LLM classification and leaves Gmail state unchanged until forward success", async () => {
        const queueRows = [
            {
                id: "row-fedex-1",
                subject: "Your FedEx invoice is ready",
                from_email: "billing@fedex.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-fedex-1",
                source_inbox: "ap",
                pdf_filenames: ["fedex-bill-1001.pdf"],
            },
        ];

        const modifyMock = vi.fn();
        const attachmentGetMock = vi.fn().mockResolvedValue({
            data: { data: Buffer.from("fedex-pdf").toString("base64url") },
        });
        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "fedex-bill-1001.pdf", body: { attachmentId: "att-fedex-1" } },
                                ],
                            },
                        },
                    }),
                    modify: modifyMock,
                    attachments: {
                        get: attachmentGetMock,
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const maybeSingleMock = vi.fn().mockResolvedValue({ data: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: maybeSingleMock,
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: insertMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    upload: vi.fn().mockResolvedValue({ error: null }),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(unifiedObjectGenerationMock).not.toHaveBeenCalled();
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            email_from: "billing@fedex.com",
            pdf_filename: "fedex-bill-1001.pdf",
            status: "PENDING_FORWARD",
            extracted_json: expect.objectContaining({
                source_gmail_message_id: "gmail-fedex-1",
                completion_mode: "forward_success",
            }),
        }));
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: true });
        expect(modifyMock).not.toHaveBeenCalled();
    });

    it("archives Pioneer Propane invoices instead of queueing them to Bill.com even when the PDF filename looks invoice-like", async () => {
        const queueRows = [
            {
                id: "row-pioneer-1",
                subject: "Invoice 106745 from Pioneer Propanen Inc.",
                from_email: "pioneerpropaneinc@gmail.com",
                body_snippet: "Invoice attached",
                body_text: "Invoice attached",
                gmail_message_id: "gmail-pioneer-1",
                source_inbox: "ap",
                pdf_filenames: ["Inv_106745_from_Pioneer_Propane_Inc._2150885_53300.pdf"],
            },
        ];

        const getMock = vi.fn();
        const modifyMock = vi.fn().mockResolvedValue({});
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: getMock,
                    modify: modifyMock,
                    attachments: {
                        get: vi.fn(),
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: insertMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(getMock).not.toHaveBeenCalled();
        expect(insertMock).not.toHaveBeenCalled();
        expect(modifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-pioneer-1",
            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] },
        });
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: true });
    });

    it("trims mixed paperwork packets down to the primary invoice page before queueing", async () => {
        const queueRows = [
            {
                id: "row-fedex-mixed-1",
                subject: "Your FedEx invoice is ready",
                from_email: "billing@fedex.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-fedex-mixed-1",
                source_inbox: "ap",
                pdf_filenames: ["fedex-bill-1002.pdf"],
            },
        ];

        const modifyMock = vi.fn();
        const attachmentGetMock = vi.fn().mockResolvedValue({
            data: { data: Buffer.from("fedex-mixed-pdf").toString("base64url") },
        });
        const uploadMock = vi.fn().mockResolvedValue({ error: null });
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const maybeSingleMock = vi.fn().mockResolvedValue({ data: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
        const copyPagesMock = vi.fn().mockResolvedValue([{}]);
        const addPageMock = vi.fn();
        const saveMock = vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9]));

        extractPDFMock.mockResolvedValue({
            rawText: "INVOICE\nInvoice Number INV-1002\nAmount Due $120.44",
            pages: [
                {
                    pageNumber: 1,
                    text: "INVOICE\nInvoice Number INV-1002\nAmount Due $120.44\nBill To BuildASoil",
                    hasTable: true,
                },
                {
                    pageNumber: 2,
                    text: "PACKING SLIP\nTracking Number 1Z123\nShipment Details",
                    hasTable: false,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 123 },
            hasImages: false,
            ocrStrategy: "test",
            ocrDurationMs: 1,
        });
        pdfDocumentLoadMock.mockResolvedValue({
            getPageCount: vi.fn().mockReturnValue(2),
        });
        pdfDocumentCreateMock.mockResolvedValue({
            copyPages: copyPagesMock,
            addPage: addPageMock,
            save: saveMock,
        });

        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "fedex-bill-1002.pdf", body: { attachmentId: "att-fedex-mixed-1" } },
                                ],
                            },
                        },
                    }),
                    modify: modifyMock,
                    attachments: {
                        get: attachmentGetMock,
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: maybeSingleMock,
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: insertMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    upload: uploadMock,
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(pdfDocumentLoadMock).toHaveBeenCalledTimes(1);
        expect(pdfDocumentCreateMock).toHaveBeenCalledTimes(1);
        expect(copyPagesMock).toHaveBeenCalledWith(expect.anything(), [0]);
        expect(uploadMock).toHaveBeenCalledWith(
            expect.any(String),
            Buffer.from([9, 9, 9]),
            expect.objectContaining({ contentType: "application/pdf" }),
        );
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            extracted_json: expect.objectContaining({
                selected_invoice_page: 1,
            }),
        }));
        expect(modifyMock).not.toHaveBeenCalled();
    });

    it("forces stronger OCR for ambiguous FedEx packets before trimming the selected invoice page", async () => {
        const queueRows = [
            {
                id: "row-fedex-ocr-1",
                subject: "Your FedEx invoice is ready",
                from_email: "billing@fedex.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-fedex-ocr-1",
                source_inbox: "ap",
                pdf_filenames: ["fedex-bill-1004.pdf"],
            },
        ];

        const attachmentGetMock = vi.fn().mockResolvedValue({
            data: { data: Buffer.from("fedex-ocr-pdf").toString("base64url") },
        });
        const uploadMock = vi.fn().mockResolvedValue({ error: null });
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const maybeSingleMock = vi.fn().mockResolvedValue({ data: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
        const copyPagesMock = vi.fn().mockResolvedValue([{}]);
        const addPageMock = vi.fn();
        const saveMock = vi.fn().mockResolvedValue(new Uint8Array([4, 4, 4]));

        extractPDFMock.mockResolvedValue({
            rawText: "Shipment paperwork\nReference 1004",
            pages: [
                { pageNumber: 1, text: "Shipment paperwork\nReference 1004", hasTable: false },
                { pageNumber: 2, text: "Scanned invoice page", hasTable: true },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 456 },
            hasImages: true,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 1,
        });
        extractPDFWithLLMMock.mockResolvedValue({
            rawText: "INVOICE\nInvoice Number INV-1004\nAmount Due $210.00",
            pages: [
                { pageNumber: 1, text: "Shipment paperwork\nTracking Number 777", hasTable: false },
                {
                    pageNumber: 2,
                    text: "INVOICE\nInvoice Number INV-1004\nAmount Due $210.00\nBill To BuildASoil",
                    hasTable: true,
                },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 456 },
            hasImages: true,
            ocrStrategy: "google/gemini-2.5-flash",
            ocrDurationMs: 200,
        });
        pdfDocumentLoadMock.mockResolvedValue({
            getPageCount: vi.fn().mockReturnValue(2),
        });
        pdfDocumentCreateMock.mockResolvedValue({
            copyPages: copyPagesMock,
            addPage: addPageMock,
            save: saveMock,
        });

        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "fedex-bill-1004.pdf", body: { attachmentId: "att-fedex-ocr-1" } },
                                ],
                            },
                        },
                    }),
                    modify: vi.fn(),
                    attachments: {
                        get: attachmentGetMock,
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: maybeSingleMock,
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: insertMock,
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    upload: uploadMock,
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(extractPDFWithLLMMock).toHaveBeenCalledTimes(1);
        expect(copyPagesMock).toHaveBeenCalledWith(expect.anything(), [1]);
        expect(uploadMock).toHaveBeenCalledWith(
            expect.any(String),
            Buffer.from([4, 4, 4]),
            expect.objectContaining({ contentType: "application/pdf" }),
        );
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            extracted_json: expect.objectContaining({
                selected_invoice_page: 2,
            }),
        }));
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: true });
    });

    it("leaves ambiguous multi-page FedEx packets unread instead of forwarding extra paperwork", async () => {
        const queueRows = [
            {
                id: "row-fedex-ambiguous-1",
                subject: "Your FedEx invoice is ready",
                from_email: "billing@fedex.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-fedex-ambiguous-1",
                source_inbox: "ap",
                pdf_filenames: ["fedex-bill-1005.pdf"],
            },
        ];

        const attachmentGetMock = vi.fn().mockResolvedValue({
            data: { data: Buffer.from("fedex-ambiguous-pdf").toString("base64url") },
        });
        const uploadMock = vi.fn().mockResolvedValue({ error: null });
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const maybeSingleMock = vi.fn().mockResolvedValue({ data: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));

        extractPDFMock.mockResolvedValue({
            rawText: "Shipment packet",
            pages: [
                { pageNumber: 1, text: "Shipment packet\nReference 1005", hasTable: false },
                { pageNumber: 2, text: "Additional paperwork\nReference 1005", hasTable: false },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 789 },
            hasImages: true,
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 1,
        });
        extractPDFWithLLMMock.mockResolvedValue({
            rawText: "Shipment packet\nAdditional paperwork",
            pages: [
                { pageNumber: 1, text: "Shipment packet\nReference 1005", hasTable: false },
                { pageNumber: 2, text: "Additional paperwork\nReference 1005", hasTable: false },
            ],
            tables: [],
            metadata: { pageCount: 2, fileSize: 789 },
            hasImages: true,
            ocrStrategy: "google/gemini-2.5-flash",
            ocrDurationMs: 200,
        });

        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "fedex-bill-1005.pdf", body: { attachmentId: "att-fedex-ambiguous-1" } },
                                ],
                            },
                        },
                    }),
                    modify: vi.fn(),
                    attachments: {
                        get: attachmentGetMock,
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: maybeSingleMock,
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                        insert: vi.fn().mockResolvedValue({}),
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: insertMock,
                    };
                }
                if (table === "ap_activity_log") {
                    return {
                        insert: vi.fn().mockResolvedValue({}),
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    upload: uploadMock,
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(extractPDFWithLLMMock).toHaveBeenCalledTimes(1);
        expect(uploadMock).not.toHaveBeenCalled();
        expect(insertMock).not.toHaveBeenCalled();
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: true });
    });


    it("marks the email for retry when an uncaught message fetch error occurs", async () => {
        const queueRows = [
            {
                id: "row-fedex-retry-1",
                subject: "Your FedEx invoice is ready",
                from_email: "billing@fedex.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-fedex-retry-1",
                source_inbox: "ap",
                pdf_filenames: ["fedex-bill-1003.pdf"],
            },
        ];

        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockRejectedValue(new Error("gmail unavailable")),
                    attachments: {
                        get: vi.fn(),
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({
                                    data: queueRows,
                                    error: null,
                                }),
                            })),
                        })),
                        update: updateMock,
                        insert: vi.fn().mockResolvedValue({}),
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => apQueueSelectChain),
                        insert: vi.fn().mockResolvedValue({ error: null }),
                    };
                }
                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
            storage: {
                from: vi.fn(() => ({
                    upload: vi.fn().mockResolvedValue({ error: null }),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: false });
    });

    // DECISION(2026-05-20): AAA Cooper statement splitting is retired,
    // hence stale statement recovery tests are obsolete and removed.
});

describe("APIdentifierAgent classifyEmailIntent — KAIZEN #3 nightshift bypass", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("skips paid Sonnet when nightshift returns conf >= 0.7 with a known label", async () => {
        getPreClassificationMock.mockResolvedValue({
            classification: "ADVERTISEMENT",
            handler: "claude-haiku",
            confidence: 0.92,
        });

        const agent: any = new APIdentifierAgent();
        const intent = await agent.classifyEmailIntent(
            "Big sale this week!",
            "marketing@vendor.com",
            "Click here for 20% off",
            "gmail-msg-bypass-1",
        );

        expect(intent).toBe("ADVERTISEMENT");
        expect(getPreClassificationMock).toHaveBeenCalledWith("gmail-msg-bypass-1");
        expect(unifiedObjectGenerationMock).not.toHaveBeenCalled();
    });

    it("falls through to paid Sonnet when nightshift confidence is below 0.7", async () => {
        getPreClassificationMock.mockResolvedValue({
            classification: "INVOICE",
            handler: "claude-haiku",
            confidence: 0.55,
        });
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "HUMAN_INTERACTION" });

        const agent: any = new APIdentifierAgent();
        const intent = await agent.classifyEmailIntent(
            "Question about my order",
            "customer@vendor.com",
            "Hi, when does this ship?",
            "gmail-msg-lowconf",
        );

        expect(intent).toBe("HUMAN_INTERACTION");
        expect(unifiedObjectGenerationMock).toHaveBeenCalledTimes(1);
    });

    it("falls through to paid Sonnet when nightshift returns null (not yet classified)", async () => {
        getPreClassificationMock.mockResolvedValue(null);
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "INVOICE" });

        const agent: any = new APIdentifierAgent();
        const intent = await agent.classifyEmailIntent(
            "Invoice 12345",
            "ap@vendor.com",
            "Please remit payment",
            "gmail-msg-null",
        );

        expect(intent).toBe("INVOICE");
        expect(unifiedObjectGenerationMock).toHaveBeenCalledTimes(1);
    });

    it("ignores nightshift label outside the known set and falls through to paid Sonnet", async () => {
        getPreClassificationMock.mockResolvedValue({
            classification: "GARBAGE_LABEL",
            handler: "claude-haiku",
            confidence: 0.99,
        });
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "HUMAN_INTERACTION" });

        const agent: any = new APIdentifierAgent();
        const intent = await agent.classifyEmailIntent(
            "Some subject",
            "x@y.com",
            "snippet",
            "gmail-msg-bad-label",
        );

        expect(intent).toBe("HUMAN_INTERACTION");
        expect(unifiedObjectGenerationMock).toHaveBeenCalledTimes(1);
    });

    it("calls paid Sonnet when no gmailMessageId is provided (defensive fallback)", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "STATEMENT" });

        const agent: any = new APIdentifierAgent();
        const intent = await agent.classifyEmailIntent(
            "Statement of account",
            "ar@vendor.com",
            "Your monthly statement is attached",
        );

        expect(intent).toBe("STATEMENT");
        expect(getPreClassificationMock).not.toHaveBeenCalled();
        expect(unifiedObjectGenerationMock).toHaveBeenCalledTimes(1);
    });
});
