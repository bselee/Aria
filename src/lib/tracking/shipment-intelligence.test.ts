import { describe, expect, it } from "vitest";

import {
    buildTodayShipmentSummary,
    buildBestTrackingAnswer,
    canonicalizeTrackingNumbers,
    classifyShipmentEvidence,
    getShipmentBoardBuckets,
    getShipmentsDueForRefresh,
    mergeShipmentEvidence,
    normalizeTrackingIdentity,
    type ShipmentRecord,
} from "./shipment-intelligence";

function makeShipment(overrides: Partial<ShipmentRecord> = {}): ShipmentRecord {
    return {
        id: "ship-1",
        tracking_key: "fedex:123456789012",
        tracking_number: "123456789012",
        normalized_tracking_number: "123456789012",
        carrier_name: "FedEx",
        carrier_key: "fedex",
        tracking_kind: "parcel",
        po_numbers: ["PO-100"],
        vendor_names: ["Berger"],
        status_category: "in_transit",
        status_display: "Expected Apr 3",
        public_tracking_url: "https://example.com/track/123456789012",
        estimated_delivery_at: "2026-04-03T17:00:00.000Z",
        delivered_at: null,
        last_checked_at: "2026-04-02T14:00:00.000Z",
        last_source: "email_tracking",
        source_confidence: 0.9,
        source_refs: [
            {
                source: "email_tracking",
                sourceRef: "gmail:abc",
                seenAt: "2026-04-02T13:00:00.000Z",
            },
        ],
        active: true,
        created_at: "2026-04-02T13:00:00.000Z",
        updated_at: "2026-04-02T14:00:00.000Z",
        ...overrides,
    };
}

describe("normalizeTrackingIdentity", () => {
    it("normalizes parcel tracking numbers into stable keys", () => {
        expect(normalizeTrackingIdentity(" 123456789012 ")).toMatchObject({
            trackingKey: "fedex:123456789012",
            trackingNumber: "123456789012",
            carrierKey: "fedex",
            carrierName: "FedEx",
            trackingKind: "parcel",
        });
    });

    it("preserves LTL carrier evidence in encoded tracking strings", () => {
        expect(normalizeTrackingIdentity("Old Dominion:::1234567")).toMatchObject({
            trackingKey: "old dominion:1234567",
            trackingNumber: "Old Dominion:::1234567",
            normalizedTrackingNumber: "1234567",
            carrierName: "Old Dominion",
            trackingKind: "ltl_pro",
        });
    });

    it("classifies parcel carriers tagged via Carrier:::Number as parcel, not ltl_pro", () => {
        expect(normalizeTrackingIdentity("FedEx:::383269682926")).toMatchObject({
            trackingKind: "parcel",
            carrierKey: "fedex",
        });
    });

    it("keeps LTL freight (FedEx Freight) tagged as ltl_pro", () => {
        expect(normalizeTrackingIdentity("FedEx Freight:::300050638069")).toMatchObject({
            trackingKind: "ltl_pro",
        });
    });
});

describe("canonicalizeTrackingNumbers", () => {
    it("collapses bare + carrier-prefixed duplicates, preferring the prefixed form", () => {
        expect(
            canonicalizeTrackingNumbers(["FedEx:::383269682926", "383269682926"]),
        ).toEqual(["FedEx:::383269682926"]);
    });

    it("keeps distinct tracking numbers", () => {
        expect(
            canonicalizeTrackingNumbers(["FedEx:::111111111111", "UPS:::1Z9999999999999999"]),
        ).toEqual(["FedEx:::111111111111", "UPS:::1Z9999999999999999"]);
    });

    it("preserves LTL carrier casing (no title-case munging)", () => {
        expect(
            canonicalizeTrackingNumbers(["AAA Cooper:::723259594"]),
        ).toEqual(["AAA Cooper:::723259594"]);
    });

    it("returns empty for empty/blank input", () => {
        expect(canonicalizeTrackingNumbers([])).toEqual([]);
        expect(canonicalizeTrackingNumbers(["", "  "])).toEqual([]);
    });
});

describe("mergeShipmentEvidence", () => {
    it("merges PO links, vendor names, and provenance without duplication", () => {
        const existing = makeShipment();
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "PO-200",
            vendorName: "BuildASoil",
            source: "invoice_reconciliation",
            sourceRef: "inv:9001",
            confidence: 0.7,
            statusCategory: "out_for_delivery",
            statusDisplay: "Out for delivery",
        });

        expect(merged.po_numbers).toEqual(["PO-100", "PO-200"]);
        expect(merged.vendor_names).toEqual(["Berger", "BuildASoil"]);
        expect(merged.status_category).toBe("out_for_delivery");
        expect(merged.source_refs).toEqual([
            { source: "email_tracking", sourceRef: "gmail:abc", seenAt: "2026-04-02T13:00:00.000Z" },
            { source: "invoice_reconciliation", sourceRef: "inv:9001", seenAt: expect.any(String), confidence: 0.7 },
        ]);
    });
});

