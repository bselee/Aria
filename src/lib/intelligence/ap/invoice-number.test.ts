/**
 * @file    src/lib/intelligence/ap/invoice-number.test.ts
 * @purpose Unit tests for the shared subject-first invoice-number derivation
 *          used to populate ap_local_forwards.ocr_invoice_number at forward
 *          time. Cases mirror real subjects from the 14-day reconcile.
 * @author  Hermia
 * @created 2026-09-17
 * @deps    vitest
 */
import { describe, it, expect } from "vitest";
import { deriveInvoiceNumberFromSubject } from "./invoice-number";

describe("deriveInvoiceNumberFromSubject", () => {
    it("extracts AAA Cooper subject Pro# (over any filename noise)", () => {
        expect(
            deriveInvoiceNumberFromSubject(
                "Invoice Stmt - Cust 0001159492 Pro#: 64058907",
                "64058907_AAA_Cooper_Transportation.pdf",
            ),
        ).toBe("64058907");
    });

    it("extracts subject 'Invoice APUS-247442' via the alphanumeric rule", () => {
        expect(
            deriveInvoiceNumberFromSubject(
                "New payment request from AutoPot USA - Invoice APUS-247442",
                "Invoice_APUS247442_from_AutoPot_Watering_Systems_USA.pdf",
            ),
        ).toBe("APUS-247442");
    });

    it("extracts plain 'Invoice 34541' keyword numbers", () => {
        expect(deriveInvoiceNumberFromSubject("Grassroots Invoice 34541")).toBe("34541");
    });

    it("extracts 'invoice 136044' from Logan Labs subjects", () => {
        expect(
            deriveInvoiceNumberFromSubject("New payment request from LOGAN LABS LLC - invoice 136044"),
        ).toBe("136044");
    });

    it("extracts FedEx 9-xxx-xxxxx from the FILENAME when subject is generic", () => {
        expect(
            deriveInvoiceNumberFromSubject(
                "Your New FedEx Billing Online invoice is attached",
                "FedEx_Ground_9-462-62548.pdf",
            ),
        ).toBe("9-462-62548");
    });

    it("prefers subject Pro# over a FedEx-looking filename", () => {
        expect(
            deriveInvoiceNumberFromSubject("Invoice Stmt - Cust 1 Pro#: 64058402", "9-111-11111.pdf"),
        ).toBe("64058402");
    });

    it("returns null for suspicious non-invoice subjects (no bare-digit fallback)", () => {
        expect(
            deriveInvoiceNumberFromSubject("FedEx Freight vs Buildasoil LLC File# 20056901", "image.pdf"),
        ).toBeNull();
        expect(
            deriveInvoiceNumberFromSubject("Notice of Invoice Due ID: 16 C# (9897269)", "US Payment information PDF.pdf"),
        ).toBeNull();
    });

    it("returns null for scan-style subjects without a confident number", () => {
        // "Benny_09092026" is a date — the bare-digit fallback is intentionally excluded.
        expect(deriveInvoiceNumberFromSubject("Scanned Invoice: Benny_09092026.pdf", "Benny_09092026.pdf")).toBeNull();
    });

    it("handles empty/null inputs", () => {
        expect(deriveInvoiceNumberFromSubject(null)).toBeNull();
        expect(deriveInvoiceNumberFromSubject("")).toBeNull();
    });
});
