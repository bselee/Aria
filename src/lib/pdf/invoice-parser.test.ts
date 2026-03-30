import { beforeEach, describe, expect, it, vi } from "vitest";

const { unifiedObjectGenerationMock } = vi.hoisted(() => ({
    unifiedObjectGenerationMock: vi.fn(),
}));

vi.mock("../intelligence/llm", () => ({
    unifiedObjectGeneration: unifiedObjectGenerationMock,
}));

import { extractPOByRegex, parseInvoice } from "./invoice-parser";

describe("extractPOByRegex", () => {
    it("extracts a PO number from Coats-style table text", () => {
        const tables = [
            [
                "P.O. Number | Terms | Ship",
                "124547 | Net 30 | 3/26/2026",
            ],
        ];

        expect(extractPOByRegex("Invoice text with no direct PO label", tables)).toBe("124547");
    });
});

describe("parseInvoice", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("backfills vendorName from the invoice header when the LLM leaves it unknown", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "INV-100",
            poNumber: "124547",
            vendorName: "UNKNOWN",
            invoiceDate: "2026-03-26",
            lineItems: [
                { description: "Organic Input", qty: 2, unitPrice: 12.5, total: 25 },
            ],
            subtotal: 25,
            total: 25,
            amountDue: 25,
            confidence: "high",
        });

        const invoice = await parseInvoice(
            "Acme Organics LLC\n123 Supply Rd\nDenver, CO 80216\n\nINVOICE\nInvoice #INV-100\nP.O. Number 124547\nTotal 25.00",
        );

        expect(invoice.vendorName).toBe("Acme Organics LLC");
    });

    it("backfills poNumber from regex when the LLM leaves it blank", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: null,
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [
                { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
            ],
            subtotal: 4600,
            total: 4688.72,
            amountDue: 4688.72,
            confidence: "high",
        });

        const invoice = await parseInvoice(
            "P.O. Number 124547\nInvoice #1000930\nTotal 4688.72",
            [["P.O. Number | Terms", "124547 | Net 30"]],
        );

        expect(invoice.poNumber).toBe("124547");
    });

    it("prefers the deterministic numeric PO when OCR returns a garbled candidate", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: "I24547",
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [
                { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
            ],
            subtotal: 4600,
            total: 4688.72,
            amountDue: 4688.72,
            confidence: "high",
        });

        const invoice = await parseInvoice(
            "P.O. Number 124547\nInvoice #1000930\nTotal 4688.72",
            [["P.O. Number | Terms", "124547 | Net 30"]],
        );

        expect(invoice.poNumber).toBe("124547");
    });

    it("moves shipping and handling line items into freight so product pricing can reconcile cleanly", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: "124547",
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            lineItems: [
                { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
                { description: "Shipping and Handling", qty: 1, unitPrice: 88.72, total: 88.72 },
            ],
            subtotal: 4688.72,
            total: 4688.72,
            amountDue: 4688.72,
            confidence: "high",
        });

        const invoice = await parseInvoice(
            "P.O. Number 124547\nShipping and Handling 88.72\nTotal 4688.72",
            [["Description | Amount", "Shipping and Handling | 88.72"]],
        );

        expect(invoice.freight).toBe(88.72);
        expect(invoice.lineItems).toHaveLength(1);
        expect(invoice.lineItems[0].description).toContain("GroAloe");
    });

    it("does not double-count freight when freight is already present on the parsed invoice", async () => {
        unifiedObjectGenerationMock.mockResolvedValue({
            documentType: "invoice",
            invoiceNumber: "1000930",
            poNumber: "124547",
            vendorName: "Coats Agri Aloe, Inc.",
            invoiceDate: "2026-03-26",
            freight: 88.72,
            lineItems: [
                { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
                { description: "Shipping and Handling", qty: 1, unitPrice: 88.72, total: 88.72 },
            ],
            subtotal: 4688.72,
            total: 4688.72,
            amountDue: 4688.72,
            confidence: "high",
        });

        const invoice = await parseInvoice(
            "Coats Agri Aloe, Inc.\nP.O. Number 124547\nShipping and Handling 88.72\nShipping and Handling          88.72\nTotal 4688.72",
            [["P.O. Number | Terms", "124547 | Net 30"]],
        );

        expect(invoice.freight).toBe(88.72);
        expect(invoice.lineItems).toHaveLength(1);
        expect(invoice.lineItems[0].description).toContain("GroAloe");
    });
});
