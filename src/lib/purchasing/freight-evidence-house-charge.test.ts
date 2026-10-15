/**
 * @file    src/lib/purchasing/freight-evidence-house-charge.test.ts
 * @purpose A vendor's house charge is not carriage. Uline bills $1.50 on every
 *          invoice while the real carriage arrives on the FedEx Freight COLLECT bill,
 *          so evidence recorded against the house charge declared a match on POs that
 *          carried no carriage at all. These tests pin the corrected rule.
 * @author  Hermia
 * @created 2026-10-15
 */
import { describe, expect, it } from "vitest";

import {
    assessFreightEvidence,
    carriageExcludingHouseCharge,
    houseFreightChargeFor,
} from "./vendor-freight-pattern";

describe("houseFreightChargeFor", () => {
    it("knows the Uline house charge whatever the casing", () => {
        expect(houseFreightChargeFor("ULINE")).toBe(1.5);
        expect(houseFreightChargeFor("Uline")).toBe(1.5);
        expect(houseFreightChargeFor("uline")).toBe(1.5);
    });

    it("returns 0 for a vendor with no house charge", () => {
        expect(houseFreightChargeFor("Rootwise Soil Dynamics")).toBe(0);
        expect(houseFreightChargeFor("")).toBe(0);
    });
});

describe("carriageExcludingHouseCharge", () => {
    it("removes the house charge from a real Uline freight total", () => {
        // PO 124289: 1.50 house charge + 500.97 FedEx collect
        expect(carriageExcludingHouseCharge(502.47, 1.5)).toBe(500.97);
    });

    it("reports no carriage when the house charge is all there is", () => {
        expect(carriageExcludingHouseCharge(1.5, 1.5)).toBe(0);
    });

    it("never goes negative", () => {
        expect(carriageExcludingHouseCharge(0, 1.5)).toBe(0);
        expect(carriageExcludingHouseCharge(1.0, 1.5)).toBe(0);
    });
});

describe("assessFreightEvidence", () => {
    it("refuses to match a Uline PO that carries only the house charge", () => {
        // The exact row that read as matched for months: invoice freight 1.50,
        // PO freight 1.50, no carriage anywhere.
        const a = assessFreightEvidence({
            vendorName: "ULINE",
            poFreightTotal: 1.5,
            vendorInvoiceFreight: 1.5,
        });
        expect(a.houseFreightCharge).toBe(1.5);
        expect(a.inboundFreight).toBe(0);
        expect(a.invoiceInboundFreight).toBe(0);
        expect(a.freightMatched).toBe(false);
    });

    it("keeps a Uline PO unmatched until the carrier amount is present", () => {
        const a = assessFreightEvidence({
            vendorName: "ULINE",
            poFreightTotal: 502.47,
            vendorInvoiceFreight: 1.5,
        });
        expect(a.inboundFreight).toBe(500.97);
        expect(a.invoiceInboundFreight).toBe(0);
        expect(a.freightMatched).toBe(false);
    });

    it("matches when the carrier amount is the amount on both sides", () => {
        const a = assessFreightEvidence({
            vendorName: "ULINE",
            poFreightTotal: 502.47,
            vendorInvoiceFreight: 502.47,
        });
        expect(a.inboundFreight).toBe(500.97);
        expect(a.invoiceInboundFreight).toBe(500.97);
        expect(a.freightMatched).toBe(true);
    });

    it("still matches a vendor that bills carriage itself", () => {
        const a = assessFreightEvidence({
            vendorName: "Colorful Packaging",
            poFreightTotal: 4310,
            vendorInvoiceFreight: 4310,
        });
        expect(a.houseFreightCharge).toBe(0);
        expect(a.freightMatched).toBe(true);
    });

    it("flags a carriage mismatch between the PO and its source", () => {
        const a = assessFreightEvidence({
            vendorName: "ULINE",
            poFreightTotal: 502.47,
            vendorInvoiceFreight: 400,
        });
        expect(a.freightMatched).toBe(false);
    });
});
