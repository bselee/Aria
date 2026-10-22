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
import { extractPONumbersFromText, inferPONumberFromRecentPOs, detectDocumentaryDelivery, vendorDeliveryAnnotationAllowed, vendorNameForUpsert } from "./tracking/email-tracking-ingest";

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

describe("inferPONumberFromRecentPOs (Guard 10 — vendor-scoped inference)", () => {
    const mixedPOs: RecentPO[] = [
        { po_number: "125377", vendor_name: "New Moon Development Co", created_at: "2026-10-19T00:00:00.000Z" },
        { po_number: "125423", vendor_name: "Rootwise Soil Dynamics", created_at: "2026-10-20T00:00:00.000Z" },
    ];

    it("scopes inference to the resolved sender vendor (single open PO)", () => {
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Your shipment is on its way!",
                bodySnippet: "Build A Soil order shipped.",
                fromEmail: "ship@pirateship.com",
            },
            mixedPOs,
            "New Moon Development Co",
        );
        expect(result).toBe("125377");
    });

    it("never surfaces an unrelated vendor's PO when sender resolves to another vendor", () => {
        // "soil" in "Build A Soil" weakly matches Rootwise Soil Dynamics, but
        // scoping to New Moon must not reach Rootwise's PO.
        const result = inferPONumberFromRecentPOs(
            { subject: "Your shipment is on its way!", bodySnippet: "", fromEmail: "ship@pirateship.com" },
            mixedPOs,
            "New Moon Development Co",
        );
        expect(result).toBe("125377");
    });

    it("returns null when the resolved sender vendor has no open PO", () => {
        const result = inferPONumberFromRecentPOs(
            { subject: "Your shipment is on its way!", bodySnippet: "", fromEmail: "ship@pirateship.com" },
            mixedPOs,
            "Liberty Natural Products",
        );
        expect(result).toBeNull();
    });

    it("requires text match when the resolved vendor has multiple open POs", () => {
        const twoNewMoon: RecentPO[] = [
            { po_number: "125377", vendor_name: "New Moon Development Co", created_at: "2026-10-19T00:00:00.000Z" },
            { po_number: "125399", vendor_name: "New Moon Development Co", created_at: "2026-10-20T00:00:00.000Z" },
        ];
        const result = inferPONumberFromRecentPOs(
            { subject: "Your shipment is on its way!", bodySnippet: "", fromEmail: "ship@pirateship.com" },
            twoNewMoon,
            "New Moon Development Co",
        );
        expect(result).toBeNull();
    });

    it("leaves unresolved 3PL senders unlinked instead of guessing via a weak token (PirateShip → Rootwise)", () => {
        // No resolved vendor, generic 3PL sender, only a weak "soil" token match
        // against "Rootwise Soil Dynamics" → must NOT infer 125423.
        const result = inferPONumberFromRecentPOs(
            { subject: "Your shipment is on its way!", bodySnippet: "Build A Soil", fromEmail: "ship@pirateship.com" },
            mixedPOs,
        );
        expect(result).toBeNull();
    });

    it("still infers a named vendor from a 3PL sender (full name match)", () => {
        const result = inferPONumberFromRecentPOs(
            {
                subject: "Your shipment is on its way!",
                bodySnippet: "Your order from Rootwise Soil Dynamics shipped.",
                fromEmail: "ship@pirateship.com",
            },
            mixedPOs,
        );
        expect(result).toBe("125423");
    });
});

