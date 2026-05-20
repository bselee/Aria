/**
 * @file    shipment-leg-parser.test.ts
 * @purpose Unit tests for the /legs command parser.
 * @author  Aria
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    vitest, shipment-leg-parser
 */

import { describe, it, expect } from "vitest";
import { parseLegsCommand, isLegsParseError } from "./shipment-leg-parser";

describe("parseLegsCommand", () => {
    // ── Happy path ──────────────────────────────────────────────────────────

    it("should parse a standard three-leg command with full ISO dates", () => {
        const result = parseLegsCommand("/legs PO-1234 1:30000@2026-06-10 2:40000@2026-07-05 3:50000@2026-08-01");
        expect(isLegsParseError(result)).toBe(false);
        if (isLegsParseError(result)) return;
        expect(result.poNumber).toBe("PO-1234");
        expect(result.legs).toHaveLength(3);
        expect(result.legs[0]).toMatchObject({ legNumber: 1, expectedQty: 30000, expectedDate: "2026-06-10" });
        expect(result.legs[1]).toMatchObject({ legNumber: 2, expectedQty: 40000, expectedDate: "2026-07-05" });
        expect(result.legs[2]).toMatchObject({ legNumber: 3, expectedQty: 50000, expectedDate: "2026-08-01" });
    });

    it("should handle 'k' shorthand for thousands", () => {
        const result = parseLegsCommand("/legs PO-5555 1:30k@2026-06-10 2:40k@2026-07-05");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedQty).toBe(30000);
        expect(result.legs[1].expectedQty).toBe(40000);
    });

    it("should handle comma-formatted quantities like 30,000", () => {
        const result = parseLegsCommand("/legs PO-5555 1:30,000@2026-06-10 2:40,000@2026-07-05");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedQty).toBe(30000);
    });

    it("should handle 'm' shorthand for millions", () => {
        const result = parseLegsCommand("/legs PO-9999 1:1.5m@2026-06-10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedQty).toBe(1500000);
    });

    it("should parse Mon-DD date format using current year", () => {
        const year = new Date().getFullYear();
        const result = parseLegsCommand("/legs PO-1234 1:30000@Jun-10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedDate).toBe(`${year}-06-10`);
    });

    it("should parse full month name 'June 10' format", () => {
        const year = new Date().getFullYear();
        const result = parseLegsCommand("/legs PO-1234 1:30000@June10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedDate).toBe(`${year}-06-10`);
    });

    it("should parse MM/DD date format using current year", () => {
        const year = new Date().getFullYear();
        const result = parseLegsCommand("/legs PO-1234 1:30000@06/10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0].expectedDate).toBe(`${year}-06-10`);
    });

    it("should accept = as separator instead of @", () => {
        const result = parseLegsCommand("/legs PO-1234 1:30000=2026-06-10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs[0]).toMatchObject({ legNumber: 1, expectedQty: 30000, expectedDate: "2026-06-10" });
    });

    it("should sort legs by leg number regardless of input order", () => {
        const result = parseLegsCommand("/legs PO-1234 3:50000@2026-08-01 1:30000@2026-06-10 2:40000@2026-07-05");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs.map(l => l.legNumber)).toEqual([1, 2, 3]);
    });

    it("should preserve warnings for skipped tokens while returning valid legs", () => {
        const result = parseLegsCommand("/legs PO-1234 1:30000@2026-06-10 badtoken 2:40000@2026-07-05");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs).toHaveLength(2);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toMatch(/badtoken/);
    });

    it("should warn about duplicate leg numbers and skip the second one", () => {
        const result = parseLegsCommand("/legs PO-1234 1:30000@2026-06-10 1:99999@2026-06-15");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs).toHaveLength(1);
        expect(result.legs[0].expectedQty).toBe(30000); // first one wins
        expect(result.warnings.some(w => /[Dd]uplicate/.test(w))).toBe(true);
    });

    // ── Error paths ─────────────────────────────────────────────────────────

    it("should return an error when no arguments are provided", () => {
        const result = parseLegsCommand("/legs");
        expect(isLegsParseError(result)).toBe(true);
    });

    it("should return an error when only a PO number is provided with no legs", () => {
        const result = parseLegsCommand("/legs PO-1234");
        expect(isLegsParseError(result)).toBe(true);
        if (isLegsParseError(result)) expect(result.error).toMatch(/[Nn]o legs/);
    });

    it("should return an error when all tokens are unparseable", () => {
        const result = parseLegsCommand("/legs PO-1234 notvalid alsoinvalid");
        expect(isLegsParseError(result)).toBe(true);
    });

    it("should return an error when the first token looks like a leg (missing PO number)", () => {
        const result = parseLegsCommand("/legs 1:30000@2026-06-10");
        expect(isLegsParseError(result)).toBe(true);
        if (isLegsParseError(result)) expect(result.error).toMatch(/PO number/);
    });

    it("should return an error for an invalid date (month 13)", () => {
        const result = parseLegsCommand("/legs PO-1234 1:30000@2026-13-10");
        // Either error or warning + no valid legs → error
        if (!isLegsParseError(result)) {
            // Accepted as a warning case — legs should be empty → error
            expect(result.legs).toHaveLength(0);
        }
    });

    // ── Edge cases ───────────────────────────────────────────────────────────

    it("should handle /LEGS (case-insensitive command prefix)", () => {
        const result = parseLegsCommand("/LEGS PO-1234 1:30000@2026-06-10");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs).toHaveLength(1);
    });

    it("should handle extra whitespace between tokens", () => {
        const result = parseLegsCommand("/legs   PO-1234   1:30000@2026-06-10   2:40000@2026-07-05");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.legs).toHaveLength(2);
    });

    it("should handle a single-leg command (no splitting needed)", () => {
        const result = parseLegsCommand("/legs PO-ABC-999 1:5000@2026-09-15");
        if (isLegsParseError(result)) throw new Error(result.error);
        expect(result.poNumber).toBe("PO-ABC-999");
        expect(result.legs).toHaveLength(1);
        expect(result.legs[0]).toMatchObject({ legNumber: 1, expectedQty: 5000, expectedDate: "2026-09-15" });
    });

    it("should handle zero expected_qty as invalid", () => {
        const result = parseLegsCommand("/legs PO-1234 1:0@2026-06-10");
        if (!isLegsParseError(result)) {
            expect(result.legs.filter(l => l.expectedQty === 0)).toHaveLength(0);
        }
    });
});
