/**
 * @file    src/lib/tracking/vendor-carrier.test.ts
 * @purpose Comprehensive unit tests for the vendor→carrier correlation layer.
 *          Covers normalizeCarrierToken, carrierFromTrackingNumber edge cases,
 *          carrierMatchesVendor (seeds + learned + multi-carrier + substring),
 *          and learnVendorCarrierCounts with a mock PostgREST client.
 * @author  Hermia
 * @created 2026-08-26
 */

import { describe, expect, it } from "vitest";
import {
    VENDOR_CARRIER_SEEDS,
    carrierFromTrackingNumber,
    carrierMatchesVendor,
    carrierRejectedForVendor,
    learnVendorCarrierCounts,
    normalizeCarrierToken,
    type VendorCarrierCounts,
} from "./vendor-carrier";

// ── normalizeCarrierToken ──────────────────────────────────────────────────

describe("normalizeCarrierToken", () => {
    it("lowercases and collapses non-alphanumeric runs to spaces", () => {
        expect(normalizeCarrierToken("FedEx Freight")).toBe("fedex freight");
        expect(normalizeCarrierToken("AAA Cooper")).toBe("aaa cooper");
        expect(normalizeCarrierToken("UPS-Ground")).toBe("ups ground");
    });

    it("trims leading/trailing whitespace", () => {
        expect(normalizeCarrierToken("  FedEx  ")).toBe("fedex");
    });

    it("collapses internal multi-space to single space", () => {
        expect(normalizeCarrierToken("Oak   Harbor")).toBe("oak harbor");
    });

    it("returns empty string for null/undefined/empty", () => {
        expect(normalizeCarrierToken(null)).toBe("");
        expect(normalizeCarrierToken(undefined)).toBe("");
        expect(normalizeCarrierToken("")).toBe("");
    });

    it("strips punctuation and special characters", () => {
        expect(normalizeCarrierToken("Dr. Zymes!")).toBe("dr zymes");
        expect(normalizeCarrierToken("C&S_Plastics")).toBe("c s plastics");
    });
});

// ── carrierFromTrackingNumber ───────────────────────────────────────────────

describe("carrierFromTrackingNumber (edge cases)", () => {
    it("extracts carrier from encoded string", () => {
        expect(carrierFromTrackingNumber("FedEx:::383269682926")).toBe("fedex");
        expect(carrierFromTrackingNumber("UPS:::1Z22YV580360436423")).toBe("ups");
        expect(carrierFromTrackingNumber("Oak Harbor Freight Lines:::56177295394")).toBe(
            "oak harbor freight lines",
        );
    });

    it("returns null for bare numbers (no carrier label)", () => {
        expect(carrierFromTrackingNumber("383269682926")).toBeNull();
        expect(carrierFromTrackingNumber("1Z22YV580360436423")).toBeNull();
    });

    it("returns null for empty/null/whitespace input", () => {
        expect(carrierFromTrackingNumber("")).toBeNull();
        expect(carrierFromTrackingNumber(null)).toBeNull();
        expect(carrierFromTrackingNumber(undefined)).toBeNull();
        expect(carrierFromTrackingNumber("   ")).toBeNull();
    });

    it("handles whitespace-padded encoded strings", () => {
        expect(carrierFromTrackingNumber("  FedEx:::123  ")).toBe("fedex");
    });
});

// ── VENDOR_CARRIER_SEEDS ───────────────────────────────────────────────────

describe("VENDOR_CARRIER_SEEDS", () => {
    it("is non-empty and contains key vendors", () => {
        const keys = Object.keys(VENDOR_CARRIER_SEEDS);
        expect(keys.length).toBeGreaterThanOrEqual(10);
        expect(keys).toContain("rootwise");
        expect(keys).toContain("uline");
        expect(keys).toContain("thrive probiotics");
    });

    it("every seed value is a non-empty array of normalized carriers", () => {
        for (const [key, carriers] of Object.entries(VENDOR_CARRIER_SEEDS)) {
            expect(key).toBe(key.toLowerCase());
            expect(carriers.length).toBeGreaterThan(0);
            for (const c of carriers) {
                expect(c).toBe(c.toLowerCase());
                expect(c).toMatch(/^[a-z0-9 ]+$/);
            }
        }
    });
});

// ── carrierMatchesVendor (seeds) ────────────────────────────────────────────

