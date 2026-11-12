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

    it("rejects a PO candidate on a shipment-context line (ADV ORDER)", () => {
        expect(extractPOByRegex("ADV ORDER # 124547\nTotal $100.00")).toBeNull();
    });

    it("rejects a generic-label candidate whose line above is shipment-context", () => {
        expect(extractPOByRegex("PRO NUMBER 64058931\nYour Order No. 124547")).toBeNull();
    });

    it("keeps an explicit PO label even when a shipment line sits above it", () => {
        expect(extractPOByRegex("PRO NUMBER 64058931\nP.O. NUMBER 125213")).toBe("125213");
        expect(extractPOByRegex("B.L.NUMBER 18700362\nP.O. NUMBER 125213")).toBe("125213");
    });

    it("does not treat address tokens (SOLD TO / SOUTH BEND) as SO# shipment context", () => {
        expect(extractPOByRegex("SOLD TO\nP.O. NUMBER 125213")).toBe("125213");
        expect(extractPOByRegex("SOUTH BEND, IN 46601\nP.O. NUMBER 125213")).toBe("125213");
    });

    it("keeps the header-row PO when INVOICE DATE is a column header", () => {
        expect(extractPOByRegex("P.O. NUMBER   INVOICE DATE   TERMS\n125213   10/15/26   NET 30")).toBe("125213");
    });

    it("keeps goods-vendor PO labels (Your Order No. / Customer Ref)", () => {
        expect(extractPOByRegex("Your Order No. 124547\nTotal $50.00")).toBe("124547");
        expect(extractPOByRegex("Customer Ref 124547\nTotal $50.00")).toBe("124547");
    });

    it("keeps explicit PO labels (P.O. NUMBER / Purchase Order #)", () => {
        expect(extractPOByRegex("P.O. NUMBER 125213")).toBe("125213");
        expect(extractPOByRegex("Purchase Order # 125376")).toBe("125376");
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

describe("header-row layout where the value cell repeats the PO label", () => {
    // Stock Bag Depot (Soestern Packaging) invoice 112690 — PO 125492 printed
    // in a header cell, and pdf-parse glues the neighbouring columns onto the
    // value with no space:
    //   "Customer PO No.Payment TermsShip ViaShipping TermsOrder No."
    //   "PO 125492PBS-CARDFEDEX-GNDCIP113742"
    // The extractor returned null here and the link was made by hand.
    const REAL_GLUED = [
        "Customer PO No.Payment TermsShip ViaShipping TermsOrder No.",
        "PO 125492PBS-CARDFEDEX-GNDCIP113742",
    ].join("\n");

    it("extracts the printed PO from the glued header/value layout", () => {
        expect(extractPOByRegex(REAL_GLUED)).toBe("125492");
    });

    it("refuses the vendor's Order No. in the last column", () => {
        // 113742 is Stock Bag Depot's own order number, printed to the right of
        // the PO. Grabbing it would match a PO that has nothing to do with this
        // invoice — the exact failure that once turned a carrier statement's
        // customer order into a PO.
        const got = extractPOByRegex(REAL_GLUED);
        expect(got).not.toBe("113742");
        expect(got).toBe("125492");
    });

    it("still refuses the P.O. Box address trap", () => {
        for (const s of ["PO Box 4808", "P.O. Box 4808", "PO Box 4808 Montrose CO 81401"]) {
            expect(extractPOByRegex(s)).toBeNull();
        }
    });

    it("keeps extracting when the value cell is bare digits (no regression)", () => {
        expect(extractPOByRegex("P.O. NUMBER   INVOICE DATE   TERMS\n125213   10/15/26   NET 30")).toBe("125213");
    });

    it("a trailing-word-boundary pattern would NOT have worked — keep the anchor", () => {
        // Documents why the fix is anchored rather than \bPO\s+(\d{4,})\b:
        // the glued `125492PBS` has no word boundary after the digits.
        expect("PO 125492PBS-CARDFEDEX-GNDCIP113742".match(/\bPO\s+(\d{4,})\b/)).toBeNull();
        expect("PO 125492PBS-CARDFEDEX-GNDCIP113742".match(/^(?:PO\s+)?(\d{4,})/i)?.[1]).toBe("125492");
    });
});
