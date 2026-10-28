import { describe, expect, it } from "vitest";

import {
    buildTodayShipmentSummary,
    buildBestTrackingAnswer,
    classifyShipmentEvidence,
    getShipmentBoardBuckets,
    getShipmentsDueForRefresh,
    mergeShipmentEvidence,
    mergeTrackingStatus,
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

    it("classifies a parcel carrier encoded with ::: as parcel, not LTL", () => {
        expect(normalizeTrackingIdentity("FedEx:::383864295713")).toMatchObject({
            trackingKey: "fedex:383864295713",
            trackingNumber: "FedEx:::383864295713",
            normalizedTrackingNumber: "383864295713",
            carrierName: "FedEx",
            carrierKey: "fedex",
            trackingKind: "parcel",
        });
    });

    it("keeps FedEx Freight encoded tracking as LTL", () => {
        expect(normalizeTrackingIdentity("FedEx Freight:::1234567890")).toMatchObject({
            carrierName: "FedEx Freight",
            trackingKind: "ltl_pro",
        });
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

    it("supersedes a weak inferred PO ref with a strong manual confirmation (merge→supersede)", () => {
        const existing = makeShipment({
            po_numbers: ["125423"],
            source_confidence: 0.6,
            source_refs: [
                {
                    source: "email_ingest_inferred",
                    sourceRef: "gmail:weak",
                    seenAt: "2026-04-02T13:00:00.000Z",
                    confidence: 0.6,
                },
            ],
        });
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "125377",
            vendorName: "New Moon Development Co",
            source: "manual_confirmation",
            sourceRef: "operator:bill",
            confidence: 0.95,
        });
        expect(merged.po_numbers).toEqual(["125377"]);
    });

    it("appends (does not supersede) when the incoming ref is weak", () => {
        const existing = makeShipment({ po_numbers: ["125423"], source_confidence: 0.6 });
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "125400",
            source: "email_ingest_inferred",
            sourceRef: "gmail:weak2",
            confidence: 0.6,
        });
        expect(merged.po_numbers).toEqual(["125423", "125400"]);
    });

    it("appends when both refs are strong (preserves legit multi-PO shipments)", () => {
        const existing = makeShipment({ po_numbers: ["125212"], source_confidence: 0.9 });
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "125213",
            source: "ap_invoice",
            sourceRef: "inv:1",
            confidence: 0.9,
        });
        expect(merged.po_numbers).toEqual(["125212", "125213"]);
    });

    it("never downgrades delivered → in_transit (monotonic delivery, Guard 11 #2)", () => {
        const existing = makeShipment({
            status_category: "delivered",
            status_display: "Delivered Sep 25, 2026 (pod delivery status)",
            delivered_at: "2026-09-25T12:00:00.000Z",
        });
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "125333",
            source: "carrier_poll",
            sourceRef: "poll:stale",
            confidence: 0.9,
            statusCategory: "in_transit",
            statusDisplay: "In transit",
        });
        expect(merged.status_category).toBe("delivered");
        expect(merged.status_display).toBe("Delivered Sep 25, 2026 (pod delivery status)");
        expect(merged.delivered_at).toBe("2026-09-25T12:00:00.000Z");
    });

    it("promotes an in_transit row to delivered on documentary evidence", () => {
        const existing = makeShipment({ status_category: "in_transit", delivered_at: null });
        const merged = mergeShipmentEvidence(existing, {
            poNumber: "125333",
            source: "documentary_delivery",
            sourceRef: "gmail:pod",
            confidence: 0.95,
            statusCategory: "delivered",
            statusDisplay: "Delivered Sep 25, 2026 (pod delivery status)",
            deliveredAt: "2026-09-25T12:00:00.000Z",
        });
        expect(merged.status_category).toBe("delivered");
        expect(merged.delivered_at).toBe("2026-09-25T12:00:00.000Z");
    });
});