describe("carrierMatchesVendor (seed layer)", () => {
    it("allows Rootwise + FedEx (seed match)", () => {
        expect(carrierMatchesVendor("Rootwise Soil Dynamics", "FedEx")).toBe("allow");
    });

    it("allows Rootwise + FedEx Freight (substring 'fedex' matches 'fedex freight')", () => {
        expect(carrierMatchesVendor("Rootwise", "FedEx Freight")).toBe("allow");
    });

    it("rejects Rootwise + Oak Harbor (seed contradiction)", () => {
        expect(carrierMatchesVendor("Rootwise", "Oak Harbor Freight Lines")).toBe("reject");
    });

    it("rejects Rootwise + UPS (seed contradiction)", () => {
        expect(carrierMatchesVendor("Rootwise Soil Dynamics", "UPS")).toBe("reject");
    });

    it("allows ULINE + UPS (seed match)", () => {
        expect(carrierMatchesVendor("ULINE", "UPS")).toBe("allow");
    });

    it("allows Grassroots + AAA Cooper (multi-carrier seed)", () => {
        expect(carrierMatchesVendor("Grassroots Fabric Pots", "AAA Cooper")).toBe("allow");
    });

    it("allows Grassroots + UPS (multi-carrier seed, second carrier)", () => {
        expect(carrierMatchesVendor("Grassroots Fabric Pots", "UPS")).toBe("allow");
    });

    it("rejects Grassroots + FedEx (not in multi-carrier seed)", () => {
        expect(carrierMatchesVendor("Grassroots Fabric Pots", "FedEx")).toBe("reject");
    });

    it("allows C and S Plastics + AAA Cooper (seed with special chars)", () => {
        expect(carrierMatchesVendor("C and S Plastics", "AAA Cooper")).toBe("allow");
    });

    it("rejects C and S Plastics + FedEx (seed contradiction)", () => {
        expect(carrierMatchesVendor("C and S Plastics", "FedEx")).toBe("reject");
    });

    it("matches seed by bidirectional substring (vendor includes seedKey)", () => {
        // "rootwise" is the seedKey; "Rootwise Soil Dynamics" includes it
        expect(carrierMatchesVendor("Rootwise Soil Dynamics", "FedEx")).toBe("allow");
    });
});

// ── carrierMatchesVendor (learned layer) ─────────────────────────────────────

describe("carrierMatchesVendor (learned layer)", () => {
    it("allows when the learned map has a matching carrier for a non-seed vendor", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["fedex", 2]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("allow");
    });

    it("rejects when the learned map has ≥2 samples of a different carrier", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 3]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("reject");
    });

    it("does NOT reject from a single learned sample (conservative guard)", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 1]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("unknown");
    });

    it("rejects when total samples ≥2 even with multiple carriers (none match)", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 1], ["ups", 1]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("reject");
    });

    it("allows when at least one learned carrier matches (even if others don't)", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 3], ["fedex", 1]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("allow");
    });

    it("returns unknown for a vendor not in seeds or learned map", () => {
        expect(carrierMatchesVendor("Unknown Vendor", "FedEx")).toBe("unknown");
    });

    it("seed takes precedence over learned (seed allows, learned would reject)", () => {
        // Rootwise seed says FedEx → allow, even if learned says Oak Harbor
        const learned: VendorCarrierCounts = new Map([
            ["rootwise", new Map([["oak harbor", 5]])],
        ]);
        expect(carrierMatchesVendor("Rootwise", "FedEx", learned)).toBe("allow");
    });

    it("seed takes precedence over learned (seed rejects, learned would allow)", () => {
        // Rootwise seed says FedEx only → reject Oak Harbor, even if learned says Oak Harbor
        const learned: VendorCarrierCounts = new Map([
            ["rootwise", new Map([["oak harbor", 5]])],
        ]);
        expect(carrierMatchesVendor("Rootwise", "Oak Harbor", learned)).toBe("reject");
    });
});

// ── carrierMatchesVendor (edge cases) ─────────────────────────────────────────

describe("carrierMatchesVendor (edge cases)", () => {
    it("returns unknown when vendor name is empty", () => {
        expect(carrierMatchesVendor("", "FedEx")).toBe("unknown");
        expect(carrierMatchesVendor(null, "FedEx")).toBe("unknown");
    });

    it("returns unknown when carrier is empty", () => {
        expect(carrierMatchesVendor("Rootwise", "")).toBe("unknown");
        expect(carrierMatchesVendor("Rootwise", null)).toBe("unknown");
    });

    it("returns unknown when both are empty", () => {
        expect(carrierMatchesVendor("", "")).toBe("unknown");
    });
});

// ── carrierRejectedForVendor ──────────────────────────────────────────────────

