/**
 * @file    paid-in-advance-vendors.test.ts
 * @purpose Pins for the pay-in-advance vendor class.
 * @author  Hermia
 * @created 2026-10-27
 */
import { describe, expect, it } from "vitest";
import { isPaidInAdvanceVendor, isBilledUpfrontVendor } from "./paid-in-advance-vendors";

describe("isPaidInAdvanceVendor", () => {
    it("matches the named class and close spellings", () => {
        expect(isPaidInAdvanceVendor("Sustainable Village")).toBe(true);
        expect(isPaidInAdvanceVendor("Cen-Tec Systems")).toBe(true);
        expect(isPaidInAdvanceVendor("CenTec")).toBe(true);
        expect(isPaidInAdvanceVendor("Axiom Print")).toBe(true);
        expect(isPaidInAdvanceVendor("Colorful Packaging Ltd")).toBe(true);
        expect(isPaidInAdvanceVendor("Thirsty Earth")).toBe(true);
        expect(isPaidInAdvanceVendor("Rock On")).toBe(true);
        expect(isPaidInAdvanceVendor("RockOn")).toBe(true);
        // 2026-11-05 prepayment / card-on-file additions (Bill's authoritative list)
        expect(isPaidInAdvanceVendor("Grove Bags (Kinzie Advanced Polymers))")).toBe(true);
        expect(isPaidInAdvanceVendor("Calyx Containers")).toBe(true);
        expect(isPaidInAdvanceVendor("Calyx Cure")).toBe(true);
        expect(isPaidInAdvanceVendor("Print Source Inc.")).toBe(true);
        expect(isPaidInAdvanceVendor("PSI")).toBe(true);
        expect(isPaidInAdvanceVendor("Stock Bag Depot")).toBe(true);
    });
    it("does not swallow vendors that still invoice", () => {
        expect(isPaidInAdvanceVendor("ULINE")).toBe(false);
        expect(isPaidInAdvanceVendor("Rootwise Soil Dynamics")).toBe(false);
        expect(isPaidInAdvanceVendor("Colorado Worm Company")).toBe(false);
        expect(isPaidInAdvanceVendor(null)).toBe(false);
    });
});

describe("isBilledUpfrontVendor", () => {
    it("matches New Moon and not a normal vendor", () => {
        expect(isBilledUpfrontVendor("New Moon Development Co")).toBe(true);
        expect(isBilledUpfrontVendor("NEWMOONDEVCO")).toBe(true);
        expect(isBilledUpfrontVendor("ULINE")).toBe(false);
    });
});
