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
    recordFeedback: vi.fn().mockResolvedValue(undefined),
}));

import { APAgent } from "./ap-agent";

function createMockSupabase(inserts: Record<string, any[]> = {}) {
    const queryBuilder: any = {};

    queryBuilder.select = vi.fn(() => queryBuilder);
    queryBuilder.eq = vi.fn(() => queryBuilder);
    queryBuilder.ilike = vi.fn(() => queryBuilder);
    queryBuilder.gte = vi.fn(() => queryBuilder);
    queryBuilder.order = vi.fn(() => queryBuilder);
    queryBuilder.limit = vi.fn(() => queryBuilder);
    queryBuilder.single = vi.fn().mockResolvedValue({
        data: {
            id: "doc-1",
            autonomy_phase: 1,
            metadata: { test_mock: true }
        }
    });

    queryBuilder.insert = vi.fn((payload: any) => {
        return queryBuilder;
    });

    queryBuilder.update = vi.fn((payload: any) => queryBuilder);
    queryBuilder.upsert = vi.fn().mockResolvedValue(undefined);

    const fromMock = vi.fn((table: string) => {
        const tableQuery = { ...queryBuilder };
        tableQuery.insert = vi.fn((payload: any) => {
            inserts[table] ||= [];
            if (Array.isArray(payload)) {
                inserts[table].push(...payload);
            } else {
                inserts[table].push(payload);
            }
            return {
                select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: { id: `${table}-1` } }),
                })),
            };
        });

        tableQuery.upsert = vi.fn((payload: any) => {
            inserts[table] ||= [];
            if (Array.isArray(payload)) {
                inserts[table].push(...payload);
            } else {
                inserts[table].push(payload);
            }
            return Promise.resolve(undefined);
        });

        return tableQuery;
    });

    return {
        from: fromMock,
    };
}


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

        const supabase = createMockSupabase();

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
        const supabase = createMockSupabase(inserts);

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
        const supabase = createMockSupabase(inserts);

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

        const supabase = createMockSupabase();

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

        const supabase = createMockSupabase();

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

    it("bypasses PO matching, inserts with completed status, and suppresses notifications for AAA Cooper invoices", async () => {
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "AAA-300300",
            poNumber: null,
            vendorName: "AAA Cooper",
            invoiceDate: "2026-03-26",
            lineItems: [{ description: "freight charges", qty: 1, unitPrice: 150, total: 150 }],
            subtotal: 150,
            total: 150,
            amountDue: 150,
            confidence: "high",
        });

        const inserts: Record<string, any[]> = { documents: [], invoices: [] };
        const supabase = createMockSupabase(inserts);

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("AAA Cooper");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "aaa-cooper.pdf",
            "AAA Cooper Invoice",
            "billing@aaacooper.com",
            supabase,
        );

        // 1. Check outcome details: success: true, state: "unmatched" (bypassed), no error
        expect(result).toEqual(expect.objectContaining({
            success: true,
            state: "unmatched",
            matchedPO: false,
            poNumber: null,
        }));

        // 2. PO lookup should NOT have been performed for AAA Cooper
        expect(getOrderDetailsMock).not.toHaveBeenCalled();

        // 3. Document insert should set action_required to false
        const docInsert = inserts.documents[0];
        expect(docInsert).toBeDefined();
        expect(docInsert.action_required).toBe(false);

        // 4. Invoice insert should set status to "completed"
        const invUpsert = inserts.invoices[0];
        expect(invUpsert).toBeDefined();
        expect(invUpsert.status).toBe("completed");

        // 5. Telegram notification must be suppressed
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    // ── Regression: OCR retry tie-breaking ───────────────────────────────────
    // PROBLEM(2026-05-20): When first-pass PDF parse returns 0 line items but
    // knows vendor name + total (score=4), and LLM retry ALSO knows vendor+total
    // AND extracts line items (score=4 but more lines), the old ">" comparison
    // discarded the retry because scores were equal. Grassroots invoice #33790
    // from quickbooks@notification.intuit.com hit this exact case.
    it("accepts LLM OCR retry when it extracts line items even if overall parse score is equal", async () => {
        // First pass: knows vendor + total but 0 line items
        parseInvoiceMock
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "33790",
                poNumber: null,
                vendorName: "Grassroots Fabric Pots",
                invoiceDate: "2026-05-19",
                lineItems: [],          // <-- problem: no line items
                subtotal: 0,
                total: 2489.70,
                amountDue: 2489.70,
                confidence: "medium",  // score = vendorName(+2) + total(+2) + confidence(+1) = 5
            })
            // LLM retry: same vendor + total + line items — score also 5 but more lines
            .mockResolvedValueOnce({
                documentType: "invoice",
                invoiceNumber: "33790",
                poNumber: null,
                vendorName: "Grassroots Fabric Pots",
                invoiceDate: "2026-05-19",
                lineItems: [
                    { description: "30gal Living Soil Pot", qty: 100, unitPrice: 20.00, total: 2000.00 },
                    { description: "Shipping", qty: 1, unitPrice: 489.70, total: 489.70 },
                ],
                subtotal: 2000.00,
                freight: 489.70,
                total: 2489.70,
                amountDue: 2489.70,
                confidence: "medium",  // same score, but retryLines(2) > firstLines(0)
            });

        const inserts: Record<string, any[]> = { ap_activity_log: [], documents: [], invoices: [] };
        const supabase = createMockSupabase(inserts);

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Grassroots Fabric Pots");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "Invoice_33790_from_Grassroots_Fabric_Pots_Inc.pdf",
            "Grassroots Invoice 33790",
            "quickbooks@notification.intuit.com",
            supabase,
        );

        // Retry should have been used — NOT the zero-line-item first pass
        expect(extractPDFWithLLMMock).toHaveBeenCalledTimes(1);

        // With no PO# and no matching PO, result should be unmatched — but NOT
        // skipped_zero_line_items (the critical regression guard).
        expect(result.state).not.toBe("skipped_zero_line_items");
        expect(result.state).toBe("unmatched");

        // The OCR_RETRY log entry should indicate "improved"
        const retryLog = inserts.ap_activity_log.find(
            (r: any) => r.intent === "OCR_RETRY"
        );
        expect(retryLog?.metadata?.retryOutcome).toBe("improved");
    });

    // ── Regression: Grassroots OCR column-collapse — tracking# concatenated with PO# ──
    // ROOT CAUSE(2026-05-20): Grassroots invoices have a header row with columns:
    //   SHIP DATE | SHIP VIA | TRACKING NO. | P.O. NUMBER
    //   05/19/2026 | AAA Copper | 71486681-1 | 124705
    // OCR reads the trailing columns together producing "71486681-1124705" as the
    // PO# field. The Finale probe correctly rejects the full string, but before
    // this fix it also rejected "124705" because it was never extracted as a
    // separate candidate. Now the probe extracts trailing 5–6 digit groups from
    // compound tokens and probes each — so "124705" is correctly resolved.
    it("extracts Finale PO# from OCR column-collapsed tracking+PO compound token", async () => {
        // First pass OCR: extracts collapsed tracking+PO as poNumber
        parseInvoiceMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "33576",
            poNumber: "71486681-1124705",  // OCR collapsed TRACKING NO + P.O. NUMBER columns
            vendorName: "Grassroots Fabric Pots Inc.",
            invoiceDate: "2026-05-19",
            lineItems: [
                { description: "Living Soil Pot 100g", qty: 50, unitPrice: 15.42, total: 771.00 },
                { description: "Living Soil Pot 20g", qty: 50, unitPrice: 6.43, total: 321.50 },
                { description: "4x8 Living Soil Beds", qty: 20, unitPrice: 59.86, total: 1197.20 },
            ],
            subtotal: 2289.70,
            freight: 200.00,
            total: 2489.70,
            amountDue: 2489.70,
            confidence: "high",
        });

        // Finale rejects the full compound token and all naive variants,
        // but ACCEPTS "124705" (the trailing 6-digit segment)
        getOrderDetailsMock.mockImplementation(async (candidate: string) => {
            if (candidate === "124705") return { orderId: "124705" };
            throw new Error("PO not found in Finale");
        });

        const { reconcileInvoiceToPO } = await import("../finale/reconciler");
        vi.mocked(reconcileInvoiceToPO).mockResolvedValueOnce({
            orderId: "124705",
            invoiceNumber: "33576",
            vendorName: "Grassroots Fabric Pots",
            invoiceTotal: 2489.70,
            priceChanges: [],
            feeChanges: [{ feeType: "SHIPPING", amount: 200.00, existingAmount: 0, verdict: "auto_approve", reason: "" }],
            trackingUpdate: null,
            overallVerdict: "auto_approve",
            summary: "Shipping $200 added",
            totalDollarImpact: 200.00,
            autoApplicable: true,
            warnings: [],
        } as any);

        const { applyReconciliation } = await import("../finale/reconciler");
        vi.mocked(applyReconciliation).mockResolvedValueOnce({
            applied: ["SHIPPING: $200.00 added"],
            skipped: [],
            errors: [],
        });

        const inserts: Record<string, any[]> = { ap_activity_log: [], documents: [], invoices: [] };
        const supabase = createMockSupabase(inserts);

        const bot = { telegram: { sendMessage: sendMessageMock } } as any;
        const agent = new APAgent(bot);
        (agent as any).resolveVendorAlias = vi.fn().mockResolvedValue("Grassroots Fabric Pots");
        (agent as any).logActivity = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendNotification = vi.fn().mockResolvedValue(undefined);
        (agent as any).sendReconciliationNotification = vi.fn().mockResolvedValue(undefined);

        const result = await agent.processInvoiceBuffer(
            Buffer.from("pdf"),
            "Invoice_33576_from_Grassroots_Fabric_Pots_Inc.pdf",
            "Grassroots Invoice 33576",
            "quickbooks@notification.intuit.com",
            supabase,
        );

        // Should have extracted "124705" from the compound token and matched PO
        expect(result.matchedPO).toBe(true);
        expect(result.poNumber).toBe("124705");

        // Finale probe must have been called with "124705" specifically
        expect(getOrderDetailsMock).toHaveBeenCalledWith("124705");
    });

});
