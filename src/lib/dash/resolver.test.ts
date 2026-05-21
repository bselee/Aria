/**
 * @file    resolver.test.ts
 * @purpose Unit tests verifying DASH digital asset filename parsing, SKU mapping, and dimension congruency.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    vitest, src/lib/dash/resolver.ts
 */

import { describe, it, expect } from "vitest";
import {
    parseDashFileName,
    resolveDashAssets,
    isDimensionCongruent,
} from "./resolver";

describe("DASH Digital Asset Resolver", () => {
    describe("parseDashFileName", () => {
        it("should parse standard label SKU with front/back labels and date", () => {
            const parsed = parseDashFileName("SAP02_Front Label_10082024.png");
            expect(parsed.sku).toBe("SAP02");
            expect(parsed.side).toBe("front");
            expect(parsed.isPrintReady).toBe(false);
            expect(parsed.productName).toBe("Front Label");
        });

        it("should parse print ready and dimension strings cleanly", () => {
            const parsed = parseDashFileName("BBL101_7.5x10_Print Ready.pdf");
            expect(parsed.sku).toBe("BBL101");
            expect(parsed.dimensions).toBe("7.5x10");
            expect(parsed.isPrintReady).toBe(true);
            expect(parsed.side).toBe("unknown");
        });

        it("should parse custom bag names with multiple dimensions and details", () => {
            const parsed = parseDashFileName("GnarBar06_2lbs_5x6_Label_Bag.pdf");
            expect(parsed.sku).toBe("GNARBAR06");
            expect(parsed.dimensions).toBe("5x6");
            expect(parsed.isPrintReady).toBe(false);
            expect(parsed.side).toBe("unknown");
            expect(parsed.productName).toBe("2lbs Label Bag");
        });

        it("should handle files with weird casing or spacings", () => {
            const parsed = parseDashFileName("ac111_Half Gallon_4.25w x 4.5.pdf");
            expect(parsed.sku).toBe("AC111");
            expect(parsed.dimensions).toBe("4.25wx4.5");
            expect(parsed.side).toBe("unknown");
        });
    });

    describe("resolveDashAssets", () => {
        it("should resolve exact matching SKU from seeded assets", () => {
            const matched = resolveDashAssets("SAP02");
            expect(matched.length).toBe(2);
            expect(matched[0].name).toContain("SAP02_Fornt Label");
            expect(matched[1].name).toContain("SAP02_Back Label");
        });

        it("should resolve matching case-insensitive partial SKU", () => {
            const matched = resolveDashAssets("gnarbar07");
            expect(matched.length).toBe(4);
            expect(matched[0].skuMatch).toBe("GNARBAR07");
        });

        it("should return empty array for completely unmatched SKUs", () => {
            const matched = resolveDashAssets("NON_EXISTENT_SKU");
            expect(matched.length).toBe(0);
        });
    });

    describe("isDimensionCongruent", () => {
        it("should return true when physical and spec dimensions match exactly", () => {
            expect(isDimensionCongruent("8.5x11", '8.5" x 11"')).toBe(true);
        });

        it("should return true when landscape and portrait coordinates are inverted", () => {
            expect(isDimensionCongruent("11x8.5", '8.5" x 11"')).toBe(true);
            expect(isDimensionCongruent("8.5x11", '11" x 8.5"')).toBe(true);
        });

        it("should return false when dimensions represent an actual mismatch", () => {
            expect(isDimensionCongruent("5x6", '7.5" x 10"')).toBe(false);
        });

        it("should return true when either parameter is missing (graceful fallback)", () => {
            expect(isDimensionCongruent(undefined, '3" x 3"')).toBe(true);
            expect(isDimensionCongruent("3x3", undefined)).toBe(true);
        });
    });
});
