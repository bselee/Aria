/**
 * @file    uline-invoice-repair.test.ts
 * @purpose Pins the Uline identity repair against the real 215047605 /
 *          214717726 / 214242092 OCR text shapes (2026-10-29).
 * @author  Hermia
 * @created 2026-10-29
 */
import { describe, expect, it } from "vitest";
import {
    ULINE_CUSTOMER_NO,
    exactSkuOverlap,
    isUlineVendorName,
    normalizeSkuKey,
    productIdsFromPoLines,
    skusFromInvoiceLines,
    ulineInvoiceNumber,
    ulinePoFromRaw,
} from "./uline-invoice-repair";

// Real Uline OCR layout: header jam, receipt machine line, payee block.
// Trimming to the lines the parser actually keys on keeps the fixture
// readable; the digit runs are verbatim from ap_local_forwards.ocr_raw_text.
const RAW_215047605 = `CUSTOMER NO.PURCHASE ORDER NO.SHIP VIAORDER DATEDATE SHIPPEDTERMSINVOICE DATE
9897269125429FEDEX FRT C10/22/2610/22/26
NET 30 DAYS
ULINE FED ID#: 36-3684738
INVOICE #: 215047605
ORDER #: 59853790
INVOICE
0989726902150476052610220002995757
CUSTOMER NAME
INVOICE NUMBERINVOICE DATEAMOUNT DUE
BUILDASOIL LLC989726921504760510/22/262,995.75
SUB-TOTAL
2,861.20`;

const RAW_214717726 = `CUSTOMER NO.PURCHASE ORDER NO.SHIP VIAORDER DATEDATE SHIPPEDTERMSINVOICE DATE
9897269125410FEDEX FRT C10/15/2610/15/26
ULINE FED ID#: 36-3684738
INVOICE #: 214717726
ORDER #: 59442933
INVOICE
0989726902147177262610150001649745
BUILDASOIL LLC989726921471772610/15/261,649.74`;

const RAW_214242092 = `CUSTOMER NO.PURCHASE ORDER NO.SHIP VIAORDER DATEDATE SHIPPEDTERMSINVOICE DATE
9897269125381UPS GROUND10/05/2610/05/26
ULINE FED ID#: 36-3684738
INVOICE #: 214242092
ORDER #: 61203368
INVOICE
0989726902142420922610050000826602
BUILDASOIL LLC989726921424209210/05/26826.60`;

describe("ulinePoFromRaw", () => {
    it("strips the customer number to recover the Finale PO (real rows)", () => {
        expect(ulinePoFromRaw(RAW_215047605)).toBe("125429");
        expect(ulinePoFromRaw(RAW_214717726)).toBe("125410");
        expect(ulinePoFromRaw(RAW_214242092)).toBe("125381");
    });

    it("never falls back to a non-12xxxx remainder (invoice number jam)", () => {
        // `BUILDASOIL LLC9897269215047605...` would give "215047" under a
        // naive strip; that must not become a PO.
        expect(ulinePoFromRaw("BUILDASOIL LLC989726921504760510/22/26")).toBeNull();
        expect(ulinePoFromRaw("0989726902150476052610220002995757")).toBeNull();
    });

    it("honours a caller-supplied customer number and rejects empty input", () => {
        expect(ulinePoFromRaw("CUST123456789125429", "123456789")).toBe("125429");
        expect(ulinePoFromRaw("")).toBeNull();
        expect(ulinePoFromRaw(null)).toBeNull();
        expect(ulinePoFromRaw(RAW_215047605, "")).toBeNull();
    });

    it("defaults to the confirmed BAS Uline account", () => {
        expect(ULINE_CUSTOMER_NO).toBe("9897269");
    });
});

describe("ulineInvoiceNumber", () => {
    it("reads the labeled INVOICE # from raw text", () => {
        expect(ulineInvoiceNumber(RAW_215047605)).toBe("215047605");
        expect(ulineInvoiceNumber(RAW_214717726)).toBe("214717726");
        expect(ulineInvoiceNumber(RAW_214242092)).toBe("214242092");
    });

    it("falls back to the attachment filename", () => {
        expect(ulineInvoiceNumber("", "Uline_Invoice_215047605_216827642_1.pdf")).toBe("215047605");
        expect(
            ulineInvoiceNumber("no label here", "apfwd:1a1678a4350465b2:Uline_Invoice_214717726_216199386_1.pdf"),
        ).toBe("214717726");
    });

    it("returns null when neither side names a number", () => {
        expect(ulineInvoiceNumber("", "US Payment information PDF_20261001184812433439.pdf")).toBeNull();
        expect(ulineInvoiceNumber(null, null)).toBeNull();
    });
});

describe("isUlineVendorName", () => {
    it("matches every OCR/Finale spelling", () => {
        expect(isUlineVendorName("ULINE")).toBe(true);
        expect(isUlineVendorName("Uline")).toBe(true);
        expect(isUlineVendorName("Uline, Inc.")).toBe(true);
        expect(isUlineVendorName("UNKNOWN | Uline")).toBe(true);
    });
    it("does not match other vendors", () => {
        expect(isUlineVendorName("Rootwise Soil Dynamics")).toBe(false);
        expect(isUlineVendorName("QTY")).toBe(false);
        expect(isUlineVendorName(null)).toBe(false);
    });
});

describe("exactSkuOverlap", () => {
    it("matches S-17888 and keeps S-4738 / S-473824 apart (exact only)", () => {
        const invoiceSkus = ["S-17888", "S-473824"];
        const poProductIds = ["S-4738", "S-17888"];
        expect(exactSkuOverlap(invoiceSkus, poProductIds)).toEqual(["S-17888"]);
    });

    it("is case/whitespace tolerant but not substring tolerant", () => {
        expect(exactSkuOverlap([" s-17888 "], ["S-17888"])).toEqual(["S-17888"]);
        expect(exactSkuOverlap(["S-473"], ["S-4738"])).toEqual([]);
        expect(exactSkuOverlap(["S-473824"], ["S-4738"])).toEqual([]);
    });

    it("returns [] on empty sides", () => {
        expect(exactSkuOverlap([], ["S-1"])).toEqual([]);
        expect(exactSkuOverlap(["S-1"], [])).toEqual([]);
    });
});

describe("line-item readers", () => {
    it("pulls Uline SKUs from OCR line items", () => {
        expect(
            skusFromInvoiceLines([
                { sku: "S-17888" },
                { sku: "S-473824" },
                { sku: "s-17888" },
                { sku: null },
            ]),
        ).toEqual(["S-17888", "S-473824"]);
    });

    it("pulls productIds from Finale PO line items (array or JSON string)", () => {
        const lines = [
            { productId: "S-4738", quantity: "1000", unitPrice: 2.43 },
            { productId: "S-17888", quantity: "14", unitPrice: 30.8 },
        ];
        expect(productIdsFromPoLines(lines)).toEqual(["S-4738", "S-17888"]);
        expect(productIdsFromPoLines(JSON.stringify(lines))).toEqual(["S-4738", "S-17888"]);
        expect(productIdsFromPoLines(null)).toEqual([]);
        expect(productIdsFromPoLines("{not json")).toEqual([]);
    });

    it("normalizeSkuKey rejects fragments too short to be a SKU", () => {
        expect(normalizeSkuKey("S")).toBeNull();
        expect(normalizeSkuKey("")).toBeNull();
        expect(normalizeSkuKey(" h-6054 ")).toBe("H-6054");
    });
});
