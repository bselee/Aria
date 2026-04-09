import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    shipments: [] as any[],
    purchaseOrders: [] as any[],
    trackingStatusByNumber: new Map<string, any>(),
}));

function findShipmentBy(column: string, value: unknown) {
    return mockState.shipments.find((row) => row?.[column] === value) || null;
}

function upsertShipment(values: any) {
    const index = mockState.shipments.findIndex((row) => row.tracking_key === values.tracking_key);
    if (index >= 0) {
        mockState.shipments[index] = { ...mockState.shipments[index], ...values };
        return mockState.shipments[index];
    }

    mockState.shipments.push(values);
    return values;
}

function filterShipmentsByContains(column: string, values: string[]) {
    return mockState.shipments.filter((row) => {
        const haystack = Array.isArray(row?.[column]) ? row[column] : [];
        return values.every((value) => haystack.includes(value));
    });
}

function buildShipmentQuery(rows: any[]) {
    return {
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
        eq: (column: string, value: unknown) => buildShipmentQuery(rows.filter((row) => row?.[column] === value)),
        contains: (column: string, values: string[]) => buildShipmentQuery(rows.filter((row) => {
            const haystack = Array.isArray(row?.[column]) ? row[column] : [];
            return values.every((value) => haystack.includes(value));
        })),
        overlaps: (column: string, values: string[]) => buildShipmentQuery(rows.filter((row) => {
            const haystack = Array.isArray(row?.[column]) ? row[column] : [];
            return values.some((value) => haystack.includes(value));
        })),
        order: () => ({
            limit: async () => ({ data: rows, error: null }),
        }),
        limit: async () => ({ data: rows, error: null }),
    };
}

vi.mock("@/lib/supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "shipments") {
                return {
                    select: () => ({
                        eq: (column: string, value: unknown) => buildShipmentQuery(mockState.shipments.filter((row) => row?.[column] === value)),
                        contains: (column: string, values: string[]) => buildShipmentQuery(filterShipmentsByContains(column, values)),
                        overlaps: (column: string, values: string[]) => buildShipmentQuery(mockState.shipments.filter((row) => {
                            const haystack = Array.isArray(row?.[column]) ? row[column] : [];
                            return values.some((value) => haystack.includes(value));
                        })),
                        order: () => ({
                            limit: async () => ({ data: mockState.shipments, error: null }),
                        }),
                    }),
                    upsert: (values: any) => ({
                        select: () => ({
                            single: async () => ({ data: upsertShipment(values), error: null }),
                        }),
                    }),
                    update: (values: any) => ({
                        eq: (column: string, value: unknown) => ({
                            select: () => ({
                                single: async () => {
                                    const existing = findShipmentBy(column, value);
                                    if (!existing) return { data: null, error: null };
                                    Object.assign(existing, values);
                                    return { data: existing, error: null };
                                },
                            }),
                        }),
                    }),
                };
            }

            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        in: async (column: string, values: string[]) => ({
                            data: mockState.purchaseOrders.filter((row) => values.includes(row?.[column])),
                            error: null,
                        }),
                        eq: (column: string, value: unknown) => ({
                            maybeSingle: async () => ({
                                data: mockState.purchaseOrders.find((row) => row?.[column] === value) || null,
                                error: null,
                            }),
                        }),
                    }),
                    upsert: async (values: any) => {
                        const index = mockState.purchaseOrders.findIndex((row) => row.po_number === values.po_number);
                        if (index >= 0) {
                            mockState.purchaseOrders[index] = { ...mockState.purchaseOrders[index], ...values };
                        } else {
                            mockState.purchaseOrders.push(values);
                        }
                        return { data: values, error: null };
                    },
                };
            }

            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

vi.mock("@/lib/carriers/tracking-service", () => ({
    carrierUrl: vi.fn(() => null),
    detectCarrier: vi.fn(() => "fedex"),
    getTrackingStatus: vi.fn(async (trackingNumber: string) => mockState.trackingStatusByNumber.get(trackingNumber) || null),
    TRACKING_PATTERNS: {},
}));

import {
    getBestTrackingAnswerForQuery,
    getDashboardTrackingBoard,
    refreshShipmentStatus,
    upsertShipmentEvidence,
} from "./shipment-intelligence";

function makeShipment(overrides: Record<string, any> = {}) {
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
        last_checked_at: "2026-04-01T12:00:00.000Z",
        last_source: "email_tracking",
        source_confidence: 0.9,
        source_refs: [],
        active: true,
        created_at: "2026-04-01T12:00:00.000Z",
        updated_at: "2026-04-01T12:00:00.000Z",
        ...overrides,
    };
}

function makePurchaseOrder(overrides: Record<string, any> = {}) {
    return {
        po_number: "PO-100",
        po_sent_at: "2026-04-01T10:00:00.000Z",
        committed_at: "2026-04-01T09:50:00.000Z",
        vendor_acknowledged_at: null,
        shipping_evidence: [],
        tracking_requested_at: null,
        tracking_request_count: 0,
        tracking_status_summary: null,
        last_tracking_evidence_at: null,
        last_movement_summary: null,
        last_movement_update_at: null,
        lifecycle_stage: "sent",
        status: "open",
        ...overrides,
    };
}

