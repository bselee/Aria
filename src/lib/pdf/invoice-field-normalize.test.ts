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
    // Real OCR text from ap@ forwards row 1141 (Evergreen invoice 151185).
    // The PO is printed as a bare 8-digit sales-order base in a combined
    // "Approval CodeP.O. NO." header block. The 6-digit-only pattern matched
    // nothing, so vendor/PO came back null on 125 dropship forwards.
    const EVERGREEN_DROPSHIP_OCR = `Invoice
Date
10/27/2026
Invoice #
151185
Bill To:
BuildASoil LLC
5016 N Townsend Ave
Montrose, CO 81401
Ship To:
Tyler Cooper
2267 SPLIT ROCK DR
COLORADO SPGS, CO 80919-3077 USA
Evergreen Growers Supply, LLC.
Approval CodeP.O. NO.
23580437
Terms
Net 30
Due Date
11/26/2026
Shipping-FedExS/H - FedEx Tracking #5204849091041ea56.7756.77
InsulationInsulation for hot or cold weather1ea7.007.00
Total
$152.77`;

    it("extracts a bare 8-digit dropship PO base (Evergreen 151185)", () => {
        const f = extractInvoiceFieldsFromOcrText(EVERGREEN_DROPSHIP_OCR);
        expect(f.poNumber).toBe("23580437");
        expect(f.invoiceNumber).toBe("151185");
        expect(f.total).toBe(152.77);
        expect(f.invoiceDate).toBe("2026-10-27");
    });

    it("still prefers a standard 6-digit PO over an 8-digit base", () => {
        const both = `P.O. NUMBER\n125257\nSales Order\n23580437\nTotal\n$10.00`;
        expect(extractInvoiceFieldsFromOcrText(both).poNumber).toBe("125257");
    });

    it("does not truncate a longer digit run into a fake PO", () => {
        // 9-digit run must not yield the first 8 as a PO.
        const long = `P.O. NO.\n235804371\nTotal\n$10.00`;
        expect(extractInvoiceFieldsFromOcrText(long).poNumber).toBeNull();
    });

    it("extracts freight from the real Evergreen 151185 layout", () => {
        const f = extractInvoiceFieldsFromOcrText(EVERGREEN_DROPSHIP_OCR);
        expect(f.freight).toBe(56.77);
    });

    it("takes freight, not the insulation amount, when OCR glues them on one line", () => {
        // aria-purchasing: last-plausible would return 7.00 (insulation).
        const glued = [
            "P.O. NO.",
            "23580437",
            "Shipping-FedExS/H - FedEx Tracking #5204849091041ea56.7756.77Insulation1ea7.007.00",
            "Total",
            "$152.77",
        ].join("\n");
        expect(extractInvoiceFieldsFromOcrText(glued).freight).toBe(56.77);
    });

    it("refuses freight when the tracking number bleeds into the amount", () => {
        // "…9104156.777.00" — 56.77 is not recoverable, so null beats a guess.
        const bleed = [
            "P.O. NO.",
            "23580437",
            "Shipping-FedExS/H - FedEx Tracking #520484909104156.777.00",
            "Total",
            "$152.77",
        ].join("\n");
        expect(extractInvoiceFieldsFromOcrText(bleed).freight).toBeNull();
    });

    it("wires OCR freight into normalizeInvoiceForDb and derives subtotal", () => {
        const n = normalizeInvoiceForDb(null, EVERGREEN_DROPSHIP_OCR, {});
        expect(n.freight).toBe(56.77);
        expect(n.total).toBe(152.77);
        // 152.77 - 56.77 freight - 0 tax = 96.00 (goods 89.00 + 7.00 insulation)
        expect(n.subtotal).toBe(96);
    });

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