describe("extractPONumbersFromText (label-bounded, Guard 9)", () => {
    it("extracts a number adjacent to a PO / P.O. / Purchase Order label", () => {
        expect(extractPONumbersFromText("PO-125333")).toEqual(["125333"]);
        expect(extractPONumbersFromText("PO #124833")).toEqual(["124833"]);
        expect(extractPONumbersFromText("PO 125376")).toEqual(["125376"]);
        expect(extractPONumbersFromText("P.O.#: 125213")).toEqual(["125213"]);
        expect(extractPONumbersFromText("Purchase Order # 125376")).toEqual(["125376"]);
        expect(extractPONumbersFromText("PO NUMBER: 125224")).toEqual(["125224"]);
    });

    it("Certis POD: keeps PO-125333, rejects the SKU# line", () => {
        const pdf = "4     DR     PO-125333     2,530\n             SKU# 154250";
        expect(extractPONumbersFromText(pdf)).toEqual(["125333"]);
    });

    it("rejects counterparty labels (SKU#, SO#, Sales Order, Order #, order, Cust. Ref., ESTIMATE)", () => {
        expect(extractPONumbersFromText("SKU# 154250")).toEqual([]);
        expect(extractPONumbersFromText("SO# 80720")).toEqual([]);
        expect(extractPONumbersFromText("Sales Order # 80720")).toEqual([]);
        expect(extractPONumbersFromText("Order # 21909")).toEqual([]);
        expect(extractPONumbersFromText("order 80263")).toEqual([]);
        expect(extractPONumbersFromText("Cust. Ref.: 478712")).toEqual([]);
        expect(extractPONumbersFromText("ESTIMATE NUMBER: 269303167-1")).toEqual([]);
    });

    it("FedEx billing block: keeps P.O.# but not Cust. Ref.", () => {
        const block = "Ship Date: Aug 26, 2026   Cust. Ref.: 478712        P.O.#: 125213";
        expect(extractPONumbersFromText(block)).toEqual(["125213"]);
    });

    it("rejects bare invoice/order numbers that carry no PO label", () => {
        expect(extractPONumbersFromText("invoice #130648")).toEqual([]);
        expect(extractPONumbersFromText("Invoice 149915")).toEqual([]);
    });
});

describe("detectDocumentaryDelivery (Guard 11 — POD/BOL delivery reconciliation)", () => {
    it("Certis POD: DELIVERY STATUS Good Order + delivered date", () => {
        const pdf = "DELIVERY STATUS: Good Order\nDelivered: 09/25/2026";
        const result = detectDocumentaryDelivery(pdf);
        expect(result?.signal).toBe("pod_delivery_status");
        expect(result?.terminal).toBe(true);
        expect(result?.deliveredAt).toMatch(/^2026-09-25T/);
        expect(result?.note).toContain("Sep 25, 2026");
    });

    it("BOL signature line proves delivery", () => {
        const pdf = "Received in good order by M. Smith on 10/12/2026";
        const result = detectDocumentaryDelivery(pdf);
        expect(result?.signal).toBe("bol_signature");
        expect(result?.terminal).toBe(true);
        expect(result?.deliveredAt).toMatch(/^2026-10-12T/);
    });

    it("vendor 'delivered on' email is annotation-only (not terminal)", () => {
        const body = "Your order was delivered on September 25, 2026.";
        const result = detectDocumentaryDelivery(body);
        expect(result?.signal).toBe("vendor_delivered_email");
        expect(result?.terminal).toBe(false);
        expect(result?.deliveredAt).toMatch(/^2026-09-25T/);
    });

    it("accepts a real POD even when it prints an RMA return note (local veto, not whole-doc)", () => {
        const pdf = "DELIVERY STATUS: Good Order / Delivered 9/25/26 / Note: returns to be shipped back via RMA 4412";
        const result = detectDocumentaryDelivery(pdf);
        expect(result?.signal).toBe("pod_delivery_status");
        expect(result?.terminal).toBe(true);
        expect(result?.deliveredAt).toMatch(/^2026-09-25T/);
    });

    it("rejects a future delivery date even with no future/negation term (requirement a)", () => {
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        const iso = [
            tomorrow.getUTCFullYear(),
            String(tomorrow.getUTCMonth() + 1).padStart(2, "0"),
            String(tomorrow.getUTCDate()).padStart(2, "0"),
        ].join("-");
        expect(detectDocumentaryDelivery(`Delivered on ${iso}`)).toBeNull();
    });

    it("rejects the adversarial in-flight strings (aria-purchasing battery)", () => {
        const negatives = [
            "Your order was received by our team on 10/20/2026 and is being prepared.",
            "Your order has been received by our production team on 10/20/26.",
            "Thanks, we received by phone on 10/20/2026 and will follow up.",
            "Your package will be delivered on 10/23/2026 between 9am and 12pm.",
            "Your UPS package is scheduled to be delivered on Friday, October 23, 2026.",
            "Delivered on time, every time — shipped 10/21/2026.",
            "Estimated delivery: delivered on the second attempt, 10/21/2026",
        ];
        for (const text of negatives) {
            expect(detectDocumentaryDelivery(text)).toBeNull();
        }
    });

    it("NEVER reads future-shipping language as a delivery", () => {
        expect(detectDocumentaryDelivery("Your order will ship on 10/21")).toBeNull();
        expect(detectDocumentaryDelivery("Shipping on 10/21 — tracking to follow")).toBeNull();
        expect(detectDocumentaryDelivery("will be shipped next week")).toBeNull();
    });

    it("plain shipping notice is not a delivery", () => {
        expect(detectDocumentaryDelivery("Your shipment is on its way!")).toBeNull();
        expect(detectDocumentaryDelivery("Your order has shipped")).toBeNull();
    });

    it("returns null when a delivery signal has no date", () => {
        expect(detectDocumentaryDelivery("DELIVERY STATUS: Good Order")).toBeNull();
    });

    it("ignores a bare ship date that is not a delivery date", () => {
        expect(detectDocumentaryDelivery("Ship Date: Aug 26, 2026\nDELIVERY STATUS: Good Order")).toBeNull();
    });
});

