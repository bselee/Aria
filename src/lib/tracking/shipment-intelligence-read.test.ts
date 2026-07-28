import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
    shipments: [] as any[],
    receivedRows: [] as any[],
    trackingStatusByNumber: new Map<string, any>(),
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "shipments") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: () => ({
                                limit: async () => ({ data: mockState.shipments, error: null }),
                            }),
                            // listActiveShipmentsRaw chains .eq("active") -> .gte("updated_at")
                            // -> .order() -> .limit(200). The gte link was missing, so the
                            // chain returned undefined and every test in this file died with
                            // "db.from(...).select(...).eq(...).gte is not a function" before
                            // reaching a single assertion. Filter ARGS are intentionally
                            // ignored: these tests exercise refresh/board-building logic, and
                            // mockState.shipments is the already-filtered fixture set.
                            gte: () => ({
                                order: () => ({
                                    limit: async () => ({ data: mockState.shipments, error: null }),
                                }),
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
// Imported to assert the live carrier lookup is NEVER called on a read path.
import { getTrackingStatus } from "@/lib/carriers/tracking-service";

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

    // CONTRACT (since 9c2a3e6): dashboard/query reads do NOT trigger live carrier
    // refreshes — listActiveShipmentsForRead serves STORED shipment state, and the
    // Tracking Validation Autopilot cron (every 30min) owns carrier polling. That
    // keeps dashboard load sub-second instead of blocking on carrier round-trips.
    //
    // These two tests previously asserted the OPPOSITE (refresh-on-read) and had
    // been stale since 9c2a3e6 removed it — but they never failed, because a broken
    // orphan tsconfig under src/lib/tracking/ killed this file at transform time so
    // zero assertions ever ran. Fixing that config (3beb503) exposed them.
    // They now assert the real contract: stored state is served verbatim and
    // getTrackingStatus (the live carrier call) is never invoked on a read.
    it("serves stored shipment state for the dashboard board without a live carrier call", async () => {
        mockState.shipments = [makeShipment({
            status_category: "delivered",
            status_display: "Delivered Apr 3",
            delivered_at: "2026-04-03T15:00:00.000Z",
        })];
        // Deliberately seeded but must NOT be consumed on a read path.
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "exception",
            display: "SHOULD NOT BE USED",
            public_url: "https://example.com/live/123456789012",
        });

        const result = await getDashboardTrackingBoard();

        // PO-100 is not in receivedRows, so a delivered shipment awaits receipt.
        expect(result.board.deliveredAwaitingReceipt).toHaveLength(1);
        expect(result.board.deliveredAwaitingReceipt[0]?.statusDisplay).toBe("Delivered Apr 3");
        expect(result.shipments[0]?.statusCategory).toBe("delivered");
        // The live carrier lookup must never fire on a dashboard read.
        expect(getTrackingStatus).not.toHaveBeenCalled();
    });

    it("answers teammate queries from stored state without a live carrier call", async () => {
        mockState.shipments = [makeShipment({
            po_numbers: ["PO-222"],
            vendor_names: ["ULINE"],
            status_category: "out_for_delivery",
            status_display: "Out for delivery",
        })];
        mockState.trackingStatusByNumber.set("123456789012", {
            category: "delivered",
            display: "SHOULD NOT BE USED",
            public_url: "https://example.com/live/123456789012",
        });

        const answer = await getBestTrackingAnswerForQuery("where is PO-222");

        expect(answer?.primaryLine).toContain("Out for delivery");
        expect(answer?.shipments[0]?.statusCategory).toBe("out_for_delivery");
        expect(getTrackingStatus).not.toHaveBeenCalled();
    });
});
