import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    extractPDFMock,
    extractPDFWithLLMMock,
    parseInvoiceMock,
    sendMessageMock,
    getOrderDetailsMock,
} = vi.hoisted(() => ({
    extractPDFMock: vi.fn(),
    extractPDFWithLLMMock: vi.fn(),
    parseInvoiceMock: vi.fn(),
    sendMessageMock: vi.fn(),
    getOrderDetailsMock: vi.fn(),
}));

vi.mock("../pdf/extractor", () => ({
    extractPDF: extractPDFMock,
    extractPDFWithLLM: extractPDFWithLLMMock,
}));

vi.mock("../pdf/invoice-parser", () => ({
    parseInvoice: parseInvoiceMock,
}));

vi.mock("../storage/vendor-invoices", () => ({
    upsertVendorInvoice: vi.fn(),
}));

vi.mock("../storage/invoice-review-corpus", () => ({
    upsertInvoiceReviewSample: vi.fn(),
}));

vi.mock("../finale/client", () => ({
    FinaleClient: class {
        getOrderDetails = getOrderDetailsMock;
        getOrderSummary = vi.fn();
        findPOByVendorAndDate = vi.fn().mockResolvedValue([]);
    },
}));

vi.mock("../finale/reconciler", () => ({
    reconcileInvoiceToPO: vi.fn(),
    applyReconciliation: vi.fn(),
    storePendingApproval: vi.fn(),
    updatePendingApprovalMessageId: vi.fn(),
    buildAuditMetadata: vi.fn(),
    buildReconciliationReport: vi.fn(),
}));

vi.mock("./feedback-loop", () => ({
    recordFeedback: vi.fn(),
}));

import { APAgent } from "./ap-agent";

