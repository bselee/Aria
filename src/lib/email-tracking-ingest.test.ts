/**
 * @file    src/lib/email-tracking-ingest.test.ts
 * @purpose Tests for the PO-inference fallback in email-tracking-ingest.ts.
 *
 *          DECISION(2026-08-25): inference is now EXACT numeric-PO match only.
 *          Vendor-name token-overlap scoring was removed (PO 125178 magnet —
 *          "Rootwise Soil Dynamics" contains "soil", which matches the
 *          "BuildASoil"/"soil" text in nearly every carrier email, so 567
 *          shipments were guessed onto one PO). These are PURE unit tests —
 *          no Gmail, no Postgres, no mocks.
 */

import { describe, expect, it } from "vitest";
import { inferPONumberFromRecentPOs } from "./tracking/email-tracking-ingest";

type RecentPO = {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
};

describe("inferPONumberFromRecentPOs (exact numeric-PO match only)", () => {
    const recentPOs: RecentPO[] = [
        { po_number: "124503", vendor_name: "Thirsty Earth", created_at: "2026-03-27T19:29:31.000Z" },
        { po_number: "124600", vendor_name: "Example Vendor Inc", created_at: "2026-04-01T19:00:00.000Z" },
        { po_number: "124777", vendor_name: "BuildASoil Supplies LLC", created_at: "2026-04-10T12:00:00.000Z" },
    ];

    it("returns null when recentPOs is empty", () => {
        expect(
            inferPONumberFromRecentPOs({ subject: "Shipping update", bodySnippet: "", fromEmail: "" }, []),
        ).toBeNull();
    });

    it("returns null when no numeric hint matches a PO number", () => {
        expect(
            inferPONumberFromRecentPOs(
                {
                    subject: "Your FedEx package has been shipped",
                    bodySnippet: "Delivery scheduled for tomorrow",
                    fromEmail: "fedex@notifications.fedex.com",
                },
                recentPOs,
            ),
        ).toBeNull();
    });

    it("infers PO when the email contains an exact PO-number reference", () => {
        expect(
            inferPONumberFromRecentPOs(
                {
                    subject: "Shipment update for reference 124600",
                    bodySnippet: "Carrier: UPS, tracking number 1Z22YV580360436423",
                    fromEmail: "carrier@ups.com",
                },
                recentPOs,
            ),
        ).toBe("124600");
    });

    it("returns null for a carrier auto-notification with only a tracking number", () => {
        expect(
            inferPONumberFromRecentPOs(
                {
                    subject: "FedEx Delivery Update for Package 874718364184",
                    bodySnippet: "Tracking number: 874718364184. No signature required.",
                    fromEmail: "fedex@notifications.fedex.com",
                },
                recentPOs,
            ),
        ).toBeNull();
    });

    it("does NOT infer from vendor name alone (magnet regression — PO 125178)", () => {
        // "Rootwise Soil Dynamics" contains "soil", which matches "BuildASoil"
        // text in nearly every carrier email. This must NOT produce a match.
        const rootwise: RecentPO[] = [
            { po_number: "125178", vendor_name: "Rootwise Soil Dynamics", created_at: "2026-08-09T12:00:00.000Z" },
        ];
        expect(
            inferPONumberFromRecentPOs(
                {
                    subject: "Rootwise Soil shipment notification",
                    bodySnippet: "Your Rootwise Soil order is on the way.",
                    fromEmail: "shipping@rootwise.com",
                },
                rootwise,
            ),
        ).toBeNull();
    });

    it("does NOT infer from a ShipStation-style vendor-name-only email", () => {
        expect(
            inferPONumberFromRecentPOs(
                {
                    subject: "Your order has been shipped!",
                    bodySnippet: "Thank you for your order from Thirsty Earth! Shipped via FedEx Ground.",
                    fromEmail: "tracking@shipstation.com",
                },
                recentPOs,
            ),
        ).toBeNull();
    });

    it("exact match disambiguates a suffixed PO number", () => {
            // "124503" exactly matches only the unsuffixed PO; "124503-1" is a
            // distinct number and does not collide on exact equality.
            const ambiguous: RecentPO[] = [
                { po_number: "124503", vendor_name: "A" },
                { po_number: "124503-1", vendor_name: "B" },
            ];
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "ref 124503", bodySnippet: "", fromEmail: "x@y.com" },
                    ambiguous,
                ),
            ).toBe("124503");
        });

        // ── Ambiguous exact matches ──────────────────────────────────────────────

        it("returns null when the numeric hint matches MULTIPLE PO numbers (ambiguous)", () => {
            // Two POs with the same number (shouldn't happen but test the guard).
            const dupes: RecentPO[] = [
                { po_number: "124600", vendor_name: "Vendor A" },
                { po_number: "124600", vendor_name: "Vendor B" },
            ];
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "ref 124600", bodySnippet: "", fromEmail: "x@y.com" },
                    dupes,
                ),
            ).toBeNull();
        });

        // ── Extraction from different email fields ───────────────────────────────

        it("extracts PO number from the subject line only", () => {
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "PO 124600 shipped", bodySnippet: "", fromEmail: "" },
                    recentPOs,
                ),
            ).toBe("124600");
        });

        it("extracts PO number from the body snippet only", () => {
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "Shipping update", bodySnippet: "Order 124600 is on the way.", fromEmail: "" },
                    recentPOs,
                ),
            ).toBe("124600");
        });

        it("extracts PO number from the fromEmail field only", () => {
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "Update", bodySnippet: "Package dispatched.", fromEmail: "124600@vendor.com" },
                    recentPOs,
                ),
            ).toBe("124600");
        });

        // ── 5-digit PO edge case ──────────────────────────────────────────────────

            it("does NOT match a 5-digit PO number (extractNumericHints requires ≥6 digits)", () => {
                // extractNumericHints uses \b\d{6,}\b — 5-digit numbers are intentionally
                // excluded to avoid false matches on zip codes, short references, etc.
                const fiveDigit: RecentPO[] = [
                    { po_number: "12450", vendor_name: "Short PO" },
                ];
                expect(
                    inferPONumberFromRecentPOs(
                        { subject: "ref 12450", bodySnippet: "", fromEmail: "" },
                        fiveDigit,
                    ),
                ).toBeNull();
            });

        it("matches a 7-digit PO number (maximum PO length)", () => {
            const sevenDigit: RecentPO[] = [
                { po_number: "1234567", vendor_name: "Long PO" },
            ];
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "ref 1234567", bodySnippet: "", fromEmail: "" },
                    sevenDigit,
                ),
            ).toBe("1234567");
        });

        // ── Numeric hint that is NOT a PO ─────────────────────────────────────────

        it("does not match a tracking number that happens to contain a PO number substring", () => {
                // "1Z12460012345678" — the \b\d{6,}\b regex sees "12460012345678" as one
                // 14-digit number, not as "124600" + "12345678". So there's no exact
                // match to PO 124600. This is correct: tracking numbers should NOT
                // trigger PO inference via substring.
                expect(
                    inferPONumberFromRecentPOs(
                        {
                            subject: "Tracking 1Z12460012345678",
                            bodySnippet: "",
                            fromEmail: "",
                        },
                        recentPOs,
                    ),
                ).toBeNull();
            });

        it("returns null when numeric hints exist but none match a PO number", () => {
            expect(
                inferPONumberFromRecentPOs(
                    {
                        subject: "Tracking 874718364184",
                        bodySnippet: "Reference 999999999",
                        fromEmail: "x@y.com",
                    },
                    recentPOs,
                ),
            ).toBeNull();
        });

        // ── Null/empty message fields ──────────────────────────────────────────────

        it("handles null/undefined message fields gracefully", () => {
            expect(
                inferPONumberFromRecentPOs(
                    { subject: null, bodySnippet: undefined, fromEmail: null },
                    recentPOs,
                ),
            ).toBeNull();
        });

        it("returns null when all message fields are empty strings", () => {
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "", bodySnippet: "", fromEmail: "" },
                    recentPOs,
                ),
            ).toBeNull();
        });

        // ── Multiple numeric hints ────────────────────────────────────────────────

        it("matches when multiple numeric hints exist but only one matches a PO", () => {
            expect(
                inferPONumberFromRecentPOs(
                    {
                        subject: "Ref 999999 and 124600",
                        bodySnippet: "Also tracking 874718364184",
                        fromEmail: "x@y.com",
                    },
                    recentPOs,
                ),
            ).toBe("124600");
        });

        // ── Case insensitivity ─────────────────────────────────────────────────────

        it("matches PO number case-insensitively", () => {
            // PO numbers are numeric, but the hint extraction is case-insensitive.
            // "124600" should match regardless of surrounding case.
            expect(
                inferPONumberFromRecentPOs(
                    { subject: "PO #124600", bodySnippet: "", fromEmail: "" },
                    recentPOs,
                ),
            ).toBe("124600");
        });
    });
