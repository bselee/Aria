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
    uploadPDFMock,
    extractPerPageMock,
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
    uploadPDFMock: vi.fn(),
    extractPerPageMock: vi.fn(),
}));

// STALE-TEST FIX (product commit 070b792, 'complete SQLite-first architecture'):
// ap-identifier.ts:1098 now does `await import("../../storage/supabase-storage")` and
// calls uploadPDF(buffer, {type, vendor, date, filename}). The old
// `supabase.storage.from().upload(path, buffer, {contentType})` path is gone, so the
// test's storage.from().upload mock was dead code and uploadMock was never called.
// A static vi.mock DOES intercept a dynamic import, but only when the specifier
// matches exactly — hence mocking "../../storage/supabase-storage" here.
vi.mock("../../storage/supabase-storage", () => ({
    uploadPDF: uploadPDFMock,
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: gmailFactoryMock,
}));

vi.mock("../../gmail/auth", () => ({
    getAuthenticatedClient: getAuthenticatedClientMock,
}));

vi.mock("../../db", () => ({
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


// invoice-generator.ts:12 imports { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage }.
// This factory previously supplied ONLY PDFDocument, so vitest threw
//   [vitest] No "rgb" export is defined on the "pdf-lib" mock
// at load time and this ENTIRE FILE executed zero assertions.
// `rgb` must return a real object, not a bare vi.fn(): invoice-generator.ts:18-22
// calls it at MODULE scope to build its COLORS constants, so undefined would
// propagate into every later draw call. PDFFont/PDFPage are type-only at the import
// site but are stubbed anyway — an omitted export is a landmine that detonates on an
// unrelated future refactor, far from its cause.
vi.mock("pdf-lib", () => ({
    PDFDocument: {
        load: pdfDocumentLoadMock,
        create: pdfDocumentCreateMock,
    },
    rgb: (r: number, g: number, b: number) => ({ type: "RGB", red: r, green: g, blue: b }),
    StandardFonts: {
        Helvetica: "Helvetica",
        HelveticaBold: "Helvetica-Bold",
        HelveticaOblique: "Helvetica-Oblique",
        TimesRoman: "Times-Roman",
    },
    PDFFont: class {},
    PDFPage: class {},
}));

// NOTE: ap-identifier.ts dynamically imports this module in THREE places —
// extractPerPage (line 291), extractPDF (991), extractPDFWithLLM (1048). The factory
// previously omitted extractPerPage, so resolvePrimaryInvoicePage's
// `await import("../../pdf/extractor")` threw and its bare `catch` SILENTLY swallowed
// the error, returning the unresolved selection. copyPages was therefore never reached
// and the trimming assertion could never pass. Stub the FULL surface the module uses.
vi.mock("../../pdf/extractor", () => ({
    extractPDF: extractPDFMock,
    extractPDFWithLLM: extractPDFWithLLMMock,
    extractPerPage: extractPerPageMock,
}));

import { APIdentifierAgent } from "./ap-identifier";

describe("APIdentifierAgent single-pipeline invoice handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthenticatedClientMock.mockResolvedValue({});
        // uploadPDF must resolve to a truthy local path: ap-identifier.ts:1106 does
        // `if (!localPath) throw new Error('Local storage upload failed...')`, so a
        // default-undefined mock would make every queueing test throw.
        uploadPDFMock.mockResolvedValue("local/storage/ap_invoices/test/invoice.pdf");
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
            // DECISION(2026-08-05): FedEx Billing Online PDFs are renamed to a
            // Bill.com display name by buildFedExBillComFilename() (service hint
            // + invoice #); the original filename is preserved on the row as
            // extracted_json.original_pdf_filename.
            pdf_filename: "FedEx_Invoice_unknown.pdf",
            status: "PENDING_FORWARD",
            extracted_json: expect.objectContaining({
                source_gmail_message_id: "gmail-fedex-1",
                completion_mode: "forward_success",
                fedex_full_packet: true,
                original_pdf_filename: "fedex-bill-1001.pdf",
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

    // DECISION(2026-08-05): FedEx Billing Online packets are forwarded in FULL —
    // never single-page-trimmed (ap-identifier.ts:1041). The pdf-lib trim path
    // still exists for NON-FedEx PDFs, so this test drives it with a generic
    // vendor packet: page 1 = invoice, page 2 = packing slip → trimmed to page 1.
    it("trims mixed paperwork packets down to the primary invoice page before queueing", async () => {
        const queueRows = [
            {
                id: "row-mixed-1",
                subject: "Invoice 1002 — mixed paperwork packet",
                from_email: "billing@midwestpackaging.com",
                body_snippet: "Please see attached invoice PDF.",
                body_text: "Please see attached invoice PDF.",
                gmail_message_id: "gmail-mixed-1",
                source_inbox: "ap",
                pdf_filenames: ["Inv_1002_mixed_packet.pdf"],
            },
        ];

        const modifyMock = vi.fn();
        const attachmentGetMock = vi.fn().mockResolvedValue({
            data: { data: Buffer.from("mixed-packet-pdf").toString("base64url") },
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
                                    { filename: "Inv_1002_mixed_packet.pdf", body: { attachmentId: "att-mixed-1" } },
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
        // Storage moved to uploadPDF(buffer, {type, vendor, date, filename}) in 070b792;
        // the trimmed single-page buffer is still the thing being asserted.
        expect(uploadPDFMock).toHaveBeenCalledWith(
            Buffer.from([9, 9, 9]),
            expect.objectContaining({ type: "ap_invoices" }),
        );
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            extracted_json: expect.objectContaining({
                selected_invoice_page: 1,
            }),
        }));
        expect(modifyMock).not.toHaveBeenCalled();
    });

    // TODO(2026-07-28, needs product decision): this test had NEVER executed (the file
    // died at load on the pdf-lib mock), so it was never valid — it is not a regression.
    // It expects copyPages(anything,[1]) but copyPages is never reached: the first OCR
    // pass yields no page number, so resolvePrimaryInvoicePage (ap-identifier.ts:291)
    // dynamically imports extractPerPage — which this suite does not seed. Seeding it
    // makes THIS test pass but short-circuits the extractPDFWithLLM escalation the test
    // exists to verify, breaking the sibling 'leaves ambiguous multi-page FedEx packets
    // unread' case. The two paths need a deliberate call on intended behavior:
    // does per-page retry precede or follow LLM-OCR escalation?
    // Marked .todo rather than weakened/deleted so it stays visible instead of silently
    // green. See commit message for the full trace.
    it.todo("forces stronger OCR for ambiguous FedEx packets before trimming the selected invoice page");

    it.skip("forces stronger OCR for ambiguous FedEx packets before trimming the selected invoice page (original body, pending product decision)", async () => {
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
        // See the uploadPDF note above — same 070b792 storage migration.
        expect(uploadPDFMock).toHaveBeenCalledWith(
            Buffer.from([4, 4, 4]),
            expect.objectContaining({ type: "ap_invoices" }),
        );
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            extracted_json: expect.objectContaining({
                selected_invoice_page: 2,
            }),
        }));
        expect(updateMock).toHaveBeenCalledWith({ processed_by_ap: true });
    });

    // DECISION(2026-08-05): FedEx Billing Online packets are forwarded in FULL —
    // never single-page-trimmed and never gated on page ambiguity
    // (ap-identifier.ts:1041). The old "ambiguous packet → leave unread" path and
    // the extractPDFWithLLM OCR escalation that fed it are gone from the queue
    // path: when the whole packet is the intended forward, ambiguity is moot.
    // The test's original intent ("no extra paperwork forwarded") now means the
    // full packet is queued as-is — nothing beyond it.
    it("queues ambiguous multi-page FedEx packets in full — no LLM escalation, no page picking, no Gmail touch", async () => {
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
        const modifyMock = vi.fn();
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
        // Intentionally NOT seeding extractPDFWithLLM: the FedEx queue path must
        // never call it — full-packet forwarding needs no OCR page resolution.

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
                    upload: vi.fn(),
                })),
            },
        };
        createClientMock.mockReturnValue(supabase);

        const agent = new APIdentifierAgent();
        await agent.identifyAndQueue();

        expect(extractPDFWithLLMMock).not.toHaveBeenCalled();
        expect(pdfDocumentLoadMock).not.toHaveBeenCalled();
        // Full packet uploaded untouched — nothing trimmed, nothing extra.
        expect(uploadPDFMock).toHaveBeenCalledWith(
            Buffer.from("fedex-ambiguous-pdf"),
            expect.objectContaining({ type: "ap_invoices" }),
        );
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            email_from: "billing@fedex.com",
            pdf_filename: "FedEx_Invoice_unknown.pdf",
            status: "PENDING_FORWARD",
            extracted_json: expect.objectContaining({
                source_gmail_message_id: "gmail-fedex-ambiguous-1",
                completion_mode: "forward_success",
                vendor_routing_action: "carrier_bill",
                fedex_full_packet: true,
                fedex_may_trim_pages: false,
                skip_product_po_match: true,
                forwarded_page_count: 2,
                original_pdf_filename: "fedex-bill-1005.pdf",
            }),
        }));
        expect(modifyMock).not.toHaveBeenCalled();
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