describe("shipment intelligence read paths", () => {
    beforeEach(() => {
        mockState.shipments = [];
        mockState.purchaseOrders = [];
        mockState.trackingStatusByNumber = new Map<string, any>();
        vi.clearAllMocks();
    });

    it("refreshes stale shipments before building the dashboard board", async () => {
        mockState.shipments = [makeShipment()];
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "delivered",
            display: "Delivered Apr 3",
            delivered_at: "2026-04-03T15:00:00.000Z",
            public_url: "https://example.com/live/123456789012",
        });

        const result = await getDashboardTrackingBoard();

        expect(result.board.deliveredAwaitingReceipt).toHaveLength(1);
        expect(result.board.deliveredAwaitingReceipt[0]?.statusDisplay).toBe("Delivered Apr 3");
        expect(result.shipments[0]?.statusCategory).toBe("delivered");
    });

    it("refreshes stale shipments before answering teammate queries", async () => {
        mockState.shipments = [makeShipment({
            po_numbers: ["PO-222"],
            vendor_names: ["ULINE"],
            status_display: "Expected Apr 3",
        })];
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "out_for_delivery",
            display: "Out for delivery",
            estimated_delivery_at: "2026-04-03T18:00:00.000Z",
            public_url: "https://example.com/live/123456789012",
        });

        const answer = await getBestTrackingAnswerForQuery("where is PO-222");

        expect(answer?.primaryLine).toContain("Out for delivery");
        expect(answer?.shipments[0]?.statusCategory).toBe("out_for_delivery");
    });

    it("mirrors trusted tracking evidence onto purchase_orders when new tracking is discovered", async () => {
        mockState.purchaseOrders = [makePurchaseOrder()];

        await upsertShipmentEvidence({
            trackingNumber: "123456789012",
            poNumber: "PO-100",
            vendorName: "Berger",
            source: "email_tracking",
            sourceRef: "gmail:abc",
            confidence: 0.9,
            statusCategory: "in_transit",
            statusDisplay: "In transit",
            publicTrackingUrl: "https://example.com/live/123456789012",
        });

        const purchaseOrder = mockState.purchaseOrders[0];
        expect(purchaseOrder.shipping_evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "tracking",
                source: "email_tracking",
                trustworthyTracking: true,
            }),
        ]));
        expect(purchaseOrder.tracking_status_summary).toBe("In transit");
        expect(purchaseOrder.last_tracking_evidence_at).toBeTruthy();
        expect(purchaseOrder.lifecycle_stage).toBe("moving_with_tracking");
    });

    it("records a fresh movement update only when the carrier status materially changes", async () => {
        mockState.shipments = [makeShipment({
            status_display: "In transit",
            status_category: "in_transit",
            updated_at: "2026-04-02T12:00:00.000Z",
        })];
        mockState.purchaseOrders = [makePurchaseOrder({
            shipping_evidence: [{
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-02T12:00:00.000Z",
                summary: "In transit",
                trustworthyTracking: true,
            }],
            tracking_status_summary: "In transit",
            last_tracking_evidence_at: "2026-04-02T12:00:00.000Z",
            last_movement_summary: "In transit",
            last_movement_update_at: "2026-04-02T12:00:00.000Z",
            lifecycle_stage: "moving_with_tracking",
        })];
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "out_for_delivery",
            display: "Out for delivery",
            estimated_delivery_at: "2026-04-03T18:00:00.000Z",
            public_url: "https://example.com/live/123456789012",
        });

        await refreshShipmentStatus(mockState.shipments[0]);

        const purchaseOrder = mockState.purchaseOrders[0];
        expect(purchaseOrder.tracking_status_summary).toBe("Out for delivery");
        expect(purchaseOrder.last_movement_summary).toBe("Out for delivery");
        expect(purchaseOrder.last_movement_update_at).not.toBe("2026-04-02T12:00:00.000Z");
    });

    it("does not churn last_movement_update_at when the carrier status is unchanged", async () => {
        mockState.shipments = [makeShipment({
            status_display: "In transit",
            status_category: "in_transit",
        })];
        mockState.purchaseOrders = [makePurchaseOrder({
            shipping_evidence: [{
                kind: "tracking",
                source: "email_tracking",
                happenedAt: "2026-04-02T12:00:00.000Z",
                summary: "In transit",
                trustworthyTracking: true,
            }],
            tracking_status_summary: "In transit",
            last_tracking_evidence_at: "2026-04-02T12:00:00.000Z",
            last_movement_summary: "In transit",
            last_movement_update_at: "2026-04-02T12:00:00.000Z",
            lifecycle_stage: "moving_with_tracking",
        })];
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "in_transit",
            display: "In transit",
            public_url: "https://example.com/live/123456789012",
        });

        await refreshShipmentStatus(mockState.shipments[0]);

        const purchaseOrder = mockState.purchaseOrders[0];
        expect(purchaseOrder.tracking_status_summary).toBe("In transit");
        expect(purchaseOrder.last_movement_summary).toBe("In transit");
        expect(purchaseOrder.last_movement_update_at).toBe("2026-04-02T12:00:00.000Z");
    });
});
