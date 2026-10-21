import { describe, expect, it } from "vitest";
import { invoiceMatchesPoLines, parseVendorInvoiceText } from "./no-freight-invoice-text";

describe("parseVendorInvoiceText", () => {
    it("reads a Stock Bag invoice, including shipping that is not a carrier bill", () => {
        const text = "Customer PO No.Payment Terms PO 125260PBS-CARD Sales Amount$252.00 Total Invoice Amount$284.08 Shipping Amount$32.08 INVOICE 112119";
        const parsed = parseVendorInvoiceText(text);
        expect(parsed.poNumber).toBe("125260");
        expect(parsed.invoiceNumber).toBe("112119");
        expect(parsed.subtotal).toBe(252);
        expect(parsed.freight).toBe(32.08);
        expect(parsed.total).toBe(284.08);
    });

    it("reads a Miles delivery invoice with no PO number", () => {
        const text = "Invoice ID9,232,026 SUBTOTAL$2,310.00 TAX$0.00 Total Amount Due$2,310.00 pumpkin gallon42.00$24.00$1,008.00";
        const parsed = parseVendorInvoiceText(text);
        expect(parsed.poNumber).toBeNull();
        expect(parsed.invoiceNumber).toBe("9232026");
        expect(parsed.subtotal).toBe(2310);
        expect(parsed.freight).toBe(0);
        expect(parsed.lineTotals).toContain(1008);
    });

    it("reads a New Moon invoice that spells P.O. Number", () => {
        const text = "P.O. Number: 124908 Earthbox Cover 250$31.50$7,875.00 Subtotal$7,875.00 Total$7,875.00";
        const parsed = parseVendorInvoiceText(text);
        expect(parsed.poNumber).toBe("124908");
        expect(parsed.subtotal).toBe(7875);
        expect(parsed.freight).toBe(0);
    });
    it("reads a Colorado Worm packing list", () => {
        const text = "PACKING SLIP ORDER DATE 125279 JOB DESCRIPTION TOTAL: $3,000.00";
        const parsed = parseVendorInvoiceText(text);
        expect(parsed.poNumber).toBe("125279");
        expect(parsed.subtotal).toBe(3000);
        expect(parsed.total).toBe(3000);
    });
});

describe("invoiceMatchesPoLines", () => {
    const lines = [390, 1008, 672, 260, 130, 240];

    it("accepts a partial delivery dated after the PO", () => {
        expect(invoiceMatchesPoLines(2310, lines, "2026-09-23", "2026-09-21")).toBe(true);
    });

    it("rejects an invoice dated before the PO", () => {
        expect(invoiceMatchesPoLines(260, lines, "2026-09-17", "2026-09-21")).toBe(false);
    });

    it("rejects a total that is not a subset of the lines", () => {
        expect(invoiceMatchesPoLines(1480, lines, "2026-09-23", "2026-09-21")).toBe(false);
    });
});
