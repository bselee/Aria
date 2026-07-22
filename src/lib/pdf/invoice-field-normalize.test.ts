/**
 * @file    invoice-field-normalize.test.ts
 * @purpose Tests for invoice field sanitization + OCR regex fallbacks
 */
import { describe, it, expect } from "vitest";
import {
    cleanInvoiceField,
    extractInvoiceFieldsFromOcrText,
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
});
