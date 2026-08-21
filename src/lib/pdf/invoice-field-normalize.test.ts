/**
 * @file    invoice-field-normalize.test.ts
 * @purpose Tests for invoice field sanitization + OCR regex fallbacks
 */
import { describe, it, expect } from "vitest";
import {
    cleanInvoiceField,
    computeExtractionQuality,
    extractInvoiceFieldsFromOcrText,
    isInvoiceLikeNumber,
    normalizeInvoiceForDb,
} from "./invoice-field-normalize";

const DTE_OCR = `DOWN TO EARTH WORMS, LLC.
GARY L. & LUANN AMBRIOLE
Invoice
DATE
INVOICE #
4/24/2026
1682
BILL TO:
Build A Soil
P.O. NUMBER
#124661
Net 30
QUANTITY
ITEM CODE
21 Bulk
Ton bulk castings
375.00
7,875.00
Total
$7,875.00
`;

describe("cleanInvoiceField", () => {
    it("nulls UNKNOWN sentinels", () => {
        expect(cleanInvoiceField("UNKNOWN")).toBeNull();
        expect(cleanInvoiceField("unknown")).toBeNull();
        expect(cleanInvoiceField("n/a")).toBeNull();
        expect(cleanInvoiceField("1682")).toBe("1682");
    });
});

describe("extractInvoiceFieldsFromOcrText", () => {
    it("pulls inv# PO total date from DTE photo OCR", () => {
        const f = extractInvoiceFieldsFromOcrText(DTE_OCR);
        expect(f.invoiceNumber).toBe("1682");
        expect(f.poNumber).toMatch(/124661/);
        expect(f.total).toBe(7875);
        expect(f.invoiceDate).toBe("2026-04-24");
        expect(f.vendorHint).toBe("Down to Earth Worms");
    });
});

describe("normalizeInvoiceForDb", () => {
    it("replaces UNKNOWN parse with regex", () => {
        const n = normalizeInvoiceForDb(
            { invoiceNumber: "UNKNOWN", vendorName: "UNKNOWN", total: 0 } as any,
            DTE_OCR,
        );
        expect(n.invoiceNumber).toBe("1682");
        expect(n.vendorName).toBe("Down to Earth Worms");
        expect(n.total).toBe(7875);
        expect(n.poNumber).toMatch(/124661/);
    });

    it("nulls truncated/garbage invoice numbers (oice, Reminder, From)", () => {
        // Regression: QuickBooks reminder subjects and truncated "Invoice"
        // tokens were stored as invoice_number="oice" / "Reminder" / "From".
        for (const garbage of ["oice", "Reminder", "From", "Invoice", "INVOICE", "Statement", "Attachments"]) {
            const n = normalizeInvoiceForDb(
                { invoiceNumber: garbage, vendorName: "X", total: 0 } as any,
                "",
            );
            expect(n.invoiceNumber).toBeNull();
        }
    });

    it("keeps real invoice numbers", () => {
        for (const good of ["1682", "APUS-244677", "S4O551", "928882", "MA-P-M2162", "Invoice124424", "P26071301-3105413"]) {
            const n = normalizeInvoiceForDb(
                { invoiceNumber: good, vendorName: "X", total: 100 } as any,
                "",
            );
            expect(n.invoiceNumber).toBe(good);
        }
    });
});

describe("isInvoiceLikeNumber", () => {
    it("rejects pure-alpha subject tokens", () => {
        expect(isInvoiceLikeNumber("oice")).toBe(false);
        expect(isInvoiceLikeNumber("Reminder")).toBe(false);
        expect(isInvoiceLikeNumber("From")).toBe(false);
        expect(isInvoiceLikeNumber("Invoice")).toBe(false);
        expect(isInvoiceLikeNumber("INVOICE")).toBe(false);
        expect(isInvoiceLikeNumber("Statement")).toBe(false);
        expect(isInvoiceLikeNumber("Attachments")).toBe(false);
        expect(isInvoiceLikeNumber("UNKNOWN")).toBe(false);
        expect(isInvoiceLikeNumber(null)).toBe(false);
        expect(isInvoiceLikeNumber(undefined)).toBe(false);
    });

    it("accepts digit-bearing and vendor-format numbers", () => {
        expect(isInvoiceLikeNumber("1682")).toBe(true);
        expect(isInvoiceLikeNumber("APUS-244677")).toBe(true);
        expect(isInvoiceLikeNumber("S4O551")).toBe(true);
        expect(isInvoiceLikeNumber("928882")).toBe(true);
        expect(isInvoiceLikeNumber("MA-P-M2162")).toBe(true);
        expect(isInvoiceLikeNumber("Invoice124424")).toBe(true);
        expect(isInvoiceLikeNumber("P26071301-3105413")).toBe(true);
    });
});

describe("computeExtractionQuality", () => {
    it("failed when total=0 and number missing/garbage", () => {
        expect(computeExtractionQuality({ total: 0, invoiceNumber: null })).toBe("failed");
        expect(computeExtractionQuality({ total: 0, invoiceNumber: "oice" })).toBe("failed");
        expect(computeExtractionQuality({ total: 0, invoiceNumber: "Reminder" })).toBe("failed");
    });

    it("complete when total>0 and invoice-like number", () => {
        expect(computeExtractionQuality({ total: 1250.5, invoiceNumber: "1682" })).toBe("complete");
        expect(computeExtractionQuality({ total: 139.32, invoiceNumber: "APUS-244677" })).toBe("complete");
    });

    it("partial for in-between cases", () => {
        expect(computeExtractionQuality({ total: 0, invoiceNumber: "1682" })).toBe("partial");
        expect(computeExtractionQuality({ total: 1250.5, invoiceNumber: null })).toBe("partial");
    });
});
