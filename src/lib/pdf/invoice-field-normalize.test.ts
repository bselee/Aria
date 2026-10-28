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

    it("nulls parse-failure sentinels so fallbacks get their chance (2026-10-28)", () => {
        expect(cleanInvoiceField("error")).toBeNull();
        expect(cleanInvoiceField("ERROR")).toBeNull();
        expect(cleanInvoiceField("failed")).toBeNull();
        expect(cleanInvoiceField("parse error")).toBeNull();
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

    it("reads the Miles 'Invoice ID' label with thousands comma (2026-10-28)", () => {
        const MILES_OCR = `INVOICE\nInvoice For: BuildASoil\n\nFrom:\nInvoice ID Issue Date Terms\n\nMiles Filippelli Fermented Plant Extracts\n10,272,026 10.27.2026 Due Upon Delivery\n\nDESCRIPTION Comfrey Gallon Pumpkin Gallon\nQUANTITY 26.00 56.00\nUNIT PRICE $24.00 $24.00\nAMOUNT $624.00 $1,344.00\nTOTAL\n$2,688.00`;
        const f = extractInvoiceFieldsFromOcrText(MILES_OCR);
        expect(f.invoiceNumber).toBe("10,272,026");
        expect(f.total).toBe(2688);
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
        expect(n.lineItems).toEqual([
            expect.objectContaining({ qty: 21, unit_price: 375, ext_price: 7875 }),
        ]);
    });

    it("keeps the text-layer lines when the model parse dropped them", () => {
        const n = normalizeInvoiceForDb(
            { invoiceNumber: "1682", vendorName: "Down to Earth Worms", total: 7875, lineItems: [] } as any,
            DTE_OCR,
        );
        expect(n.lineItems[0]).toEqual(expect.objectContaining({ qty: 21, unit_price: 375, ext_price: 7875 }));
    });
});
