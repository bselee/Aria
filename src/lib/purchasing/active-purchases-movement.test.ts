import { describe, expect, it } from "vitest";

import {
    deriveInvoiceMovementState,
    derivePurchaseMovement,
    type MovementShipmentInput,
} from "./active-purchases-movement";

function makeShipment(overrides: Partial<MovementShipmentInput> = {}): MovementShipmentInput {
    return {
        tracking_number: "123456789012",
        public_tracking_url: "https://www.fedex.com/fedextrack/?tracknumbers=123456789012",
        carrier_name: "FedEx",
        status_category: "in_transit",
        estimated_delivery_at: "2026-04-03T17:00:00.000Z",
        last_checked_at: "2026-04-02T14:00:00.000Z",
        last_source: "carrier_poll",
        source_refs: [{ source: "carrier_poll", seenAt: "2026-04-02T14:00:00.000Z" }],
        evidenceLevel: "confirmed",
        ...overrides,
    };
}

describe("deriveInvoiceMovementState", () => {
    it("maps paid-ish statuses to paid", () => {
        for (const status of ["matched_approved", "reconciled", "approved", "paid"]) {
            expect(deriveInvoiceMovementState({ invoiceStatus: status })).toBe("paid");
        }
    });

    it("maps explicit matched status to matched", () => {
        expect(deriveInvoiceMovementState({ invoiceStatus: "matched" })).toBe("matched");
    });

    it("maps review/queue statuses to pending_ap", () => {
        for (const status of ["matched_review", "received", "pending"]) {
            expect(deriveInvoiceMovementState({ invoiceStatus: status })).toBe("pending_ap");
        }
    });

    it("flags discrepancies over paid status", () => {
        expect(deriveInvoiceMovementState({ invoiceStatus: "matched_approved", hasDiscrepancies: true })).toBe("discrepancy");
    });

    it("is none when there is no invoice", () => {
        expect(deriveInvoiceMovementState({})).toBe("none");
    });
});

