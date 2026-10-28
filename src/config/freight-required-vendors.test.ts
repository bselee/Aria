/**
 * @file    freight-required-vendors.test.ts
 * @purpose Tests for the freight-required vendor predicate and freight math.
 */
import { describe, it, expect } from "vitest";
import { isFreightRequiredVendor, freightOnPo } from "./freight-required-vendors";

describe("isFreightRequiredVendor", () => {
    it("flags the named truck-freight vendors", () => {
        for (const v of ["Rootwise", "ULINE", "Gary's Worm", "International Molasses", "Lind Marine"]) {
            expect(isFreightRequiredVendor(v)).toBe(true);
        }
    });

    it("is case and punctuation insensitive", () => {
        expect(isFreightRequiredVendor("rootwise, inc.")).toBe(true);
        expect(isFreightRequiredVendor("ULINE SUPPLY")).toBe(true);
        expect(isFreightRequiredVendor("int molasses")).toBe(true);
    });

    it("is false for other vendors and empty names", () => {
        expect(isFreightRequiredVendor("Miles Filippelli")).toBe(false);
        expect(isFreightRequiredVendor("New Moon Dev Co")).toBe(false);
        expect(isFreightRequiredVendor("")).toBe(false);
        expect(isFreightRequiredVendor(null)).toBe(false);
    });
});

describe("freightOnPo", () => {
    it("returns the freight between total and subtotal", () => {
        expect(freightOnPo(7875, 7300)).toBe(575);
    });

    it("returns zero when total is at or below subtotal", () => {
        expect(freightOnPo(7300, 7300)).toBe(0);
        expect(freightOnPo(7200, 7300)).toBe(0);
    });

    it("returns zero for missing numbers", () => {
        expect(freightOnPo(null, 100)).toBe(0);
        expect(freightOnPo(null, null)).toBe(0);
        expect(freightOnPo(undefined, undefined)).toBe(0);
    });
});
