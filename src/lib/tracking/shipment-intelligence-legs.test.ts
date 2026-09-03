import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    openPOs: [] as any[],
    shipments: [] as any[],
    legs: [] as any[],
    vendorPolicies: [] as any[],
    updatedRows: [] as any[],
    insertedRows: [] as any[],
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        eq: () => ({
                            limit: async () => ({ data: mockState.openPOs, error: null }),
                            maybeSingle: async () => ({ data: mockState.openPOs[0] || null, error: null }),
                        }),
                        maybeSingle: async () => ({ data: mockState.openPOs[0] || null, error: null }),
                        contains: () => ({
                            not: () => ({
                                neq: () => ({
                                    limit: async () => ({ data: [], error: null }),
                                }),
                            }),
                        }),
                    }),
                    update: (values: any) => ({
                        eq: () => ({ data: null, error: null }),
                    }),
                };
            }
            if (table === "shipments") {
                return {
                    select: () => ({
                        overlaps: () => ({
                            eq: () => ({
                                order: async () => ({ data: mockState.shipments, error: null }),
                            }),
                        }),
                        contains: () => ({
                            limit: async () => ({ data: mockState.shipments, error: null }),
                        }),
                    }),
                };
            }
            if (table === "po_shipment_legs") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: () => ({
                                limit: async () => ({ data: mockState.legs, error: null }),
                            }),
                            // .select(...).eq(...) awaited directly for existing-leg lookup
                            then: async (resolve: any) => {
                                const result = { data: mockState.legs, error: null };
                                return resolve ? resolve(result) : result;
                            },
                        }),
                    }),
                    update: (values: any) => ({
                        eq: () => {
                            mockState.updatedRows.push(values);
                            return { data: null, error: null };
                        },
                    }),
                    insert: (values: any) => {
                        mockState.insertedRows.push(values);
                        return { data: null, error: null };
                    },
                };
            }
            if (table === "vendor_reorder_policies") {
                return {
                    select: () => ({
                        eq: () => ({
                            maybeSingle: async () => ({ data: mockState.vendorPolicies[0] || null, error: null }),
                        }),
                    }),
                };
            }
            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

vi.mock("@/lib/carriers/tracking-service", () => ({
    carrierUrl: vi.fn(() => null),
    detectCarrier: vi.fn(() => "fedex"),
    getTrackingStatus: vi.fn(async () => null),
    TRACKING_PATTERNS: {},
}));

import {
    getOpenPOTrackingCoverage,
    syncShipmentLegForPO,
} from "./shipment-intelligence";
import type { ShipmentRecord } from "./shipment-intelligence";

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
        source_refs: [],
        active: true,
        created_at: "2026-04-02T13:00:00.000Z",
        updated_at: "2026-04-02T14:00:00.000Z",
        ...overrides,
    };
}

describe("getOpenPOTrackingCoverage", () => {
    beforeEach(() => {
        mockState.openPOs = [];
        mockState.shipments = [];
        mockState.legs = [];
    });

    it("counts a PO as covered when it has tracking_numbers", async () => {
        mockState.openPOs = [
            { po_number: "PO-1", vendor_name: "A", status: "open", tracking_numbers: ["1Z123"], tracking_requested_at: null, tracking_unavailable_at: null, po_sent_verified_at: "2026-08-01T00:00:00.000Z", vendor_acknowledged_at: null },
            { po_number: "PO-2", vendor_name: "B", status: "open", tracking_numbers: [], tracking_requested_at: null, tracking_unavailable_at: null, po_sent_verified_at: "2026-07-01T00:00:00.000Z", vendor_acknowledged_at: null },
        ];
        const result = await getOpenPOTrackingCoverage();
        expect(result.totalOpen).toBe(2);
        expect(result.withTrackingIntel).toBe(1);
        expect(result.coveragePct).toBe(50);
        expect(result.withoutTracking.map((g) => g.poNumber)).toEqual(["PO-2"]);
    });

    it("counts a PO as covered when it has linked shipment evidence", async () => {
        mockState.openPOs = [
            { po_number: "PO-1", vendor_name: "A", status: "open", tracking_numbers: [], tracking_requested_at: null, tracking_unavailable_at: null, po_sent_verified_at: "2026-08-01T00:00:00.000Z", vendor_acknowledged_at: null },
        ];
        mockState.shipments = [makeShipment({ id: "s1", po_numbers: ["PO-1"] })];
        const result = await getOpenPOTrackingCoverage();
        expect(result.withTrackingIntel).toBe(1);
        expect(result.withoutTracking).toHaveLength(0);
    });
});

describe("syncShipmentLegForPO", () => {
    beforeEach(() => {
        mockState.legs = [];
        mockState.vendorPolicies = [];
        mockState.openPOs = [{ vendor_party_id: "10001", vendor_name: "Berger" }];
        mockState.updatedRows = [];
        mockState.insertedRows = [];
    });

    it("inserts a tracking-link leg for a PO-linked shipment", async () => {
        await syncShipmentLegForPO("PO-100", makeShipment());
        expect(mockState.insertedRows).toHaveLength(1);
        const row = mockState.insertedRows[0];
        expect(row.po_number).toBe("PO-100");
        expect(row.tracking_number).toBe("123456789012");
        expect(row.carrier_name).toBe("FedEx");
        expect(row.expected_qty).toBe(1);
        expect(row.notes).toContain("auto from tracking evidence");
        expect(row.vendor_party_id).toBe("10001");
        expect(row.vendor_name).toBe("Berger");
    });

    it("skips bulk vendors (their legs are real delivery schedules)", async () => {
        mockState.vendorPolicies = [{ is_bulk_vendor: true }];
        await syncShipmentLegForPO("PO-100", makeShipment());
        expect(mockState.insertedRows).toHaveLength(0);
    });

    it("updates an existing auto leg instead of inserting a duplicate", async () => {
        mockState.legs = [{
            id: "leg-1",
            tracking_number: "123456789012",
            carrier_name: "FedEx",
            expected_date: null,
            actual_date: null,
            notes: "auto from tracking evidence",
        }];
        await syncShipmentLegForPO("PO-100", makeShipment({
            status_category: "delivered",
            delivered_at: "2026-04-05T12:00:00.000Z",
        }));
        expect(mockState.insertedRows).toHaveLength(0);
        expect(mockState.updatedRows).toHaveLength(1);
        expect(mockState.updatedRows[0].actual_date).toBe("2026-04-05");
    });
});
