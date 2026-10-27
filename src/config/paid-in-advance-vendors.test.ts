/**
 * @file    paid-in-advance-vendors.test.ts
 * @purpose Pins for the pay-in-advance vendor class.
 * @author  Hermia
 * @created 2026-10-27
 */
import { describe, expect, it } from "vitest";
import { isPaidInAdvanceVendor } from "./paid-in-advance-vendors";

describe("isPaidInAdvanceVendor", () => {
    it("matches the named class and close spellings", () => {
        expect(isPaidInAdvanceVendor("Sustainable Village")).toBe(true);
        expect(isPaidInAdvanceVendor("Cen-Tec Systems")).toBe(true);
        expect(isPaidInAdvanceVendor("CenTec")).toBe(true);
        expect(isPaidInAdvanceVendor("Axiom Print")).toBe(true);
        expect(isPaidInAdvanceVendor("Colorful Packaging Ltd")).toBe(true);
    });
    it("does not swallow vendors that still invoice", () => {
        expect(isPaidInAdvanceVendor("ULINE")).toBe(false);
        expect(isPaidInAdvanceVendor("Rootwise Soil Dynamics")).toBe(false);
        expect(isPaidInAdvanceVendor("Colorado Worm Company")).toBe(false);
        expect(isPaidInAdvanceVendor(null)).toBe(false);
    });
});