describe("carrierRejectedForVendor", () => {
    it("returns true for a seed contradiction", () => {
        expect(carrierRejectedForVendor("Rootwise", "Oak Harbor")).toBe(true);
    });

    it("returns false for a seed match (allow)", () => {
        expect(carrierRejectedForVendor("Rootwise", "FedEx")).toBe(false);
    });

    it("returns false for unknown vendor/carrier", () => {
        expect(carrierRejectedForVendor("Mystery Vendor", "FedEx")).toBe(false);
    });

    it("returns true for a learned contradiction with ≥2 samples", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 3]])],
        ]);
        expect(carrierRejectedForVendor("Mystery Vendor", "FedEx", learned)).toBe(true);
    });
});

// ── learnVendorCarrierCounts ──────────────────────────────────────────────────

/**
 * Build a minimal mock PostgREST client that returns paginated data.
 * The real client chains: db.from(t).select(cols).limit(n).offset(o) → { data }.
 */
function mockPostgrestClient(pages: any[][]): any {
    let call = 0;
    const build = () => ({
        select: () => ({
            limit: () => ({
                offset: () =>
                    Promise.resolve({
                        data: pages[call++] || [],
                        error: null,
                    }),
            }),
        }),
    });
    return { from: () => build() };
}

describe("learnVendorCarrierCounts", () => {
    it("returns empty map when db is null", async () => {
        const result = await learnVendorCarrierCounts(null);
        expect(result.size).toBe(0);
    });

    it("derives vendor→carrier from purchase_orders.tracking_numbers", async () => {
        const pages = [[
            { vendor_name: "Rootwise", tracking_numbers: ["FedEx:::383269682926"] },
            { vendor_name: "ULINE", tracking_numbers: ["UPS:::1Z22YV580360436423", "UPS:::1Z999"] },
            { vendor_name: "Thrive Probiotics", tracking_numbers: ["Oak Harbor Freight Lines:::56177"] },
        ]];
        const result = await learnVendorCarrierCounts(mockPostgrestClient(pages));

        expect(result.size).toBe(3);
        expect(result.get("rootwise")?.get("fedex")).toBe(1);
        expect(result.get("uline")?.get("ups")).toBe(2);
        expect(result.get("thrive probiotics")?.get("oak harbor freight lines")).toBe(1);
    });

    it("skips rows with empty or non-array tracking_numbers", async () => {
        const pages = [[
            { vendor_name: "HasTracking", tracking_numbers: ["FedEx:::123"] },
            { vendor_name: "EmptyArray", tracking_numbers: [] },
            { vendor_name: "NullTracking", tracking_numbers: null },
            { vendor_name: "MissingField" },
        ]];
        const result = await learnVendorCarrierCounts(mockPostgrestClient(pages));
        expect(result.size).toBe(1);
        expect(result.has("hastracking")).toBe(true);
        expect(result.has("emptyarray")).toBe(false);
    });

    it("skips bare tracking numbers (no carrier label → carrierFromTrackingNumber returns null)", async () => {
        const pages = [[
            { vendor_name: "BareNumber", tracking_numbers: ["383269682926"] },
        ]];
        const result = await learnVendorCarrierCounts(mockPostgrestClient(pages));
        // carrierFromTrackingNumber returns null for bare → bump() skips
        expect(result.size).toBe(0);
    });

    it("accumulates counts across multiple tracking numbers per vendor", async () => {
        const pages = [[
            {
                vendor_name: "MultiCarrier",
                tracking_numbers: ["FedEx:::111", "UPS:::222", "FedEx:::333"],
            },
        ]];
        const result = await learnVendorCarrierCounts(mockPostgrestClient(pages));
        expect(result.get("multicarrier")?.get("fedex")).toBe(2);
        expect(result.get("multicarrier")?.get("ups")).toBe(1);
    });

    it("paginates across multiple 1000-row pages", async () => {
        const page1 = Array.from({ length: 1000 }, (_, i) => ({
            vendor_name: "PaginatedVendor",
            tracking_numbers: ["FedEx:::" + i],
        }));
        const page2 = [
            { vendor_name: "PaginatedVendor", tracking_numbers: ["FedEx:::9999"] },
        ];
        const result = await learnVendorCarrierCounts(mockPostgrestClient([page1, page2]));
        expect(result.get("paginatedvendor")?.get("fedex")).toBe(1001);
    });

    it("returns empty map on error (non-fatal catch)", async () => {
        const brokenClient = {
            from: () => {
                throw new Error("connection refused");
            },
        };
        const result = await learnVendorCarrierCounts(brokenClient as any);
        expect(result.size).toBe(0);
    });

    it("handles vendor_name with special characters (normalizes)", async () => {
        const pages = [[
            { vendor_name: "C & S Plastics!", tracking_numbers: ["AAA Cooper:::723"] },
        ]];
        const result = await learnVendorCarrierCounts(mockPostgrestClient(pages));
        expect(result.get("c s plastics")?.get("aaa cooper")).toBe(1);
    });
});