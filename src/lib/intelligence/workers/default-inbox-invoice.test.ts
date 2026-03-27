import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    getOrderSummaryMock,
    getOrderDetailsMock,
    updateOrderItemPriceMock,
    addOrderAdjustmentMock,
    upsertVendorInvoiceMock,
    anthropicCreateMock,
    findRelevantPatternsMock,
    storeVendorPatternMock,
    gmailModifyMock,
    gmailLabelsListMock,
    gmailLabelsCreateMock,
    recordDefaultInboxInvoiceOutcomeMock,
    vendorInvoiceRows,
} = vi.hoisted(() => ({
    getOrderSummaryMock: vi.fn(),
    getOrderDetailsMock: vi.fn(),
    updateOrderItemPriceMock: vi.fn(),
    addOrderAdjustmentMock: vi.fn(),
    upsertVendorInvoiceMock: vi.fn(),
    anthropicCreateMock: vi.fn(),
    findRelevantPatternsMock: vi.fn(),
    storeVendorPatternMock: vi.fn(),
    gmailModifyMock: vi.fn(),
    gmailLabelsListMock: vi.fn(),
    gmailLabelsCreateMock: vi.fn(),
    recordDefaultInboxInvoiceOutcomeMock: vi.fn(),
    vendorInvoiceRows: [] as Array<Record<string, any>>,
}));

vi.mock("../../finale/client", () => ({
    FinaleClient: class {
        getOrderSummary = getOrderSummaryMock;
        getOrderDetails = getOrderDetailsMock;
        updateOrderItemPrice = updateOrderItemPriceMock;
        addOrderAdjustment = addOrderAdjustmentMock;
    },
}));

vi.mock("../../storage/vendor-invoices", () => ({
    upsertVendorInvoice: upsertVendorInvoiceMock,
}));

vi.mock("../../anthropic", () => ({
    getAnthropicClient: vi.fn(() => ({
        messages: {
            create: anthropicCreateMock,
        },
    })),
}));

vi.mock("../../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table !== "vendor_invoices") {
                throw new Error(`Unexpected table ${table}`);
            }

            return {
                select: () => ({
                    eq: () => ({
                        eq: () => ({
                            limit: async () => ({ data: vendorInvoiceRows, error: null }),
                        }),
                    }),
                }),
            };
        },
    })),
}));

vi.mock("../vendor-memory", () => ({
    findRelevantPatterns: findRelevantPatternsMock,
    storeVendorPattern: storeVendorPatternMock,
}));

vi.mock("../email-feedback", () => ({
    recordDefaultInboxInvoiceOutcome: recordDefaultInboxInvoiceOutcomeMock,
}));

vi.mock("../../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            labels: {
                list: gmailLabelsListMock,
                create: gmailLabelsCreateMock,
            },
            messages: {
                modify: gmailModifyMock,
            },
        },
    })),
}));

import { processDefaultInboxInvoice } from "./default-inbox-invoice";

describe("processDefaultInboxInvoice", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vendorInvoiceRows.length = 0;

        getOrderSummaryMock.mockResolvedValue({ orderId: "124541", total: 100, status: "Draft" });
        getOrderDetailsMock.mockResolvedValue({
            orderItemList: [{ productId: "ULS455", quantity: 10, unitPrice: 9 }],
        });
        updateOrderItemPriceMock.mockResolvedValue(undefined);
        addOrderAdjustmentMock.mockResolvedValue(undefined);
        upsertVendorInvoiceMock.mockResolvedValue(undefined);
        anthropicCreateMock.mockResolvedValue({
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        vendorName: "ULINE",
                        invoiceNumber: "1771-1481",
                        invoiceDate: "2026-03-24",
                        total: 120,
                        freight: 20,
                        tax: 0,
                        subtotal: 100,
                        priceStrategy: "per_item",
                        lineItems: [
                            {
                                description: "30 x 15 x 15 corrugated boxes",
                                invoicedQty: 10,
                                invoicedUnitPrice: 10,
                                finaleSku: "ULS455",
                                finalePricePerUnit: 10,
                                total: 100,
                            },
                        ],
                        confidence: "high",
                        vendorLearning: "Invoices show per-item pricing and separate freight.",
                    }),
                },
            ],
        });
        findRelevantPatternsMock.mockResolvedValue([]);
        storeVendorPatternMock.mockResolvedValue(undefined);
        gmailLabelsListMock.mockResolvedValue({ data: { labels: [] } });
        gmailLabelsCreateMock.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
            data: { id: `${requestBody.name.toLowerCase()}-id` },
        }));
        gmailModifyMock.mockResolvedValue({ data: {} });
        recordDefaultInboxInvoiceOutcomeMock.mockResolvedValue(undefined);
    });

    it("marks a reconciled paid invoice as read and adds the invoice label", async () => {
        const result = await processDefaultInboxInvoice(
            "gmail-1",
            "orders@uline.com",
            "PO #124541 paid invoice",
            "PO #124541\nTotal $120.00\nFreight $20.00",
        );

        expect(result.outcome).toBe("reconciled");
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-1",
            requestBody: {
                addLabelIds: ["invoices-id"],
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
        expect(recordDefaultInboxInvoiceOutcomeMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-1",
            fromEmail: "orders@uline.com",
            subject: "PO #124541 paid invoice",
            outcome: "reconciled",
            vendorName: "ULINE",
            poNumber: "124541",
            total: 120,
            priceUpdates: 1,
        });
    });

    it("leaves unresolved paid invoices visible for human review", async () => {
        const result = await processDefaultInboxInvoice(
            "gmail-2",
            "orders@uline.com",
            "Paid invoice without PO reference",
            "Total $120.00\nFreight $20.00",
        );

        expect(result.outcome).toBe("no_po_number");
        expect(gmailModifyMock).not.toHaveBeenCalled();
        expect(recordDefaultInboxInvoiceOutcomeMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-2",
            fromEmail: "orders@uline.com",
            subject: "Paid invoice without PO reference",
            outcome: "no_po_number",
            vendorName: "Unknown Vendor",
            poNumber: null,
            total: 0,
            priceUpdates: 0,
        });
    });

    it("still closes duplicate-safe invoices into the invoice label", async () => {
        vendorInvoiceRows.push({ id: "existing-1", po_number: "124541" });

        const result = await processDefaultInboxInvoice(
            "gmail-3",
            "orders@uline.com",
            "PO #124541 duplicate paid invoice",
            "PO #124541\nTotal $120.00\nFreight $20.00",
        );

        expect(result.outcome).toBe("already_processed");
        expect(gmailModifyMock).toHaveBeenCalledWith({
            userId: "me",
            id: "gmail-3",
            requestBody: {
                addLabelIds: ["invoices-id"],
                removeLabelIds: ["INBOX", "UNREAD"],
            },
        });
        expect(recordDefaultInboxInvoiceOutcomeMock).toHaveBeenCalledWith({
            gmailMessageId: "gmail-3",
            fromEmail: "orders@uline.com",
            subject: "PO #124541 duplicate paid invoice",
            outcome: "already_processed",
            vendorName: "ULINE",
            poNumber: "124541",
            total: 120,
            priceUpdates: 0,
        });
    });
});