describe("vendorDeliveryAnnotationAllowed (Guard 11 #5 — sender→vendor gate)", () => {
    it("rejects an unresolvable sender (no vendor)", () => {
        expect(vendorDeliveryAnnotationAllowed(null, [])).toBe(false);
        expect(vendorDeliveryAnnotationAllowed(undefined, [])).toBe(false);
        expect(vendorDeliveryAnnotationAllowed("", [])).toBe(false);
    });

    it("accepts any resolved vendor for a brand-new row", () => {
        expect(vendorDeliveryAnnotationAllowed("Certis USA", [])).toBe(true);
    });

    it("accepts when the resolved vendor matches an existing vendor name", () => {
        expect(vendorDeliveryAnnotationAllowed("Certis USA", ["Certis USA"])).toBe(true);
    });

    it("accepts a normalized token-overlap match", () => {
        expect(
            vendorDeliveryAnnotationAllowed("New Moon Development Co", ["New Moon Development Company"]),
        ).toBe(true);
    });

    it("rejects when the resolved vendor conflicts with an existing vendor name", () => {
        expect(
            vendorDeliveryAnnotationAllowed("Certis USA", ["Liberty Natural Products"]),
        ).toBe(false);
    });
});

describe("vendorNameForUpsert (Guard 11 #6 — vendor-name hygiene)", () => {
    it("returns null for PO-attributed rows (vendor comes from the PO)", () => {
        expect(vendorNameForUpsert("125333", "Certis USA", [])).toBeNull();
    });

    it("returns null when no vendor is resolved", () => {
        expect(vendorNameForUpsert(null, null, [])).toBeNull();
        expect(vendorNameForUpsert(null, "", [])).toBeNull();
    });

    it("keeps resolvedVendor as provenance for a brand-new row", () => {
        expect(vendorNameForUpsert(null, "Certis USA", [])).toBe("Certis USA");
    });

    it("keeps resolvedVendor when it matches an existing vendor name", () => {
        expect(vendorNameForUpsert(null, "Certis USA", ["Certis USA"])).toBe("Certis USA");
        expect(
            vendorNameForUpsert(null, "New Moon Development Co", ["New Moon Development Company"]),
        ).toBe("New Moon Development Co");
    });

    it("returns null when the resolved vendor conflicts with an existing row (no append)", () => {
        expect(
            vendorNameForUpsert(null, "Certis USA", ["Liberty Natural Products"]),
        ).toBeNull();
    });
});
