/**
 * @file    src/lib/storage/tracking-cache.test.ts
 * @purpose Regression lock for the tracking accuracy overhaul (2026-10-28):
 *          tiered staleness, poll→shipments writeback guards, registration.
 * @author  Hermia
 * @created 2026-10-28
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Canned SQLite rows the tiering query returns. */
let cachedRows: Array<{
    tracking_number: string;
    status_category: string | null;
    estimated_delivery_at: string | null;
    last_checked_at: string | null;
    delivered_at: string | null;
}> = [];

/** Canned shipments rows the writeback query returns. */
let shipRows: Array<Record<string, unknown>> = [];
const updatedPatches: Array<Record<string, string>> = [];

vi.mock("./local-db", () => ({
    getLocalDb: vi.fn(() => ({
        prepare: () => ({
            all: () => cachedRows,
            get: () => undefined,
            run: () => ({}),
        }),
    })),
}));

vi.mock("../db", () => ({
    createClient: vi.fn(() => ({
        from: () => ({
            select: () => queryStep({ data: shipRows }),
            update: (patch: Record<string, string>) => {
                updatedPatches.push(patch);
                return queryStep({ error: null, data: [] });
            },
        }),
    })),
}));

function queryStep(res: { data?: unknown; error?: unknown }) {
    const step: Record<string, unknown> = { res };
    step.or = () => step;
    step.eq = () => step;
    step.ilike = () => step;
    step.limit = () => step;
    step.not = () => step;
    step.is = () => step;
    step.gte = () => step;
    step.then = (resolve: (v: unknown) => void) => Promise.resolve(res).then(resolve);
    return step;
}

import { getStaleTrackingsTiered, writePollResultToShipments } from "./tracking-cache";

const NOW = Date.parse("2026-10-28T12:00:00.000-06:00");

describe("getStaleTrackingsTiered", () => {
    beforeEach(() => {
        cachedRows = [];
    });

    const row = (over: Partial<(typeof cachedRows)[number]>): (typeof cachedRows)[number] => ({
        tracking_number: "1Z123",
        status_category: "in_transit",
        estimated_delivery_at: null,
        last_checked_at: new Date(NOW - 3600_000).toISOString(),
        delivered_at: null,
        ...over,
    });

    it("puts out_for_delivery into tier1 on a 30m cadence", () => {
        cachedRows = [row({ status_category: "out_for_delivery", last_checked_at: new Date(NOW - 31 * 60_000).toISOString() })];
        const tiers = getStaleTrackingsTiered(NOW);
        expect(tiers.tier1).toHaveLength(1);
        expect(tiers.tier2).toHaveLength(0);
        expect(tiers.tier3).toHaveLength(0);
    });

    it("keeps a fresh out_for_delivery row out of every tier", () => {
        cachedRows = [row({ status_category: "out_for_delivery", last_checked_at: new Date(NOW - 10 * 60_000).toISOString() })];
        const tiers = getStaleTrackingsTiered(NOW);
        expect(tiers.tier1.length + tiers.tier2.length + tiers.tier3.length).toBe(0);
    });

    it("tiers ETA-bearing rows on a 4h cadence", () => {
        cachedRows = [
            row({ estimated_delivery_at: "2026-10-30T10:00:00-06:00", last_checked_at: new Date(NOW - 5 * 3600_000).toISOString() }),
        ];
        const tiers = getStaleTrackingsTiered(NOW);
        expect(tiers.tier2).toHaveLength(1);
        expect(tiers.tier1).toHaveLength(0);
    });

    it("puts a today-ETA row in tier1", () => {
        cachedRows = [
            row({ estimated_delivery_at: "2026-10-28T18:00:00-06:00", last_checked_at: new Date(NOW - 2 * 3600_000).toISOString() }),
        ];
        const tiers = getStaleTrackingsTiered(NOW);
        expect(tiers.tier1).toHaveLength(1);
    });

    it("puts the long tail on a 12h cadence", () => {
        cachedRows = [row({ last_checked_at: new Date(NOW - 13 * 3600_000).toISOString() })];
        const tiers = getStaleTrackingsTiered(NOW);
        expect(tiers.tier3).toHaveLength(1);
    });
});

describe("writePollResultToShipments", () => {
    beforeEach(() => {
        shipRows = [];
        updatedPatches.length = 0;
    });

    const shipRow = (over: Record<string, unknown>): Record<string, unknown> => ({
        id: "ship-1",
        tracking_number: "1Z123",
        tracking_key: "UPS:::1Z123",
        status_category: "in_transit",
        status_display: "In transit",
        estimated_delivery_at: null,
        delivered_at: null,
        ...over,
    });

    it("updates status, display and ETA from a poll", async () => {
        shipRows = [shipRow({})];
        const written = await writePollResultToShipments("1Z123", {
            category: "out_for_delivery",
            display: "Out for delivery",
            estimated_delivery_at: "2026-10-28T18:00:00-06:00",
        });
        expect(written).toBe(1);
        const patch = updatedPatches[0];
        expect(patch.status_category).toBe("out_for_delivery");
        expect(patch.status_display).toBe("Out for delivery");
        expect(patch.estimated_delivery_at).toBe("2026-10-28T18:00:00-06:00");
        expect(patch.last_checked_at).toBeTruthy();
    });

    it("never downgrades a delivered row on a stale poll", async () => {
        shipRows = [shipRow({ status_category: "delivered", delivered_at: "2026-10-27T10:00:00-06:00" })];
        const written = await writePollResultToShipments("1Z123", {
            category: "in_transit",
            display: "In transit",
        });
        expect(written).toBe(0);
        expect(updatedPatches).toHaveLength(0);
    });

    it("keeps an existing ETA when the poll returns none", async () => {
        shipRows = [shipRow({ estimated_delivery_at: "2026-10-29T10:00:00-06:00" })];
        const written = await writePollResultToShipments("1Z123", {
            category: "out_for_delivery",
            display: "Out for delivery",
        });
        expect(written).toBe(1);
        expect(updatedPatches[0].estimated_delivery_at).toBeUndefined();
    });

    it("still advances last_checked_at on an unchanged status", async () => {
        shipRows = [shipRow({ status_category: "in_transit", status_display: "In transit" })];
        const written = await writePollResultToShipments("1Z123", {
            category: "in_transit",
            display: "In transit",
        });
        expect(written).toBe(1);
        expect(updatedPatches[0].last_checked_at).toBeTruthy();
        expect(updatedPatches[0].status_category).toBeUndefined();
    });
});
