/**
 * @file    src/lib/email-tracking-ingest.test.ts
 * @purpose Tests for the PO-inference fallback logic ported from
 *          tracking-agent.ts into email-tracking-ingest.ts.
 *
 *          These are PURE unit tests — no Gmail, no Postgres, no mocks.
 *          inferPONumberFromRecentPOs() is a deterministic pure function;
 *          every test case validates the pure inference logic against
 *          a known set of recent POs and message content.
 */

import { describe, expect, it } from "vitest";
import { inferPONumberFromRecentPOs } from "./tracking/email-tracking-ingest";

type RecentPO = {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
};

describe("inferPONumberFromRecentPOs (ported from tracking-agent.ts)", () => {
    const recentPOs: RecentPO[] = [
        {
            po_number: "124503",
            vendor_name: "Thirsty Earth",
            created_at: "2026-03-27T19:29:31.000Z",
        },
        {
            po_number: "124600",
            vendor_name: "Example Vendor Inc",
            created_at: "2026-04-01T19:00:00.000Z",
        },
        {
            po_number: "124777",
            vendor_name: "BuildASoil Supplies LLC",
            created_at: "2026-04-10T12:00:00.000Z",
        },
    ];

    const dropshipPOs: RecentPO[] = [
        {
            po_number: "23371057-DropshipPO",
            vendor_name: "AutoPot USA",
            created_at: "2026-04-01T19:00:00.000Z",
        },
        {
            po_number: "23371687-DropshipPO",
            vendor_name: "AutoPot USA",
            created_at: "2026-04-01T19:10:00.000Z",
        },
    ];

    it("returns null when recentPOs is empty", () => {
        const result = inferPONumberFromRecentPOs(
            { subject: "Shipping update", bodySnippet: "", fromEmail: "" },
            [],
        );
        expect(result).toBeNull();
    });

    it("returns null when no vendor name matches the email text at all", () => {
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Your FedEx package has been shipped",
                bodySnippet: "Delivery scheduled for tomorrow",
                fromEmail: "fedex@notifications.fedex.com",
            },
            recentPOs,
        );
        expect(result).toBeNull();
    });

    it("infers PO by matching vendor name from standard vendor email (ShipStation style)", () => {
        // Simulates a ShipStation-originated carrier notification that doesn't
        // include a PO number in the body but does mention the vendor name.
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Your order has been shipped!",
                bodySnippet: "Thank you for your order from Thirsty Earth! Your order was shipped via FedEx Ground.",
                fromEmail: "tracking@shipstation.com",
            },
            recentPOs,
        );
        expect(result).toBe("124503");
    });

    it("infers PO when vendor name appears in the email subject", () => {
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Example Vendor shipping confirmation for order 98765",
                bodySnippet: "Your items have shipped via UPS.",
                fromEmail: "shipping@example-vendor.com",
            },
            recentPOs,
        );
        expect(result).toBe("124600");
    });

    it("prefers non-dropship POs when vendor name matches multiple (dropship tiebreak)", () => {
        // Both dropship POs are from AutoPot USA and would score the same.
        // Since there are multiple top-scoring dropship matches, the function
        // should return null because it can't disambiguate.
        const result = inferPONumberFromRecentPOs(
            {
                subject: "AutoPot USA shipment notification",
                bodySnippet: "Your order from AutoPot USA has shipped via UPS. Tracking: 1Z22YV580360436423",
                fromEmail: "shipping@autopot.com",
            },
            dropshipPOs,
        );
        // Dropship tie at top score, numericHints present (tracking numbers count as 6+ digits),
        // so there's ambiguity — should return null
        expect(result).toBeNull();
    });

    it("matches a single dropship PO when only one exists for that vendor", () => {
        const singleDropship: RecentPO[] = [
            {
                po_number: "23371057-DropshipPO",
                vendor_name: "AutoPot USA",
                created_at: "2026-04-01T19:00:00.000Z",
            },
        ];

        const result = inferPONumberFromRecentPOs(
            {
                subject: "AutoPot USA shipment",
                bodySnippet: "Your order from AutoPot USA shipped.",
                fromEmail: "shipping@autopot.com",
            },
            singleDropship,
        );
        expect(result).toBe("23371057-DropshipPO");
    });

    it("ignores vendor name stop words (inc, llc, ltd, co, etc.) when matching", () => {
        // "Supplies" should still match from "BuildASoil Supplies LLC"
        // even though "LLC" and "Co" are stop words.
        const result = inferPONumberFromRecentPOs(
            {
                subject: "BuildASoil Supplies order shipped",
                bodySnippet: "Your supplies are on the way!",
                fromEmail: "shipping@supplier.com",
            },
            recentPOs,
        );
        expect(result).toBe("124777");
    });

    it("matches via numeric hint when email contains a PO-like number", () => {
        // Email contains "124600" as a 6-digit number — should hit directOrderMatch
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Shipment update for reference 124600",
                bodySnippet: "Carrier: UPS, tracking number 1Z22YV580360436423",
                fromEmail: "carrier@ups.com",
            },
            recentPOs,
        );
        expect(result).toBe("124600");
    });

    it("returns null for FedEx auto-notification with no vendor name or PO reference", () => {
        // Classic FedEx auto-notification — no PO number, no vendor name,
        // just tracking info and delivery date.
        const result = inferPONumberFromRecentPOs(
            {
                subject: "FedEx Delivery Update for Package 874718364184",
                bodySnippet:
                    "Your package is scheduled for delivery on Monday, July 25. " +
                    "Tracking number: 874718364184. No signature required.",
                fromEmail: "fedex@notifications.fedex.com",
            },
            recentPOs,
        );
        expect(result).toBeNull();
    });

    it("handles vendor name appearing in the fromEmail domain reference", () => {
        // The fromEmail contains "thirstyearth" which should match
        // the Thirsty Earth vendor tokens
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Shipping receipt",
                bodySnippet: "Your package has been shipped.",
                fromEmail: "orders@thirstyearth.com",
            },
            recentPOs,
        );
        expect(result).toBe("124503");
    });

    it("scores full vendor name match higher than partial token match", () => {
        // Multiple vendors might share a token ("Earth" appears nowhere),
        // but full name match for "Thirsty Earth" gets +10 bonus
        const ambiguous: RecentPO[] = [
            {
                po_number: "124503",
                vendor_name: "Thirsty Earth Manufacturing Co",
                created_at: "2026-03-27T19:29:31.000Z",
            },
            {
                po_number: "125000",
                vendor_name: "Green Earth Organics LLC",
                created_at: "2026-04-05T12:00:00.000Z",
            },
        ];

        // "Thirsty Earth" in body should score high for PO 124503
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Thirsty Earth shipment",
                bodySnippet: "Your Thirsty Earth Manufacturing order is on the way.",
                fromEmail: "notifications@thirstyearth.com",
            },
            ambiguous,
        );
        expect(result).toBe("124503");
    });
});
