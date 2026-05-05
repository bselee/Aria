import { describe, expect, it } from "vitest";

import { deriveVendorEtaProfile } from "./vendor-eta-profile";

describe("deriveVendorEtaProfile", () => {
    it("uses live tracking ETA ahead of vendor patterns", () => {
        const eta = deriveVendorEtaProfile({
            vendorName: "ULINE",
            orderDate: "2026-05-01",
            fallbackLeadDays: 14,
            fallbackLabel: "14d default",
            shipments: [{
                estimated_delivery_at: "2026-05-04T18:00:00.000Z",
                delivered_at: null,
                created_at: "2026-05-02T10:00:00.000Z",
            }],
        });

        expect(eta.expectedDate).toBe("2026-05-04");
        expect(eta.source).toBe("tracking_eta");
        expect(eta.confidence).toBe("high");
    });

    it("uses ULINE Friday to Tuesday weekday pattern when no live ETA exists", () => {
        const eta = deriveVendorEtaProfile({
            vendorName: "ULINE",
            orderDate: "2026-05-01",
            fallbackLeadDays: 14,
            fallbackLabel: "14d default",
            shipments: [],
        });

        expect(eta.expectedDate).toBe("2026-05-05");
        expect(eta.source).toBe("vendor_weekday_pattern");
        expect(eta.confidence).toBe("high");
        expect(eta.label).toContain("Fri -> Tue");
    });

    it("uses vendor acknowledgement ETA when present", () => {
        const eta = deriveVendorEtaProfile({
            vendorName: "Axiom Print",
            orderDate: "2026-05-01",
            fallbackLeadDays: 14,
            fallbackLabel: "14d default",
            vendorPromisedEta: "2026-05-11T12:00:00.000Z",
            shipments: [],
        });

        expect(eta.expectedDate).toBe("2026-05-11");
        expect(eta.source).toBe("vendor_reply_eta");
        expect(eta.confidence).toBe("medium");
    });

    it("falls back to vendor median history when no direct signal exists", () => {
        const eta = deriveVendorEtaProfile({
            vendorName: "Axiom Print",
            orderDate: "2026-05-01",
            fallbackLeadDays: 9,
            fallbackLabel: "9d median - vendor history",
            fallbackSource: "vendor_median",
            shipments: [],
        });

        expect(eta.expectedDate).toBe("2026-05-10");
        expect(eta.source).toBe("vendor_median");
        expect(eta.confidence).toBe("medium");
    });
});
