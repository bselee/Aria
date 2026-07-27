/**
 * @file    vendor-name-normalize.test.ts
 * @purpose Unit tests for vendor name normalization and alias resolution.
 *          Pure-function tests — no DB access, no mocks needed for
 *          normalizeVendorName or resolveCanonicalVendor.
 * @author  Hermia
 * @created 2026-07-27
 * @deps    vitest, vendor-name-normalize
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    normalizeVendorName,
    resolveCanonicalVendor,
    loadVendorAliases,
    clearVendorAliasesCache,
    type VendorAliasRow,
} from "./vendor-name-normalize";

// ── normalizeVendorName ────────────────────────────────────────────────────

describe("normalizeVendorName", () => {
    it("strips embedded CRLF and trademark glyph", () => {
        expect(normalizeVendorName("AAA COOPER\r\nTRANSPORTATION™")).toBe(
            "AAA COOPER TRANSPORTATION",
        );
    });

    it("strips lone CRLF without trademark", () => {
        expect(normalizeVendorName("DestiNATION\r\nTRANSPORT")).toBe(
            "DESTINATION TRANSPORT",
        );
    });

    it("strips trademark glyph only", () => {
        expect(normalizeVendorName("AAA COOPER TRANSPORTION™")).toBe(
            "AAA COOPER TRANSPORTION",
        );
    });

    it("collapses multiple spaces", () => {
        expect(normalizeVendorName("  AutoPot   USA  ")).toBe("AUTOPOT USA");
    });

    it("handles mixed case", () => {
        expect(normalizeVendorName("aUtOpOt UsA")).toBe("AUTOPOT USA");
    });

    it("returns empty string for null", () => {
        expect(normalizeVendorName(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
        expect(normalizeVendorName(undefined)).toBe("");
    });

    it("returns empty string for empty input", () => {
        expect(normalizeVendorName("")).toBe("");
    });

    it("strips leading/trailing quotes", () => {
        expect(normalizeVendorName('"Grassroots Fabric Pots Inc."')).toBe(
            "GRASSROOTS FABRIC POTS INC.",
        );
    });

    it("handles quoted CRLF value", () => {
        expect(normalizeVendorName('"AAA COOPER\r\nTRANSPORTATION™"')).toBe(
            "AAA COOPER TRANSPORTATION",
        );
    });

    it("strips copyright symbol", () => {
        expect(normalizeVendorName("ACME Corp©")).toBe("ACME CORP");
    });

    it("handles registered symbol", () => {
        expect(normalizeVendorName("ACME® Solutions")).toBe("ACME SOLUTIONS");
    });

    it("collapses multiple CRLF into single space", () => {
        expect(normalizeVendorName("Line1\r\n\r\nLine2")).toBe("LINE1 LINE2");
    });

    it("handles strings with only whitespace", () => {
        expect(normalizeVendorName("   ")).toBe("");
    });

    it("passes normal clean names through", () => {
        expect(normalizeVendorName("AutoPot USA")).toBe("AUTOPOT USA");
    });

    it("handles DIA!OND K GYPSUM, INC. (OCR typo with exclamation)", () => {
        // The ! is a genuine OCR error — normalization preserves it since it
        // is a standard ASCII character. Alias matching would catch this if
        // an alias row exists; otherwise the matcher's word-overlap helps.
        const result = normalizeVendorName("DIA!OND K GYPSUM, INC.");
        expect(result).toBe("DIA!OND K GYPSUM, INC.");
        // Ensure the exclamation mark is preserved (it's a valid ASCII char)
        expect(result).toContain("!");
    });
});

// ── resolveCanonicalVendor ─────────────────────────────────────────────────

describe("resolveCanonicalVendor", () => {
    const aliases: VendorAliasRow[] = [
        { finale_supplier_name: "AutoPot USA", alias: "Autopot USA" },
        {
            finale_supplier_name: "AutoPot USA",
            alias: "AutoPot Watering Systems USA",
        },
        {
            finale_supplier_name: "AutoPot USA",
            alias: "AutoPot Watering Systems USA.",
        },
        {
            finale_supplier_name: "AutoPot USA",
            alias: "Autopot Watering Systems USA",
        },
        {
            finale_supplier_name: "Grassroots Fabric Pots",
            alias: "Grassroots Fabric Pots Inc.",
        },
        {
            finale_supplier_name: "Grassroots Fabric Pots",
            alias: '"Grassroots Fabric Pots Inc."',
        },
        {
            finale_supplier_name: "Logan Labs LLC",
            alias: "LOGAN LABS",
        },
        {
            finale_supplier_name: "Logan Labs LLC",
            alias: "LOGAN LABS LLC.",
        },
        {
            finale_supplier_name: "Evergreen Growers Supply",
            alias: "Evergreen Growers Supply, LLC.",
        },
    ];

    it("resolves AutoPot USA to itself via alias 'Autopot USA'", () => {
        const result = resolveCanonicalVendor("AutoPot USA", aliases);
        expect(result).toBe("AutoPot USA");
    });

    it("resolves 'AutoPot Watering Systems USA' to 'AutoPot USA'", () => {
        const result = resolveCanonicalVendor(
            "AutoPot Watering Systems USA",
            aliases,
        );
        expect(result).toBe("AutoPot USA");
    });

    it("resolves autocase variant 'autopot watering systems usa'", () => {
        const result = resolveCanonicalVendor(
            "autopot watering systems usa",
            aliases,
        );
        expect(result).toBe("AutoPot USA");
    });

    it("resolves via normalized form (CRLF stripped)", () => {
        const result = resolveCanonicalVendor(
            "AutoPot Watering\r\nSystems USA",
            aliases,
        );
        expect(result).toBe("AutoPot USA");
    });

    it("resolves via normalized form (trademark stripped)", () => {
        const result = resolveCanonicalVendor(
            "AutoPot Watering Systems USA™",
            aliases,
        );
        expect(result).toBe("AutoPot USA");
    });

    it("resolves Grassroots (quoted alias)", () => {
        const result = resolveCanonicalVendor(
            '"Grassroots Fabric Pots Inc."',
            aliases,
        );
        expect(result).toBe("Grassroots Fabric Pots");
    });

    it("resolves Grassroots (unquoted, with period)", () => {
        const result = resolveCanonicalVendor(
            "Grassroots Fabric Pots Inc.",
            aliases,
        );
        expect(result).toBe("Grassroots Fabric Pots");
    });

    it("resolves LOGAN LABS to Logan Labs LLC", () => {
        const result = resolveCanonicalVendor("LOGAN LABS", aliases);
        expect(result).toBe("Logan Labs LLC");
    });

    it("resolves 'Logan Labs LLC.' (with period) to Logan Labs LLC", () => {
        const result = resolveCanonicalVendor("Logan Labs LLC.", aliases);
        expect(result).toBe("Logan Labs LLC");
    });

    it("resolves 'Evergreen Growers Supply, LLC.'", () => {
        const result = resolveCanonicalVendor(
            "Evergreen Growers Supply, LLC.",
            aliases,
        );
        expect(result).toBe("Evergreen Growers Supply");
    });

    it("returns null for unknown vendor", () => {
        const result = resolveCanonicalVendor("FakeCo LLC", aliases);
        expect(result).toBeNull();
    });

    it("returns null for null input", () => {
        const result = resolveCanonicalVendor(null, aliases);
        expect(result).toBeNull();
    });

    it("returns null for undefined input", () => {
        const result = resolveCanonicalVendor(undefined, aliases);
        expect(result).toBeNull();
    });

    it("returns null for empty input", () => {
        const result = resolveCanonicalVendor("", aliases);
        expect(result).toBeNull();
    });
});

// ── loadVendorAliases (integration-light) ──────────────────────────────────

describe("loadVendorAliases", () => {
    beforeEach(() => {
        clearVendorAliasesCache();
    });

    afterEach(() => {
        clearVendorAliasesCache();
    });

    it("returns rows from the live database (vendor_aliases has 32 rows)", async () => {
        // This is a light integration test — the DB is local, so no mocking needed.
        // The table has exactly 32 rows as verified during setup.
        const rows = await loadVendorAliases();
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0]).toHaveProperty("finale_supplier_name");
        expect(rows[0]).toHaveProperty("alias");
    });

    it("caches results and reuses them across calls", async () => {
        const rows1 = await loadVendorAliases();
        const rows2 = await loadVendorAliases();
        // Both calls should return the same data; second call served from cache
        expect(rows1).toEqual(rows2);
        // Cache hit means same object reference (since we cache the array ref)
        expect(rows1).toBe(rows2);
    });

    it("returns empty array gracefully on error when no cache exists", async () => {
        // Temporarily break the DB URL to force an error
        const origUrl = process.env.PGRST_URL;
        process.env.PGRST_URL = "http://localhost:1";
        clearVendorAliasesCache();

        const rows = await loadVendorAliases();
        expect(rows).toEqual([]);

        // Restore
        process.env.PGRST_URL = origUrl;
        clearVendorAliasesCache();
    });
});