describe("mergeTrackingStatus (carrier-poll monotonic delivery guard)", () => {
    it("never downgrades a delivered row to in_transit on a stale carrier read", () => {
        const record = makeShipment({
            status_category: "delivered",
            status_display: "Delivered Sep 25, 2026 (pod delivery status)",
            delivered_at: "2026-09-25T12:00:00.000Z",
        });
        const updated = mergeTrackingStatus(record, { category: "in_transit", display: "In transit" });
        expect(updated.status_category).toBe("delivered");
        expect(updated.status_display).toBe("Delivered Sep 25, 2026 (pod delivery status)");
        expect(updated.delivered_at).toBe("2026-09-25T12:00:00.000Z");
    });

    it("promotes an in_transit row to delivered when the carrier reports delivery", () => {
        const record = makeShipment({ status_category: "in_transit", delivered_at: null });
        const updated = mergeTrackingStatus(record, {
            category: "delivered",
            display: "Delivered",
            delivered_at: "2026-09-25T12:00:00.000Z",
        });
        expect(updated.status_category).toBe("delivered");
        expect(updated.delivered_at).toBe("2026-09-25T12:00:00.000Z");
    });

    it("returns the record unchanged when the carrier returns no status", () => {
        const record = makeShipment({ status_category: "in_transit" });
        expect(mergeTrackingStatus(record, null)).toBe(record);
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

    it("excludes PO-less tracking and dropships (2026-10-28)", () => {
        const rollup = (po_numbers: string[], vendor_names: string[], status_category: "in_transit" | "out_for_delivery") => ({
            id: "x",
            poNumbers: po_numbers,
            vendorNames: vendor_names,
            trackingNumber: "384061609853",
            carrierName: "FedEx",
            carrierKey: "fedex",
            trackingKind: "parcel" as const,
            statusCategory: status_category,
            statusDisplay: status_category === "out_for_delivery" ? "Out for delivery" : "In transit",
            estimatedDeliveryAt: "2026-10-28T14:15:00.000Z",
            deliveredAt: null,
            publicTrackingUrl: null,
            freshnessMinutes: 5,
            lastCheckedAt: "2026-10-28T10:00:00.000Z",
        });
        const summary = buildTodayShipmentSummary({
            arrivingToday: [
                rollup([], ["FedEx"], "in_transit"), // bare tracking, no PO
                rollup(["23577107-S-DropshipPO"], ["Autopot Watering Systems"], "in_transit"), // teammate's
                rollup(["125394"], ["Safe Solutions, Inc."], "in_transit"), // real incoming PO
            ],
            outForDelivery: [rollup([], ["FedEx"], "out_for_delivery")], // bare FedEx, no PO
            deliveredAwaitingReceipt: [],
            exceptions: [],
            stale: [],
            recentlyDelivered: [],
        });
        expect(summary).not.toBeNull();
        expect(summary!.headline).toBe("1 arriving today");
        expect(summary!.lines).toHaveLength(1);
        expect(summary!.lines[0]).toContain("125394");
    });

    it("returns null when only noise is present", () => {
        const rollup = () => ({
            id: "y",
            poNumbers: [],
            vendorNames: ["FedEx"],
            trackingNumber: "383123033066",
            carrierName: "FedEx",
            carrierKey: "fedex",
            trackingKind: "parcel" as const,
            statusCategory: "out_for_delivery" as const,
            statusDisplay: "Out for delivery",
            estimatedDeliveryAt: null,
            deliveredAt: null,
            publicTrackingUrl: null,
            freshnessMinutes: 5,
            lastCheckedAt: null,
        });
        const summary = buildTodayShipmentSummary({
            arrivingToday: [],
            outForDelivery: [rollup(), rollup()],
            deliveredAwaitingReceipt: [],
            exceptions: [],
            stale: [],
            recentlyDelivered: [],
        });
        expect(summary).toBeNull();
    });
});
