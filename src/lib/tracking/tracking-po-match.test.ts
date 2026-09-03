/**
 * @file    src/lib/tracking/tracking-po-match.test.ts
 * @purpose Tests for the carrier-aware tracking→PO matcher and the
 *          vendor→carrier correlation. Pure unit tests — no DB, no Gmail.
 * @author  Hermia
 * @created 2026-08-25
 */

import { describe, expect, it } from "vitest";
import {
    carrierFromTrackingNumber,
    carrierMatchesVendor,
    carrierRejectedForVendor,
    type VendorCarrierCounts,
} from "./vendor-carrier";
import { matchTrackingToPo, type TrackingPoCandidate } from "./tracking-po-match";

describe("carrierMatchesVendor", () => {
    it("allows a known vendor+carrier pair (Rootwise → FedEx)", () => {
        expect(carrierMatchesVendor("Rootwise Soil Dynamics", "FedEx")).toBe("allow");
    });

    it("rejects a known contradiction (Rootwise × Oak Harbor)", () => {
        expect(carrierMatchesVendor("Rootwise", "Oak Harbor Freight Lines")).toBe("reject");
        expect(carrierRejectedForVendor("Rootwise", "Oak Harbor Freight Lines")).toBe(true);
    });

    it("returns unknown for a vendor with no known carriers", () => {
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx")).toBe("unknown");
    });

    it("rejects via the learned map when a vendor has ≥2 samples of a different carrier", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 3]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("reject");
    });

    it("does NOT reject from a single learned sample (conservative)", () => {
        const learned: VendorCarrierCounts = new Map([
            ["mystery vendor", new Map([["oak harbor", 1]])],
        ]);
        expect(carrierMatchesVendor("Mystery Vendor", "FedEx", learned)).toBe("unknown");
    });
});

describe("carrierFromTrackingNumber", () => {
    it("extracts the carrier from an encoded tracking string", () => {
        expect(carrierFromTrackingNumber("FedEx:::383269682926")).toBe("fedex");
        expect(carrierFromTrackingNumber("Oak Harbor Freight Lines:::56177295394")).toBe("oak harbor freight lines");
    });

    it("returns null for a bare number", () => {
        expect(carrierFromTrackingNumber("383269682926")).toBeNull();
    });
});