describe("classifyShipmentEvidence", () => {
    it("keeps weak inferred email tracking as a candidate", () => {
        expect(classifyShipmentEvidence(makeShipment({
            status_category: null,
            status_display: null,
            last_checked_at: null,
            source_confidence: 0.55,
            source_refs: [
                {
                    source: "email_tracking_inferred_po",
                    sourceRef: "gmail:weak",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.55,
                },
            ],
        }))).toMatchObject({
            level: "candidate",
            reason: expect.stringContaining("weak"),
        });
    });

    it("confirms carrier-checked tracking even when the original source was email", () => {
        expect(classifyShipmentEvidence(makeShipment({
            last_checked_at: "2026-04-02T14:00:00.000Z",
            status_category: "in_transit",
            source_confidence: 0.55,
        }))).toMatchObject({
            level: "confirmed",
            reason: expect.stringContaining("carrier"),
        });
    });

    it("confirms email_ingest_pdf evidence when the tracking is PO-linked", () => {
        expect(classifyShipmentEvidence(makeShipment({
            status_category: null,
            status_display: null,
            last_checked_at: null,
            source_confidence: 0.6,
            source_refs: [
                {
                    source: "email_ingest_pdf",
                    sourceRef: "gmail:pdf-1",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.6,
                },
            ],
        }))).toMatchObject({
            level: "confirmed",
            reason: expect.stringContaining("document evidence"),
        });
    });

    it("keeps email_ingest_pdf without a PO link as a candidate (orphan-style)", () => {
        expect(classifyShipmentEvidence(makeShipment({
            po_numbers: [],
            status_category: null,
            status_display: null,
            last_checked_at: null,
            source_confidence: 0.6,
            source_refs: [
                {
                    source: "email_ingest_pdf",
                    sourceRef: "gmail:pdf-orphan",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.6,
                },
            ],
        }))).toMatchObject({
            level: "candidate",
            reason: expect.stringContaining("weak"),
        });
    });

    it("confirms email_ingest_bol_vision when the tracking is PO-linked", () => {
        expect(classifyShipmentEvidence(makeShipment({
            status_category: null,
            status_display: null,
            last_checked_at: null,
            source_confidence: 0.5,
            source_refs: [
                {
                    source: "email_ingest_bol_vision",
                    sourceRef: "gmail:bol-1",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.5,
                },
            ],
        }))).toMatchObject({
            level: "confirmed",
        });
    });

    it("keeps ap_invoice evidence confirmed even without an explicit PO link", () => {
        expect(classifyShipmentEvidence(makeShipment({
            po_numbers: [],
            status_category: null,
            status_display: null,
            last_checked_at: null,
            source_confidence: 0.5,
            source_refs: [
                {
                    source: "ap_invoice",
                    sourceRef: "inv:9001",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.5,
                },
            ],
        }))).toMatchObject({
            level: "confirmed",
            reason: "document evidence",
        });
    });
});

describe("getShipmentBoardBuckets", () => {
    it("groups shipments into operational buckets", () => {
        const shipments = [
            makeShipment({
                id: "arriving",
                status_category: "in_transit",
                estimated_delivery_at: "2026-04-02T18:00:00.000Z",
            }),
            makeShipment({
                id: "ofd",
                status_category: "out_for_delivery",
                estimated_delivery_at: "2026-04-02T18:00:00.000Z",
            }),
            makeShipment({
                id: "delivered-awaiting",
                status_category: "delivered",
                delivered_at: "2026-04-02T12:00:00.000Z",
            }),
            makeShipment({
                id: "exception",
                status_category: "exception",
                status_display: "Delivery exception",
            }),
        ];

        const buckets = getShipmentBoardBuckets(shipments, {
            now: "2026-04-02T15:00:00.000Z",
            receivedPoNumbers: new Set<string>(),
        });

        expect(buckets.arrivingToday.map((s) => s.id)).toContain("arriving");
        expect(buckets.outForDelivery.map((s) => s.id)).toContain("ofd");
        expect(buckets.deliveredAwaitingReceipt.map((s) => s.id)).toContain("delivered-awaiting");
        expect(buckets.exceptions.map((s) => s.id)).toContain("exception");
    });
});

