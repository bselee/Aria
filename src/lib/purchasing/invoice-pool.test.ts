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
    it("keeps real vendor names", () => {
        expect(isJunkVendorName("Colorado Worm Company")).toBe(false);
        expect(isJunkVendorName("Rootwise Soil Dynamics")).toBe(false);
        expect(isJunkVendorName(null)).toBe(true); // null = missing, still junk
    });
});

describe("isJunkInvoiceNumber", () => {
    it("flags failure markers only", () => {
        expect(isJunkInvoiceNumber("error")).toBe(true);
        expect(isJunkInvoiceNumber("")).toBe(true);
        expect(isJunkInvoiceNumber("9488427")).toBe(false);
    });
});

describe("isPhantomInvoiceRow", () => {
    it("flags the PO 125411 packing-list rows", () => {
        expect(isPhantomInvoiceRow({ vendor_name: "error", invoice_number: "error" })).toBe(true);
        expect(isPhantomInvoiceRow({ vendor_name: "PACKING SLIP", invoice_number: "" })).toBe(true);
    });
    it("keeps real invoice rows", () => {
        expect(isPhantomInvoiceRow({ vendor_name: "Colorado Worm Company", invoice_number: "9488427" })).toBe(false);
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