describe("matchTrackingToPo", () => {
    const openRootwise: TrackingPoCandidate = {
        po_number: "125180",
        vendor_name: "Rootwise Soil Dynamics",
        created_at: "2026-08-15T12:00:00.000Z",
        lifecycle_state: "ORDER_LOCKED",
    };

    it("matches a Rootwise PO when the email names Rootwise and carrier is FedEx", () => {
        const result = matchTrackingToPo({
            text: "Your order from Rootwise Soil Dynamics has shipped via FedEx Ground.",
            carrier: "FedEx",
            recentPOs: [openRootwise],
        });
        expect(result).toBe("125180");
    });

    it("rejects a Rootwise PO when the carrier is Oak Harbor (magnet regression)", () => {
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipment pickup confirmed.",
            carrier: "Oak Harbor Freight Lines",
            recentPOs: [openRootwise],
        });
        expect(result).toBeNull();
    });

    it("does NOT match on the 'soil' token alone (magnet regression)", () => {
        // "soil" is in "Rootwise Soil Dynamics" AND in "BuildASoil" — must not match.
        const result = matchTrackingToPo({
            text: "BuildASoil shipment update: soil products on the way.",
            carrier: "FedEx",
            recentPOs: [openRootwise],
        });
        expect(result).toBeNull();
    });

    it("never attaches to an already-received PO (open-only)", () => {
        const receivedRootwise: TrackingPoCandidate = {
            ...openRootwise,
            po_number: "125178",
            lifecycle_state: "RECEIVED",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [receivedRootwise],
        });
        expect(result).toBeNull();
    });

    it("picks the most recent open PO when several match", () => {
        const older: TrackingPoCandidate = {
            ...openRootwise,
            po_number: "125170",
            created_at: "2026-08-05T12:00:00.000Z",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [older, openRootwise],
        });
        expect(result).toBe("125180");
    });

    it("disambiguates by lead-time window when lead times are known", () => {
        // now=08-20, lead time 5d → expected order 08-15. "closer" (08-14, 1d off)
        // beats "tooOld" (08-10, 5d off) even though "tooOld" is older.
        const leadTimeDays = new Map([["rootwise soil dynamics", 5]]);
        const tooOld: TrackingPoCandidate = {
            ...openRootwise, po_number: "125170", created_at: "2026-08-10T12:00:00.000Z",
        };
        const closer: TrackingPoCandidate = {
            ...openRootwise, po_number: "125185", created_at: "2026-08-14T12:00:00.000Z",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [tooOld, closer],
            leadTimeDays,
            now: "2026-08-20T00:00:00.000Z",
        });
        expect(result).toBe("125185");
    });

    it("rejects via the learned carrier map for a non-seed vendor", () => {
        const learned = new Map([
            ["mystery vendor", new Map([["oak harbor", 3]])],
        ]);
        const po: TrackingPoCandidate = {
            po_number: "100200",
            vendor_name: "Mystery Vendor",
            created_at: "2026-08-15T12:00:00.000Z",
            lifecycle_state: "ORDER_LOCKED",
        };
        const result = matchTrackingToPo({
            text: "Your order from Mystery Vendor has shipped.",
            carrier: "FedEx",
            recentPOs: [po],
            learnedCarriers: learned,
        });
        expect(result).toBeNull();
    });

    it("returns null when no vendor matches the text", () => {
        const result = matchTrackingToPo({
            text: "Your package is on the way.",
            carrier: "FedEx",
            recentPOs: [openRootwise],
        });
        expect(result).toBeNull();
    });

    it("returns null when recentPOs is empty", () => {
        const result = matchTrackingToPo({
            text: "Rootwise shipment notification",
            carrier: "FedEx",
            recentPOs: [],
        });
        expect(result).toBeNull();
    });

    // ── Learned-carrier allow path ──────────────────────────────────────────

    it("allows a non-seed vendor when the learned map confirms the carrier", () => {
        const learned = new Map([
            ["mystery vendor", new Map([["fedex", 2]])],
        ]);
        const po: TrackingPoCandidate = {
            po_number: "100200",
            vendor_name: "Mystery Vendor",
            created_at: "2026-08-15T12:00:00.000Z",
            lifecycle_state: "ORDER_LOCKED",
        };
        const result = matchTrackingToPo({
            text: "Your order from Mystery Vendor has shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [po],
            learnedCarriers: learned,
        });
        expect(result).toBe("100200");
    });

    // ── All-rejected multi-PO ────────────────────────────────────────────────

    it("returns null when every open PO fails carrier validation", () => {
        // Two Rootwise POs, but carrier is Oak Harbor → both rejected.
        const po1 = { ...openRootwise, po_number: "125180" };
        const po2 = { ...openRootwise, po_number: "125185", created_at: "2026-08-16T12:00:00.000Z" };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipment via Oak Harbor.",
            carrier: "Oak Harbor Freight Lines",
            recentPOs: [po1, po2],
        });
        expect(result).toBeNull();
    });

    // ── now default (Date.now) ──────────────────────────────────────────────

    it("defaults `now` to Date.now() when not provided", () => {
        // Without `now`, the date-window path uses the current time. Two POs with
        // different created_at; the function should still return a valid PO number
        // (not crash and not return null since both are open Rootwise + FedEx).
        const older: TrackingPoCandidate = {
            ...openRootwise, po_number: "125170", created_at: "2020-01-01T12:00:00.000Z",
        };
        const newer: TrackingPoCandidate = {
            ...openRootwise, po_number: "125180", created_at: "2026-08-15T12:00:00.000Z",
        };
        const leadTimeDays = new Map([[normalizeCarrierForTest("Rootwise Soil Dynamics"), 5]]);
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [older, newer],
            leadTimeDays,
        });
        // With now=Date.now() (≈2026-08-26), expected order ≈ 2026-08-21.
        // newer (08-15) is closer than older (2020-01-01) → 125180 wins.
        expect(result).toBe("125180");
    });

    // ── null/missing created_at in date-window ───────────────────────────────

    it("falls back to most-recent when lead time is known but created_at is missing", () => {
        const noDate: TrackingPoCandidate = {
            ...openRootwise, po_number: "125190", created_at: null,
        };
        const withDate: TrackingPoCandidate = {
            ...openRootwise, po_number: "125180", created_at: "2026-08-15T12:00:00.000Z",
        };
        const leadTimeDays = new Map([[normalizeCarrierForTest("Rootwise Soil Dynamics"), 5]]);
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [noDate, withDate],
            leadTimeDays,
            now: "2026-08-20T00:00:00.000Z",
        });
        // noDate has orderDate=0 (not finite) → excluded from dateScored.
        // withDate is finite → wins by default (only finite entry).
        expect(result).toBe("125180");
    });

    it("falls back to most-recent when lead time map is null", () => {
        const older: TrackingPoCandidate = {
            ...openRootwise, po_number: "125170", created_at: "2026-08-05T12:00:00.000Z",
        };
        const newer: TrackingPoCandidate = {
            ...openRootwise, po_number: "125180", created_at: "2026-08-15T12:00:00.000Z",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [older, newer],
            leadTimeDays: null,
        });
        expect(result).toBe("125180");
    });

    // ── Vendor name matching edge cases ───────────────────────────────────────

    it("matches on full vendor name as substring (≥5 chars)", () => {
        const result = matchTrackingToPo({
            text: "Shipment from ULINE warehouse. UPS tracking attached.",
            carrier: "UPS",
            recentPOs: [{
                po_number: "125200",
                vendor_name: "ULINE",
                created_at: "2026-08-20T12:00:00.000Z",
                lifecycle_state: "ORDER_LOCKED",
            }],
        });
        expect(result).toBe("125200");
    });

    it("does not match on a single distinctive token (<2 tokens and not full-name substring)", () => {
        // "BuildASoil" is a common word → filtered. Only one token "thirsty" from
        // "Thirsty Earth" → not enough for a match (need ≥2 distinctive tokens).
        const result = matchTrackingToPo({
            text: "BuildASoil order update — thirsty products incoming.",
            carrier: "Oak Harbor",
            recentPOs: [{
                po_number: "125300",
                vendor_name: "Thirsty Earth",
                created_at: "2026-08-20T12:00:00.000Z",
                lifecycle_state: "ORDER_LOCKED",
            }],
        });
        expect(result).toBeNull();
    });

    it("matches on ≥2 distinctive tokens (Thirsty Earth)", () => {
        const result = matchTrackingToPo({
            text: "Your Thirsty Earth order has shipped via Oak Harbor Freight.",
            carrier: "Oak Harbor Freight Lines",
            recentPOs: [{
                po_number: "125300",
                vendor_name: "Thirsty Earth",
                created_at: "2026-08-20T12:00:00.000Z",
                lifecycle_state: "ORDER_LOCKED",
            }],
        });
        expect(result).toBe("125300");
    });

    // ── carrier is null ──────────────────────────────────────────────────────

    it("skips carrier validation when carrier is null (vendor-only match)", () => {
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipment confirmed.",
            carrier: null,
            recentPOs: [openRootwise],
        });
        expect(result).toBe("125180");
    });

    // ── Multiple closed states ─────────────────────────────────────────────────

    it("excludes received, completed, and order_completed POs", () => {
        const received: TrackingPoCandidate = {
            ...openRootwise, po_number: "125001", lifecycle_state: "RECEIVED",
        };
        const completed: TrackingPoCandidate = {
            ...openRootwise, po_number: "125002", lifecycle_state: "COMPLETED",
        };
        const orderCompleted: TrackingPoCandidate = {
            ...openRootwise, po_number: "125003", lifecycle_state: "ORDER_COMPLETED",
        };
        const open1: TrackingPoCandidate = {
            ...openRootwise, po_number: "125180",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [received, completed, orderCompleted, open1],
        });
        expect(result).toBe("125180");
    });

    // ── lead-time window: closer wins over older ───────────────────────────────

    it("date-window picks the PO closest to (now − leadTime), not the most recent", () => {
        const leadTimeDays = new Map([[normalizeCarrierForTest("Rootwise Soil Dynamics"), 10]]);
        // now = 2026-08-25, lead 10d → expected order ≈ 2026-08-15
        const exact: TrackingPoCandidate = {
            ...openRootwise, po_number: "125185", created_at: "2026-08-15T12:00:00.000Z",
        };
        const tooRecent: TrackingPoCandidate = {
            ...openRootwise, po_number: "125190", created_at: "2026-08-22T12:00:00.000Z",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [exact, tooRecent],
            leadTimeDays,
            now: "2026-08-25T00:00:00.000Z",
        });
        // exact (08-15, 0 days off) beats tooRecent (08-22, 7 days off)
        expect(result).toBe("125185");
    });

    it("date-window score correctly orders three candidates", () => {
        const leadTimeDays = new Map([[normalizeCarrierForTest("Rootwise Soil Dynamics"), 7]]);
        // now = 2026-08-21, lead 7d → expected ≈ 2026-08-14
        const best: TrackingPoCandidate = {
            ...openRootwise, po_number: "125184", created_at: "2026-08-14T00:00:00.000Z",
        };
        const mid: TrackingPoCandidate = {
            ...openRootwise, po_number: "125170", created_at: "2026-08-10T00:00:00.000Z",
        };
        const worst: TrackingPoCandidate = {
            ...openRootwise, po_number: "125160", created_at: "2026-08-01T00:00:00.000Z",
        };
        const result = matchTrackingToPo({
            text: "Rootwise Soil Dynamics shipped via FedEx.",
            carrier: "FedEx",
            recentPOs: [worst, mid, best],
            leadTimeDays,
            now: "2026-08-21T00:00:00.000Z",
        });
        expect(result).toBe("125184");
    });
});

// Helper: re-normalize vendor name the same way the matcher does internally.
// Used in tests that need to build the leadTimeDays map with the correct key.
function normalizeCarrierForTest(name: string): string {
    return String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
