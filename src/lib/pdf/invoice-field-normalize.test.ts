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

// ── ALOECORP 3327 (PO 125212) — real invoice that produced a phantom
// "Unexplained -$3960" dashboard row on 2026-08-27 because the LLM
// hallucinated poNumber="C0000275" (customer number), total=0, and
// invoiceDate=today. Deterministic regex must WIN over LLM garbage.
const ALOE_RAW = `Customer No.
Customer PO Number
Sales Person
SHIP TO
1/1
125212
C0000275
08/21/2026
BUILDASOIL
Document Number
3327
ALOECORP
Due Date
09/20/2026
Currency: $
Invoice Subtotal:
 3,960.00 $
Total Amount: 3,960.00 $
`;

const ALOE_LLM_GARBAGE = {
    documentType: "invoice",
    invoiceNumber: null,
    poNumber: "C0000275", // customer NUMBER, not the PO
    vendorName: "ALOECORP",
    invoiceDate: "2026-08-27", // hallucinated "today"
    lineItems: [],
    subtotal: 0,
    total: 0,
    freight: 0,
    tax: 0,
};

const ALOE_LLM_PARTIAL = {
    ...ALOE_LLM_GARBAGE,
    invoiceNumber: "3327", // LLM got the number right this run
};

describe("extractInvoiceFieldsFromOcrText — ALOECORP layout (Document Number, trailing $)", () => {
    it("extracts inv# 3327 from 'Document Number' label", () => {
        const fb = extractInvoiceFieldsFromOcrText(ALOE_RAW);
        expect(fb.invoiceNumber).toBe("3327");
    });

    it("extracts PO 125212 from 'Customer PO Number' label", () => {
        const fb = extractInvoiceFieldsFromOcrText(ALOE_RAW);
        expect(fb.poNumber).toBe("125212");
    });

    it("extracts $3,960 from 'Total Amount: 3,960.00 $' (trailing dollar)", () => {
        const fb = extractInvoiceFieldsFromOcrText(ALOE_RAW);
        expect(fb.total).toBe(3960);
    });

    it("uses 08/21/2026 as invoice date, NOT the Due Date 09/20/2026", () => {
        const fb = extractInvoiceFieldsFromOcrText(ALOE_RAW);
        expect(fb.invoiceDate).toBe("2026-08-21");
    });
});

describe("normalizeInvoiceForDb — regex beats LLM hallucination (PO 125212)", () => {
    it("full-garbage LLM (8/25 failure mode) still yields PO 125212 + $3960 + inv 3327", () => {
        const norm = normalizeInvoiceForDb(ALOE_LLM_GARBAGE, ALOE_RAW, {});
        expect(norm.poNumber).toBe("125212");
        expect(norm.invoiceNumber).toBe("3327");
        expect(norm.total).toBe(3960);
        expect(norm.invoiceDate).toBe("2026-08-21");
    });

    it("partial LLM (8/27 failure mode) — regex corrects PO/date/total, keeps LLM inv#", () => {
        const norm = normalizeInvoiceForDb(ALOE_LLM_PARTIAL, ALOE_RAW, {});
        expect(norm.poNumber).toBe("125212");
        expect(norm.invoiceNumber).toBe("3327");
        expect(norm.total).toBe(3960);
        expect(norm.invoiceDate).toBe("2026-08-21");
    });

    it("computed quality is complete (not failed) once total+number are real", () => {
        const norm = normalizeInvoiceForDb(ALOE_LLM_GARBAGE, ALOE_RAW, {});
        expect(computeExtractionQuality({ total: norm.total, invoiceNumber: norm.invoiceNumber }))
            .toBe("complete");
    });
});

describe("extractInvoiceFieldsFromOcrText — PO# printed on invoice (Bill 2026-08-27)", () => {
    it("extracts PO 125172 from table-header layout (Novelty style: label row, value in row below)", () => {
        // Novelty 41131538: "DateInvoice #Order #Purchase Order #Cust IDTerms"
        // header row, the PO value mid-line in the row below.
        const raw = `INVOICE
DateInvoice #Order #Purchase Order #Cust IDTerms
08/26/26   41131538      475749       125172   BUI001   Net 30 Days
80201          75 EA    ECS CONTAINER GARDEN SYSTEM - GREEN       20.96     1572.00
Subtotal       2,220.56
Shipping       424.24
AMOUNT DUE    2,644.80`;
        const f = extractInvoiceFieldsFromOcrText(raw);
        expect(f.poNumber).toBe("125172");
    });

    it("never captures header words as the invoice number (Invoice #Order jam)", () => {
        const raw = `DateInvoice #Order #Purchase Order #Cust IDTerms
08/26/26   41131538      475749       125172   BUI001`;
        const f = extractInvoiceFieldsFromOcrText(raw);
        expect(f.invoiceNumber).not.toBe("Order");
        if (f.invoiceNumber) expect(f.invoiceNumber).not.toMatch(/^order$/i);
    });

    it("still extracts box-style 'PO Number\\n125184' (Concentrates layout)", () => {
        const f = extractInvoiceFieldsFromOcrText("Customer ID: 10626\nPO Number\n125184");
        expect(f.poNumber).toBe("125184");
    });
});