describe("APAgent processInvoiceBuffer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getOrderDetailsMock.mockResolvedValue({ orderId: "124547" });
        extractPDFMock.mockResolvedValue({
            rawText: "P.O. Number 124547\nInvoice #1000930",
            tables: [
                {
                    headers: ["P.O. Number", "Terms"],
                    rows: [["124547", "Net 30"]],
                },
            ],
            ocrStrategy: "pdf-parse",
            ocrDurationMs: 11,
        });
        extractPDFWithLLMMock.mockResolvedValue({
            rawText: "P.O. Number 124547\nInvoice #1000930\nVendor: Coats",
            tables: [
                {
                    headers: ["P.O. Number", "Terms"],
                    rows: [["124547", "Net 30"]],
                },
            ],
            ocrStrategy: "anthropic",
            ocrDurationMs: 55,
        });
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: null,
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [{ description: "line", qty: 1, unitPrice: 1, total: 1 }],
            subtotal: 1,
            total: 1,
            amountDue: 1,
            confidence: "low",
        });
        sendMessageMock.mockResolvedValue(undefined);
    });

    it("passes extracted tables into parseInvoice for PO recovery", async () => {
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: "124547",
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [{ description: "line", qty: 1, unitPrice: 1, total: 1 }],
            subtotal: 1,
            total: 1,
            amountDue: 1,
            confidence: "medium",
        });

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Coats Agri Aloe, Inc.");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).reconcileAndUpdate = vi.fn().mockResolvedValue({
            success: true,
            verdict: "auto_approve",
        });

        const supabase = {
            from: vi.fn((table: string) => ({
                insert: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({ data: null }),
                    })),
                })),
                upsert: vi.fn().mockResolvedValue(undefined),
            })),
        };

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "coats.pdf",
            "Coats invoice",
            "billing@coats.example",
            supabase,
        );

        expect(parseInvoiceMock).toHaveBeenCalledWith(
            "P.O. Number 124547\nInvoice #1000930",
            [["P.O. Number | Terms", "124547 | Net 30"]],
        );
        expect(result).toEqual(expect.objectContaining({
            success: true,
            state: "reconciled",
            matchedPO: true,
            invoiceNumber: "1000930",
            poNumber: "124547",
        }));
    });

    it("retries suspicious first-pass OCR and logs first-pass telemetry without overwriting it", async () => {
        parseInvoiceMock
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "1000930",
                poNumber: null,
                vendorName: "UNKNOWN",
                invoiceDate: "2026-03-26",
                lineItems: [],
                subtotal: 0,
                total: 0,
                amountDue: 0,
                confidence: "low",
            })
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "1000930",
                poNumber: "124547",
                vendorName: "Coats Agri Aloe, Inc.",
                invoiceDate: "2026-03-26",
                lineItems: [{ description: "GroAloe", qty: 1, unitPrice: 88.72, total: 88.72 }],
                subtotal: 88.72,
                total: 88.72,
                amountDue: 88.72,
                confidence: "low",
            });

        const inserts: Record<string, any[]> = { ap_activity_log: [], documents: [] };
        const supabase = {
            from: vi.fn((table: string) => ({
                insert: vi.fn((payload: any) => {
                    inserts[table] ||= [];
                    inserts[table].push(payload);
                    return {
                        select: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({ data: { id: "doc-1" } }),
                        })),
                    };
                }),
                upsert: vi.fn().mockResolvedValue(undefined),
            })),
        };

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Coats Agri Aloe, Inc.");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).reconcileAndUpdate = vi.fn().mockResolvedValue({
            success: true,
            verdict: "auto_approve",
        });

        await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "coats-retry.pdf",
            "Coats invoice",
            "billing@coats.example",
            supabase,
        );

        expect(extractPDFWithLLMMock).toHaveBeenCalledTimes(1);
        expect(parseInvoiceMock).toHaveBeenCalledTimes(2);

        const retryLog = inserts.ap_activity_log.find((row) => row.intent === "OCR_RETRY");
        expect(retryLog).toBeDefined();
        expect(retryLog.metadata.retryReasons).toContain("po_missing");
        expect(retryLog.metadata.retryReasons).toContain("zero_line_items");
        expect(retryLog.metadata.retryOutcome).toBe("improved");
        expect(retryLog.metadata.firstPassPO).toBeNull();
        expect(retryLog.metadata.firstPassLineItems).toBe(0);
        expect(retryLog.metadata.firstPassTotal).toBe(0);
        expect(retryLog.metadata.firstPassStrategy).toBe("pdf-parse");
    });

    it("continues into matching after retry when deterministic signals are recovered", async () => {
        parseInvoiceMock
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "1000930",
                poNumber: null,
                vendorName: "UNKNOWN",
                invoiceDate: "2026-03-26",
                lineItems: [],
                subtotal: 0,
                total: 0,
                amountDue: 0,
                confidence: "low",
            })
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "1000930",
                poNumber: "124547",
                vendorName: "Coats Agri Aloe, Inc.",
                invoiceDate: "2026-03-26",
                lineItems: [{ description: "GroAloe", qty: 1, unitPrice: 88.72, total: 88.72 }],
                subtotal: 88.72,
                total: 88.72,
                amountDue: 88.72,
                confidence: "low",
            });

        const inserts: Record<string, any[]> = { ap_activity_log: [], documents: [], invoices: [] };
        const supabase = {
            from: vi.fn((table: string) => ({
                insert: vi.fn((payload: any) => {
                    inserts[table] ||= [];
                    inserts[table].push(payload);
                    return {
                        select: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({ data: { id: "doc-1" } }),
                        })),
                    };
                }),
                upsert: vi.fn((payload: any) => {
                    inserts[table] ||= [];
                    inserts[table].push(payload);
                    return Promise.resolve(undefined);
                }),
            })),
        };

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Coats Agri Aloe, Inc.");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).reconcileAndUpdate = vi.fn().mockResolvedValue({
            success: true,
            verdict: "auto_approve",
        });

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "coats-retry-continue.pdf",
            "Coats invoice",
            "billing@coats.example",
            supabase,
        );

        expect(extractPDFWithLLMMock).toHaveBeenCalledTimes(1);
        expect((agent as any).sendNotification).toHaveBeenCalledTimes(1);
        expect((agent as any).reconcileAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "124547", confidence: "low" }),
            "124547",
            supabase,
            false,
            "PO# on invoice",
        );
        expect(inserts.documents.some((row) => row.status === "ocr_failed")).toBe(false);
        expect(result).toEqual(expect.objectContaining({
            success: true,
            state: "reconciled",
            matchedPO: true,
            invoiceNumber: "1000930",
            poNumber: "124547",
        }));
    });

    it("does not retry a low-confidence parse when core reconciliation signals are already present", async () => {
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: "124547",
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [
                { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
                { description: "Shipping and Handling", qty: 1, unitPrice: 88.72, total: 88.72 },
            ],
            subtotal: 4600,
            freight: 88.72,
            tax: 0,
            total: 4688.72,
            amountDue: 4688.72,
            confidence: "low",
        });

        const supabase = {
            from: vi.fn((table: string) => ({
                insert: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({ data: { id: "doc-1" } }),
                    })),
                })),
                upsert: vi.fn().mockResolvedValue(undefined),
            })),
        };

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Coats Agri Aloe, Inc.");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).reconcileAndUpdate = vi.fn().mockResolvedValue({
            success: true,
            verdict: "auto_approve",
        });

        await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "coats-no-retry.pdf",
            "Coats invoice",
            "billing@coats.example",
            supabase,
        );

        expect(extractPDFWithLLMMock).not.toHaveBeenCalled();
        expect((agent as any).reconcileAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ poNumber: "124547", total: 4688.72 }),
            "124547",
            supabase,
            false,
            "PO# on invoice",
        );
    });

    it("returns an unmatched outcome when no Finale PO can be resolved", async () => {
        getOrderDetailsMock.mockRejectedValue(new Error("missing"));
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "200200",
            poNumber: "999999",
            vendorName: "Unknown Vendor",
            invoiceDate: "2026-03-26",
            lineItems: [{ description: "line", qty: 1, unitPrice: 10, total: 10 }],
            subtotal: 10,
            total: 10,
            amountDue: 10,
            confidence: "medium",
        });

        const supabase = {
            from: vi.fn((table: string) => ({
                insert: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({ data: { id: `${table}-1` } }),
                    })),
                })),
                upsert: vi.fn().mockResolvedValue(undefined),
            })),
        };

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Unknown Vendor");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).reconcileAndUpdate = vi.fn();

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "unknown-vendor.pdf",
            "Unknown Vendor invoice",
            "billing@unknown.example",
            supabase,
        );

        expect((agent as any).reconcileAndUpdate).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            success: true,
            state: "unmatched",
            matchedPO: false,
            invoiceNumber: "200200",
            poNumber: null,
        }));
    });
});
