/**
 * @file    carrier-poll.test.ts
 * @purpose Regression guard: carrier-poll must never substitute now() for a
 *          missing delivered_at. Delivered is terminal, so a fabricated
 *          timestamp is unrecoverable (the 64058937 class).
 * @author  Aria Coder
 * @created 2026-10-29
 */
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    deliveredAtReceived: undefined as string | null | undefined,
    ships: [] as any[],
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => ({
        from: () => ({
            select: () => ({
                eq: () => ({
                    is: () => ({
                        or: () => ({
                            limit: async () => ({ data: state.ships, error: null }),
                        }),
                    }),
                }),
            }),
        }),
    })),
}));

vi.mock("@/lib/carriers/tracking-service", () => ({
    getTrackingStatus: vi.fn(async () => ({
        category: "delivered",
        display: "Delivered",
        delivered_at: undefined,
    })),
}));

vi.mock("@/lib/tracking/shipment-intelligence", () => ({
    upsertShipmentEvidence: vi.fn(async (input: any) => {
        state.deliveredAtReceived = input.deliveredAt;
        return null;
    }),
}));

import { pollActiveShipments } from "./carrier-poll";

describe("carrier-poll delivered_at fabrication guard", () => {
    it("writes null (not now()) when the carrier reports delivered with no timestamp", async () => {
        // Skip the 10s pacing sleep so the test does not stall.
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: any) => {
            (handler as () => void)();
            return 0 as any;
        });

        try {
            state.ships = [
                {
                    id: "s1",
                    tracking_number: "FedEx:::520484904168",
                    status_category: "in_transit",
                    status_display: "In transit",
                    last_checked_at: "2026-10-29T00:00:00.000Z",
                    delivered_at: null,
                    po_numbers: [],
                    vendor_names: [],
                },
            ];

            const outcomes = await pollActiveShipments();

            expect(outcomes[0]?.action).toBe("refreshed");
            // The delivered branch must write null — a fabricated timestamp
            // would arrive here as a non-null ISO string.
            expect(state.deliveredAtReceived).toBeNull();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
