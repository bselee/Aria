/**
 * @file    invoice-pool.test.ts
 * @purpose Unit pins for the phantom-row guards (PO 125411 class).
 * @author  Hermia
 * @created 2026-10-27
 */
import { describe, expect, it } from "vitest";
import {
    isJunkVendorName,
    isJunkInvoiceNumber,
    isPhantomInvoiceRow,
    isCarrierFreightArchive,
    invoiceNumberFromAttachment,
    isJunkInvoiceLabel,
    firstRealInvoice,
} from "./invoice-pool";

describe("isJunkVendorName", () => {
    it("flags ingest-failure vendor markers", () => {
        expect(isJunkVendorName("error")).toBe(true);
        expect(isJunkVendorName("ERROR")).toBe(true);
        expect(isJunkVendorName("PACKING SLIP")).toBe(true);
        expect(isJunkVendorName("PackiNG  list")).toBe(true);
        expect(isJunkVendorName("")).toBe(true);
    });
    it("keeps real vendor names — and null is unknown, not junk", () => {
        expect(isJunkVendorName("Colorado Worm Company")).toBe(false);
        expect(isJunkVendorName("Rootwise Soil Dynamics")).toBe(false);
        expect(isJunkVendorName(null)).toBe(false); // unknown ≠ junk (2026-10-27 regression)
        expect(isJunkVendorName(undefined)).toBe(false);
    });
});

describe("isJunkInvoiceNumber", () => {
    it("flags failure markers only", () => {
        expect(isJunkInvoiceNumber("error")).toBe(true);
        expect(isJunkInvoiceNumber("unknown")).toBe(true);
        expect(isJunkInvoiceNumber("9488427")).toBe(false);
    });
    it("empty is not junk — a photo invoice with an unreadable number is real; its vendor decides", () => {
        expect(isJunkInvoiceNumber("")).toBe(false);
        expect(isJunkInvoiceNumber(null)).toBe(false);
    });
});

describe("isPhantomInvoiceRow", () => {
    it("flags the PO 125411 packing-list rows", () => {
        expect(isPhantomInvoiceRow({ vendor_name: "error", invoice_number: "error" })).toBe(true);
        expect(isPhantomInvoiceRow({ vendor_name: "PACKING SLIP", invoice_number: "" })).toBe(true);
    });
    it("keeps real invoice rows — including null vendor with a real invoice number", () => {
        expect(isPhantomInvoiceRow({ vendor_name: "Colorado Worm Company", invoice_number: "9488427" })).toBe(false);
        // The enrichment query omits vendor_name — a real invoice number must
        // survive (2026-10-27 regression: this row was rejected, blanking the
        // whole Receivings panel).
        expect(isPhantomInvoiceRow({ vendor_name: null, invoice_number: "9488427" })).toBe(false);
    });
});

describe("invoiceNumberFromAttachment", () => {
    it("keeps a real number and recovers Uline's from the filename", () => {
        expect(invoiceNumberFromAttachment("apfwd:x:Uline_Invoice_215047605_216827642_1.pdf", "BERINVOICE")).toBe("215047605");
        expect(invoiceNumberFromAttachment("apfwd:x:Uline_Invoice_212698005_1.pdf", "212698005")).toBe("212698005");
    });
    it("returns null when both sides are header words", () => {
        expect(invoiceNumberFromAttachment("apfwd:x:scan.pdf", "BERINVOICE")).toBeNull();
        expect(isJunkInvoiceLabel("BERINVOICE")).toBe(true);
        expect(isJunkInvoiceLabel("215047605")).toBe(false);
    });
});

describe("isCarrierFreightArchive", () => {
    it("flags FedEx / Billtrust CSV archives", () => {
        expect(isCarrierFreightArchive({ source_ref: "FEDEX_4174571_20261020155330_0.csv" })).toBe(true);
        expect(isCarrierFreightArchive({ source_ref: "fedex-csv-FEDEX_1.csv" })).toBe(true);
    });
    it("keeps goods invoices", () => {
        expect(isCarrierFreightArchive({ source_ref: "gmail-abc", vendor_name: "Rootwise Soil Dynamics" })).toBe(false);
        expect(isCarrierFreightArchive(null)).toBe(false);
    });
});

describe("firstRealInvoice", () => {
    it("skips phantoms and returns the first real invoice", () => {
        const rows = [
            { vendor_name: "error", invoice_number: "error" },
            { vendor_name: "PACKING SLIP", invoice_number: "" },
            { vendor_name: "Colorado Worm Company", invoice_number: "9488427" },
        ];
        expect(firstRealInvoice(rows)?.invoice_number).toBe("9488427");
    });
    it("returns null when every row is phantom", () => {
        expect(firstRealInvoice([{ vendor_name: "error", invoice_number: "error" }])).toBeNull();
        expect(firstRealInvoice([])).toBeNull();
        expect(firstRealInvoice(undefined)).toBeNull();
    });
});
