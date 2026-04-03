import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    shipments: [] as any[],
    receivedRows: [] as any[],
    trackingStatusByNumber: new Map<string, any>(),
}));

vi.mock("@/lib/supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "shipments") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: () => ({
                                limit: async () => ({ data: mockState.shipments, error: null }),
                            }),
                            contains: () => ({
                                eq: () => ({
                                    order: async () => ({ data: mockState.shipments, error: null }),
                                }),
                            }),
                        }),
                    }),
                    update: (values: any) => ({
                        eq: () => ({
                            select: () => ({
                                single: async () => {
                                    const idx = mockState.shipments.findIndex((row) => row.tracking_key === values.tracking_key);
                                    if (idx >= 0) {
                                        mockState.shipments[idx] = { ...mockState.shipments[idx], ...values };
                                    }
                                    return { data: mockState.shipments[idx], error: null };
                                },
                            }),
                        }),
                    }),
                };
            }

            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        in: async () => ({ data: mockState.receivedRows, error: null }),
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
    getTrackingStatus: vi.fn(async (trackingNumber: string) => mockState.trackingStatusByNumber.get(trackingNumber) || null),
    TRACKING_PATTERNS: {},
}));

import {
    getBestTrackingAnswerForQuery,
    getDashboardTrackingBoard,
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

describe("shipment intelligence read paths", () => {
    beforeEach(() => {
        mockState.shipments = [];
        mockState.receivedRows = [];
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
});
