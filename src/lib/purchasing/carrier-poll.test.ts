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
    tracking: { category: "delivered", display: "Delivered", delivered_at: undefined as any } as any,
    orderArgs: null as any,
    updates: [] as any[],
    updateError: null as string | null,
    orFilters: [] as string[],
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => ({
        from: () => ({
            select: () => {
                const chain: any = {
                    eq: () => chain,
                    is: () => chain,
                    or: (filter: string) => {
                        state.orFilters.push(filter);
                        return chain;
                    },
                    order: (col: string, opts: any) => {
                        state.orderArgs = { col, opts };
                        return chain;
                    },
                    limit: async () => ({ data: state.ships, error: null }),
                };
                return chain;
            },
            update: (payload: any) => ({
                eq: async (col: string, val: any) => {
                    state.updates.push({ payload, col, val });
                    return { error: state.updateError ? { message: state.updateError } : null };
                },
            }),
        }),
    })),
}));

vi.mock("@/lib/carriers/tracking-service", () => ({
    getTrackingStatus: vi.fn(async () => state.tracking),
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

describe("carrier-poll starvation guards", () => {
    // Nothing else removes a row from the `last_checked_at.is.null` set, so if
    // the poll does not stamp its attempts the 2h cooldown never applies, the
    // same page is re-read every run, and everything past MAX_SHIPMENTS_PER_RUN
    // is never polled at all.
    function fakeTimers() {
        return vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: any) => {
            (handler as () => void)();
            return 0 as any;
        });
    }

    function ship(over: Record<string, any> = {}) {
        return {
            id: "s1",
            tracking_number: "FedEx:::520484904168",
            status_category: "in_transit",
            status_display: "In transit",
            last_checked_at: "2026-10-29T00:00:00.000Z",
            delivered_at: null,
            po_numbers: [],
            vendor_names: [],
            ...over,
        };
    }

    it("stamps last_checked_at on an unchanged result, so the row leaves the poll set", async () => {
        state.updates = [];
        state.ships = [ship()];
        state.tracking = { category: "in_transit", display: "In transit", delivered_at: null };
        const setTimeoutSpy = fakeTimers();
        try {
            const outcomes = await pollActiveShipments();
            expect(outcomes[0]?.action).toBe("unchanged");
            expect(state.updates).toHaveLength(1);
            expect(state.updates[0].col).toBe("id");
            expect(state.updates[0].val).toBe("s1");
            const stamped = state.updates[0].payload.last_checked_at;
            expect(typeof stamped).toBe("string");
            expect(Number.isNaN(Date.parse(stamped))).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("stamps on a no_data result too — a carrier that says nothing still deserves the cooldown", async () => {
        state.updates = [];
        state.ships = [ship()];
        state.tracking = null;
        const setTimeoutSpy = fakeTimers();
        try {
            const outcomes = await pollActiveShipments();
            expect(outcomes[0]?.action).toBe("no_data");
            expect(state.updates).toHaveLength(1);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("stamps every row in a batch, not just the first", async () => {
        state.updates = [];
        state.ships = [ship({ id: "s1" }), ship({ id: "s2", tracking_number: "UPS:::1Z22YV580359576490" })];
        state.tracking = { category: "in_transit", display: "In transit", delivered_at: null };
        const setTimeoutSpy = fakeTimers();
        try {
            const outcomes = await pollActiveShipments();
            expect(outcomes).toHaveLength(2);
            expect(state.updates.map((u: any) => u.val)).toEqual(["s1", "s2"]);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("does not abort the batch when the stamp itself fails", async () => {
        state.updates = [];
        state.updateError = "permission denied for table shipments";
        state.ships = [ship({ id: "s1" }), ship({ id: "s2", tracking_number: "UPS:::1Z22YV580359576490" })];
        state.tracking = { category: "in_transit", display: "In transit", delivered_at: null };
        const setTimeoutSpy = fakeTimers();
        try {
            const outcomes = await pollActiveShipments();
            expect(outcomes).toHaveLength(2);
            expect(state.updates).toHaveLength(2);
        } finally {
            setTimeoutSpy.mockRestore();
            state.updateError = null;
        }
    });

    it("orders the page oldest-checked first with nulls first", async () => {
        state.orderArgs = null;
        state.updates = [];
        state.ships = [ship()];
        state.tracking = { category: "in_transit", display: "In transit", delivered_at: null };
        const setTimeoutSpy = fakeTimers();
        try {
            await pollActiveShipments();
            expect(state.orderArgs).toEqual({ col: "last_checked_at", opts: { ascending: true, nullsFirst: true } });
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it("excludes delivered-by-category rows (terminal even with a null timestamp) but keeps null categories", async () => {
        state.orFilters = [];
        state.updates = [];
        state.ships = [ship()];
        state.tracking = { category: "in_transit", display: "In transit", delivered_at: null };
        const setTimeoutSpy = fakeTimers();
        try {
            await pollActiveShipments();
            // Terminal by category, not only by timestamp: a 'delivered' row with
            // delivered_at NULL must leave the poll set. The null branch is what
            // keeps a not-yet-polled (null-category) row in the set — a bare
            // `.neq('status_category','delivered')` would drop it too (SQL 3VL)
            // and starve first-time polls.
            expect(state.orFilters).toContain("status_category.is.null,status_category.neq.delivered");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