describe("buildBestTrackingAnswer", () => {
    it("builds a teammate-friendly status summary prioritizing ETA and freshness", () => {
        const answer = buildBestTrackingAnswer({
            query: "Where is PO-100?",
            shipments: [
                makeShipment({
                    po_numbers: ["PO-100"],
                    vendor_names: ["ULINE"],
                    status_category: "out_for_delivery",
                    status_display: "Out for delivery",
                    estimated_delivery_at: "2026-04-02T19:00:00.000Z",
                    last_checked_at: "2026-04-02T15:05:00.000Z",
                }),
            ],
            now: "2026-04-02T15:10:00.000Z",
        });

        expect(answer.primaryLine).toContain("PO-100");
        expect(answer.primaryLine).toContain("Out for delivery");
        expect(answer.primaryLine).toContain("ULINE");
        expect(answer.metaLine).toContain("fresh 5m ago");
    });

    it("ranks exact PO matches ahead of incidental token matches", () => {
        const answer = buildBestTrackingAnswer({
            query: "where is PO-100",
            shipments: [
                makeShipment({
                    id: "weak-match",
                    po_numbers: ["PO-200"],
                    vendor_names: ["Island Herbs"],
                    status_display: "In transit",
                }),
                makeShipment({
                    id: "exact-match",
                    po_numbers: ["PO-100"],
                    vendor_names: ["ULINE"],
                    status_display: "Out for delivery",
                    estimated_delivery_at: "2026-04-02T19:00:00.000Z",
                    last_checked_at: "2026-04-02T15:05:00.000Z",
                }),
            ],
            now: "2026-04-02T15:10:00.000Z",
        });

        expect(answer?.primaryLine).toContain("PO-100");
        expect(answer?.primaryLine).toContain("Out for delivery");
        expect(answer?.shipments[0]?.id).toBe("exact-match");
    });
});

describe("getShipmentsDueForRefresh", () => {
    it("prioritizes unchecked and stale active shipments while skipping fresh delivered ones", () => {
        const due = getShipmentsDueForRefresh(
            [
                makeShipment({
                    id: "unchecked",
                    status_category: "in_transit",
                    last_checked_at: null,
                }),
                makeShipment({
                    id: "stale",
                    status_category: "out_for_delivery",
                    last_checked_at: "2026-04-02T11:00:00.000Z",
                }),
                makeShipment({
                    id: "fresh",
                    status_category: "in_transit",
                    last_checked_at: "2026-04-02T14:50:00.000Z",
                }),
                makeShipment({
                    id: "delivered",
                    status_category: "delivered",
                    delivered_at: "2026-04-02T13:00:00.000Z",
                    last_checked_at: "2026-04-02T14:55:00.000Z",
                }),
            ],
            { now: "2026-04-02T15:10:00.000Z", limit: 10 },
        );

        expect(due.map((shipment) => shipment.id)).toEqual(["unchecked", "stale"]);
    });
});

describe("buildTodayShipmentSummary", () => {
    it("summarizes truthful today-facing shipment activity for teammates", () => {
        const summary = buildTodayShipmentSummary({
            arrivingToday: [
                makeShipment({
                    id: "eta",
                    po_numbers: ["PO-300"],
                    vendor_names: ["BuildASoil"],
                    status_category: "in_transit",
                    status_display: "Expected Apr 2",
                    estimated_delivery_at: "2026-04-02T18:00:00.000Z",
                }),
            ].map((shipment) => ({
                id: shipment.id,
                poNumbers: shipment.po_numbers,
                vendorNames: shipment.vendor_names,
                trackingNumber: shipment.tracking_number,
                carrierName: shipment.carrier_name,
                carrierKey: shipment.carrier_key,
                trackingKind: shipment.tracking_kind,
                statusCategory: "in_transit" as const,
                statusDisplay: shipment.status_display || "",
                estimatedDeliveryAt: shipment.estimated_delivery_at,
                deliveredAt: shipment.delivered_at,
                publicTrackingUrl: shipment.public_tracking_url,
                freshnessMinutes: 10,
                lastCheckedAt: shipment.last_checked_at,
            })),
            outForDelivery: [
                makeShipment({
                    id: "ofd",
                    po_numbers: ["PO-200"],
                    vendor_names: ["ULINE"],
                    status_category: "out_for_delivery",
                    status_display: "Out for delivery",
                }),
            ].map((shipment) => ({
                id: shipment.id,
                poNumbers: shipment.po_numbers,
                vendorNames: shipment.vendor_names,
                trackingNumber: shipment.tracking_number,
                carrierName: shipment.carrier_name,
                carrierKey: shipment.carrier_key,
                trackingKind: shipment.tracking_kind,
                statusCategory: "out_for_delivery" as const,
                statusDisplay: shipment.status_display || "",
                estimatedDeliveryAt: shipment.estimated_delivery_at,
                deliveredAt: shipment.delivered_at,
                publicTrackingUrl: shipment.public_tracking_url,
                freshnessMinutes: 5,
                lastCheckedAt: shipment.last_checked_at,
            })),
            deliveredAwaitingReceipt: [],
            exceptions: [],
            stale: [],
            recentlyDelivered: [],
        });

        expect(summary.headline).toContain("1 out for delivery");
        expect(summary.headline).toContain("1 arriving today");
        expect(summary.lines[0]).toContain("PO-200");
        expect(summary.lines[1]).toContain("PO-300");
    });
});