describe("derivePurchaseMovement", () => {
    it("PO with confirmed in-transit shipment + paid invoice → in_transit + paid + primary fields", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment()],
            legacyTrackingNumbers: [],
            invoiceStatus: "matched_approved",
            invoiceId: "INV-42",
            now: "2026-04-02T15:00:00.000Z",
        });

        expect(movement.status).toBe("in_transit");
        expect(movement.evidenceLevel).toBe("confirmed");
        expect(movement.trackingNumbers).toEqual(["123456789012"]);
        expect(movement.primaryEta).toBe("2026-04-03T17:00:00.000Z");
        expect(movement.primaryCarrier).toBe("FedEx");
        expect(movement.primaryUrl).toBe("https://www.fedex.com/fedextrack/?tracknumbers=123456789012");
        expect(movement.invoice.state).toBe("paid");
        expect(movement.invoice.invoiceId).toBe("INV-42");
        expect(movement.invoice.hasTrackingFromInvoice).toBe(false);
        expect(movement.correlation.poLinkedShipmentCount).toBe(1);
        expect(movement.correlation.orphanTrackingCount).toBe(0);
        expect(movement.correlation.lastSource).toBe("carrier_poll");
    });

    it("candidate-only evidence → amber candidate, no invoice badge", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    status_category: null,
                    status_display: null,
                    last_checked_at: null,
                    evidenceLevel: "candidate",
                    source_refs: [{ source: "email_ingest", seenAt: "2026-04-02T13:00:00.000Z", confidence: 0.55 }],
                    last_source: "email_ingest",
                }),
            ],
            legacyTrackingNumbers: [],
        });

        expect(movement.status).toBe("candidate");
        expect(movement.evidenceLevel).toBe("candidate");
        expect(movement.invoice.state).toBe("none");
        expect(movement.primaryUrl).toBeTruthy(); // still linkable via carrierUrl fallback
    });

    it("all confirmed delivered → delivered + 24h/48h receipt lag", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    status_category: "delivered",
                    delivered_at: "2026-04-03T12:00:00.000Z",
                    estimated_delivery_at: null,
                }),
            ],
            legacyTrackingNumbers: [],
            isReceived: false,
            now: "2026-04-05T12:00:00.000Z", // 48h later
        });

        expect(movement.status).toBe("delivered");
        expect(movement.hoursSinceDelivered).toBe(48);
        expect(movement.receiptLag).toBe("escalate");
        expect(movement.receiptLagLabel).toMatch(/OVERDUE receive/i);
    });

    it("delivered <24h stays receiptLag ok", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    status_category: "delivered",
                    delivered_at: "2026-04-05T06:00:00.000Z",
                    estimated_delivery_at: null,
                }),
            ],
            legacyTrackingNumbers: [],
            isReceived: false,
            now: "2026-04-05T12:00:00.000Z", // 6h
        });

        expect(movement.receiptLag).toBe("ok");
        expect(movement.receiptLagLabel).toMatch(/need receive/i);
    });

    it("delivered + isReceived clears lag", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    status_category: "delivered",
                    delivered_at: "2026-04-01T12:00:00.000Z",
                    estimated_delivery_at: null,
                }),
            ],
            legacyTrackingNumbers: [],
            isReceived: true,
            now: "2026-04-05T12:00:00.000Z",
        });

        expect(movement.receiptLag).toBe("ok");
        expect(movement.receiptLagLabel).toBeNull();
    });

    it("exception shipment → exception", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ status_category: "exception" })],
            legacyTrackingNumbers: [],
        });

        expect(movement.status).toBe("exception");
    });

    it("out_for_delivery shipment → out_for_delivery", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ status_category: "out_for_delivery" })],
            legacyTrackingNumbers: [],
        });

        expect(movement.status).toBe("out_for_delivery");
    });

    it("stale when every non-delivered shipment was checked >24h ago", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ last_checked_at: "2026-04-02T14:00:00.000Z" })],
            legacyTrackingNumbers: [],
            now: "2026-04-05T00:00:00.000Z",
        });

        expect(movement.status).toBe("stale");
    });

    it("never-checked confirmed shipment counts as stale", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ last_checked_at: null })],
            legacyTrackingNumbers: [],
            now: "2026-04-05T00:00:00.000Z",
        });

        expect(movement.status).toBe("stale");
    });

    it("recently checked in-transit shipment stays in_transit", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ last_checked_at: "2026-04-05T00:30:00.000Z" })],
            legacyTrackingNumbers: [],
            now: "2026-04-05T01:00:00.000Z",
        });

        expect(movement.status).toBe("in_transit");
    });

    it("invoice-embedded tracking (ap_invoice) is flagged, discrepancy overrides paid", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    last_source: "ap_invoice",
                    source_refs: [{ source: "ap_invoice", seenAt: "2026-04-02T13:00:00.000Z" }],
                }),
            ],
            legacyTrackingNumbers: [],
            invoiceStatus: "matched_approved",
            hasDiscrepancies: true,
        });

        expect(movement.invoice.hasTrackingFromInvoice).toBe(true);
        expect(movement.invoice.state).toBe("discrepancy");
    });

    it("legacy tracking numbers follow confirmed shipments and count as orphans", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ tracking_number: "1Z999AA10123456784" })],
            legacyTrackingNumbers: ["1Z999AA10123456784", "9400111899223197491234"],
        });

        expect(movement.trackingNumbers).toEqual(["1Z999AA10123456784", "9400111899223197491234"]);
        expect(movement.correlation.orphanTrackingCount).toBe(1);
        expect(movement.correlation.poLinkedShipmentCount).toBe(1);
    });

    it("no shipments and no tracking → none / empty story", () => {
        const movement = derivePurchaseMovement({
            shipments: [],
            legacyTrackingNumbers: [],
        });

        expect(movement.status).toBe("none");
        expect(movement.evidenceLevel).toBe("none");
        expect(movement.trackingNumbers).toEqual([]);
        expect(movement.primaryEta).toBeNull();
        expect(movement.primaryUrl).toBeNull();
        expect(movement.invoice.state).toBe("none");
        expect(movement.correlation.lastSource).toBeNull();
    });

    it("lastSource comes from the newest source_ref across shipments", () => {
        const movement = derivePurchaseMovement({
            shipments: [
                makeShipment({
                    tracking_number: "A",
                    source_refs: [{ source: "email_ingest_pdf", seenAt: "2026-04-01T09:00:00.000Z" }],
                    last_source: "email_ingest_pdf",
                }),
                makeShipment({
                    tracking_number: "B",
                    source_refs: [{ source: "carrier_poll", seenAt: "2026-04-02T10:00:00.000Z" }],
                    last_source: "carrier_poll",
                }),
            ],
            legacyTrackingNumbers: [],
        });

        expect(movement.correlation.lastSource).toBe("carrier_poll");
    });

    it("missing public URL falls back to a carrier URL derived from the number", () => {
        const movement = derivePurchaseMovement({
            shipments: [makeShipment({ public_tracking_url: null })],
            legacyTrackingNumbers: [],
        });

        expect(movement.primaryUrl).toContain("fedex.com");
    });
});
