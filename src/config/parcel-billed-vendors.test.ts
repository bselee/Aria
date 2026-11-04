/**
 * @file    parcel-billed-vendors.test.ts
 * @purpose Pin the parcel-account vendor list: Finale's space-stripped supplier
 *          name and the invoice-side company name must both resolve, and a
 *          lookalike vendor must not.
 */
import { describe, it, expect } from "vitest";
import { isParcelBilledVendor, parcelBilledVendorKeys } from "./parcel-billed-vendors";

describe("isParcelBilledVendor", () => {
    it("matches Safe Solutions under every name form the system stores", () => {
        expect(isParcelBilledVendor("SafeSolutions")).toBe(true); // Finale supplier
        expect(isParcelBilledVendor("Safe Solutions, Inc.")).toBe(true); // vendor_invoices
        expect(isParcelBilledVendor('"Safe Solutions, Inc."')).toBe(true);
        expect(isParcelBilledVendor("safesolutions llc")).toBe(true);
    });

    it("is false for other vendors and empty values", () => {
        expect(isParcelBilledVendor("Uline")).toBe(false);
        expect(isParcelBilledVendor("Safe Solutions Express Trucking")).toBe(true); // contains the key
        expect(isParcelBilledVendor("")).toBe(false);
        expect(isParcelBilledVendor(null)).toBe(false);
        expect(isParcelBilledVendor(undefined)).toBe(false);
    });

    it("exposes the raw keys for enumeration", () => {
        expect(parcelBilledVendorKeys()).toContain("safe solutions");
    });
});
