import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailFactoryMock,
    getAuthenticatedClientMock,
    createClientMock,
    splitAAACooperStatementAttachmentsMock,
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
    splitAAACooperStatementAttachmentsMock: vi.fn(),
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
        addLabels: ["Follow Up"],
        removeLabels: [],
        activityNote: "Human interaction",
        reasonCode: "human",
    })),
    getAPMissingPdfPolicy: vi.fn(() => ({
        addLabels: ["Follow Up"],
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

vi.mock("../aaa-cooper-splitter", () => ({
    splitAAACooperStatementAttachments: splitAAACooperStatementAttachmentsMock,
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

describe("APIdentifierAgent AAA Cooper handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthenticatedClientMock.mockResolvedValue({});
        getPreClassificationMock.mockResolvedValue({ classification: "STATEMENT", handler: "test", confidence: 0.95 });
        unifiedObjectGenerationMock.mockResolvedValue({ intent: "STATEMENT" });
        queueStatementEmailIntakeMock.mockResolvedValue("intake-1");
        queueStatementMetadataOnlyMock.mockResolvedValue("meta-1");
        extractPDFMock.mockResolvedValue({
            rawText: "",
            pages: [{ pageNumber: 1, text: "", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 0 },
            hasImages: false,
            ocrStrategy: "test",
            ocrDurationMs: 1,
        });
        extractPDFWithLLMMock.mockResolvedValue({
            rawText: "",
            pages: [{ pageNumber: 1, text: "", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 0 },
            hasImages: false,
            ocrStrategy: "llm-test",
            ocrDurationMs: 1,
        });
    });

    it("returns needs_review so callers can leave the email unread", async () => {
        const gmail = {
            users: {
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    {
                                        filename: "ACT_STMD_001.pdf",
                                        body: { attachmentId: "att-1" },
                                    },
                                ],
                            },
                        },
                    }),
                    attachments: {
                        get: vi.fn().mockResolvedValue({
                            data: { data: Buffer.from("pdf").toString("base64url") },
                        }),
                    },
                },
            },
        };

        splitAAACooperStatementAttachmentsMock.mockResolvedValue({
            status: "needs_review",
            invoices: [],
            discardedCount: 0,
            diagnostics: {
                passUsed: 2,
                extractionStrategy: "anthropic",
                weakReason: "OCR confidence too weak",
                processedAttachmentCount: 1,
                processedAttachmentIds: ["att-1"],
            },
        });

        const agent = new APIdentifierAgent();

        const result = await (agent as any).handleMultiInvoiceStatement(
            {
                subject: "Transportation Statement",
                from_email: "billing@aaacooper.com",
                gmail_message_id: "msg-1",
                source_inbox: "ap",
            },
            gmail,
            {
                from: vi.fn(() => ({
                    insert: vi.fn().mockResolvedValue({}),
                })),
            },
            "AAA Cooper",
        );

        expect(splitAAACooperStatementAttachmentsMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual(expect.objectContaining({ status: "needs_review" }));
    });

    it("uses the shared splitter and queues invoice pages from every attachment", async () => {
        const attachmentGetMock = vi
            .fn()
            .mockResolvedValueOnce({ data: { data: Buffer.from("pdf-1").toString("base64url") } })
            .mockResolvedValueOnce({ data: { data: Buffer.from("pdf-2").toString("base64url") } });
        const uploadMock = vi.fn().mockResolvedValue({ error: null });
        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const maybeSingleMock = vi.fn().mockResolvedValue({ data: null });
        const copyPagesMock = vi.fn().mockResolvedValue([{}]);
        const addPageMock = vi.fn();
        const saveMock = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

        pdfDocumentLoadMock.mockResolvedValue({
            getPageCount: vi.fn().mockReturnValue(1),
        });
        pdfDocumentCreateMock.mockResolvedValue({
            copyPages: copyPagesMock,
            addPage: addPageMock,
            save: saveMock,
        });
        extractPDFMock.mockResolvedValue({
            rawText: "PRO\n64471581\n64471582\nSHIPMENT INFORMATION",
            pages: [{ pageNumber: 1, text: "PRO\n64471581\n64471582\nSHIPMENT INFORMATION", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 0 },
            hasImages: false,
            ocrStrategy: "test",
            ocrDurationMs: 1,
        });

        splitAAACooperStatementAttachmentsMock.mockResolvedValue({
            status: "split_ready",
            invoices: [
                { attachmentId: "att-1", attachmentName: "ACT_STMD_001.pdf", page: 1, invoiceNumber: "64471581", amount: 508 },
                { attachmentId: "att-2", attachmentName: "ACT_STMD_002.pdf", page: 1, invoiceNumber: "64471582", amount: 509 },
            ],
            discardedCount: 1,
            diagnostics: {
                passUsed: 2,
                extractionStrategy: "anthropic",
                processedAttachmentCount: 2,
                processedAttachmentIds: ["att-1", "att-2"],
            },
        });

        const gmail = {
            users: {
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "ACT_STMD_001.pdf", body: { attachmentId: "att-1" } },
                                    { filename: "ACT_STMD_002.pdf", body: { attachmentId: "att-2" } },
                                ],
                            },
                        },
                    }),
                    attachments: {
                        get: attachmentGetMock,
                    },
                },
            },
        };

        const apQueueSelectChain = {
            eq: vi.fn(() => apQueueSelectChain),
            gte: vi.fn(() => apQueueSelectChain),
            maybeSingle: maybeSingleMock,
        };
        const supabase = {
            from: vi.fn((table: string) => {
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

        const agent = new APIdentifierAgent();

        const result = await (agent as any).handleMultiInvoiceStatement(
            {
                subject: "Transportation Statement",
                from_email: "billing@aaacooper.com",
                gmail_message_id: "msg-1",
                source_inbox: "ap",
            },
            gmail,
            supabase,
            "AAA Cooper",
        );

        expect(splitAAACooperStatementAttachmentsMock).toHaveBeenCalledTimes(1);
        expect(attachmentGetMock).toHaveBeenCalledTimes(2);
        expect(uploadMock).toHaveBeenCalledTimes(2);
        expect(insertMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual(expect.objectContaining({ status: "handled", queuedCount: 2 }));
    });

    it("leaves the message unread when AAA Cooper needs review", async () => {
        const queueRows = [
            {
                id: "row-1",
                subject: "Transportation Statement",
                from_email: "billing@aaacooper.com",
                body_snippet: "statement attached",
                body_text: "statement attached",
                gmail_message_id: "msg-1",
                source_inbox: "ap",
                pdf_filenames: ["ACT_STMD_001.pdf"],
            },
        ];
        const modifyMock = vi.fn();
        const labelsListMock = vi.fn().mockResolvedValue({
            data: {
                labels: [
                    { id: "lbl-1", name: "Invoice Forward" },
                    { id: "lbl-2", name: "Statements" },
                ],
            },
        });
        const gmail = {
            users: {
                labels: {
                    list: labelsListMock,
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "ACT_STMD_001.pdf", body: { attachmentId: "att-1" } },
                                ],
                            },
                        },
                    }),
                    modify: modifyMock,
                    attachments: {
                        get: vi.fn().mockResolvedValue({
                            data: { data: Buffer.from("pdf-1").toString("base64url") },
                        }),
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        splitAAACooperStatementAttachmentsMock.mockResolvedValue({
            status: "needs_review",
            invoices: [],
            discardedCount: 0,
            diagnostics: {
                passUsed: 2,
                extractionStrategy: "anthropic",
                weakReason: "OCR confidence too weak",
                processedAttachmentCount: 1,
                processedAttachmentIds: ["att-1"],
            },
        });

        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
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

                return {
                    insert: vi.fn().mockResolvedValue({}),
                };
            }),
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(splitAAACooperStatementAttachmentsMock).toHaveBeenCalledTimes(1);
        expect(modifyMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                requestBody: expect.objectContaining({
                    removeLabelIds: expect.arrayContaining(["UNREAD"]),
                }),
            }),
        );
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: false });
    });
});

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

    it("leaves AAA Cooper unread when the cover sheet does not match the split invoices", async () => {
        getPreClassificationMock.mockResolvedValue({ classification: "STATEMENT", handler: "test", confidence: 0.95 });
        const queueRows = [
            {
                id: "row-aaa-mismatch",
                subject: "Transportation Statement",
                from_email: "billing@aaacooper.com",
                body_snippet: "statement attached",
                body_text: "statement attached",
                gmail_message_id: "msg-aaa-mismatch",
                source_inbox: "ap",
                pdf_filenames: ["ACT_STMD_001.pdf"],
            },
        ];
        const modifyMock = vi.fn();
        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({
                        data: {
                            labels: [
                                { id: "lbl-1", name: "Invoice Forward" },
                                { id: "lbl-2", name: "Statements" },
                            ],
                        },
                    }),
                    create: vi.fn(),
                },
                messages: {
                    get: vi.fn().mockResolvedValue({
                        data: {
                            payload: {
                                parts: [
                                    { filename: "ACT_STMD_001.pdf", body: { attachmentId: "att-1" } },
                                ],
                            },
                        },
                    }),
                    modify: modifyMock,
                    attachments: {
                        get: vi.fn().mockResolvedValue({
                            data: { data: Buffer.from("pdf-1").toString("base64url") },
                        }),
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);
        extractPDFMock.mockResolvedValue({
            rawText: "PRO\n64471588\nSHIPMENT INFORMATION",
            pages: [{ pageNumber: 1, text: "PRO\n64471588\nSHIPMENT INFORMATION", hasTable: false }],
            tables: [],
            metadata: { pageCount: 1, fileSize: 0 },
            hasImages: false,
            ocrStrategy: "test",
            ocrDurationMs: 1,
        });

        splitAAACooperStatementAttachmentsMock.mockResolvedValue({
            status: "split_ready",
            invoices: [
                { attachmentId: "att-1", attachmentName: "ACT_STMD_001.pdf", page: 2, invoiceNumber: "64471577", amount: 446.51 },
            ],
            discardedCount: 1,
            diagnostics: {
                passUsed: 1,
                extractionStrategy: "google/gemini-2.5-flash",
                processedAttachmentCount: 1,
                processedAttachmentIds: ["att-1"],
            },
        });

        const insertMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({}),
        }));
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

        expect(modifyMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                requestBody: expect.objectContaining({
                    removeLabelIds: expect.arrayContaining(["UNREAD"]),
                }),
            }),
        );
        expect(applyMessageLabelPolicyMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                removeLabels: expect.arrayContaining(["UNREAD"]),
            }),
        );
        expect(insertMock).not.toHaveBeenCalled();
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: false });
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

    it("recovers stale unread AAA Cooper statements that were previously marked processed", async () => {
        const queueSelectLimitMock = vi
            .fn()
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({
                data: [
                    {
                        id: "row-aaa-stale-1",
                        gmail_message_id: "gmail-aaa-stale-1",
                        from_email: "billing@aaacooper.com",
                        source_inbox: "ap",
                    },
                ],
                error: null,
            });
        const updateInMock = vi.fn().mockResolvedValue({});
        const apQueueContainsChain = {
            limit: vi.fn(() => apQueueContainsChain),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
        const apQueueErrorRetryChain = {
            eq: vi.fn().mockResolvedValue({ data: [] }),
        };
        const gmailGetMock = vi.fn().mockResolvedValue({
            data: {
                labelIds: ["INBOX", "UNREAD"],
            },
        });
        const gmail = {
            users: {
                labels: {
                    list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
                    create: vi.fn(),
                },
                messages: {
                    get: gmailGetMock,
                    attachments: {
                        get: vi.fn(),
                    },
                },
            },
        };
        gmailFactoryMock.mockReturnValue(gmail);

        const supabase = {
            from: vi.fn((table: string) => {
                if (table === "email_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            eq: vi.fn(() => ({
                                limit: queueSelectLimitMock,
                            })),
                        })),
                        update: vi.fn(() => ({
                            in: updateInMock,
                            eq: vi.fn().mockResolvedValue({}),
                        })),
                    };
                }
                if (table === "ap_inbox_queue") {
                    return {
                        select: vi.fn(() => ({
                            in: vi.fn(() => apQueueErrorRetryChain),
                            contains: vi.fn(() => apQueueContainsChain),
                        })),
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

        expect(gmailGetMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-aaa-stale-1",
            format: "metadata",
        });
        expect(updateInMock).toHaveBeenCalledWith("id", ["row-aaa-stale-1"]);
    });
});
