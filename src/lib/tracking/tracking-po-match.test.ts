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
});
