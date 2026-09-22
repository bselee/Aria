/**
 * @file    po-cache.test.ts
 * @purpose Unit tests for po-cache.ts — verifies that cacheFinalePos stores
 *          and readCachedPos reconstructs the vendorPartyId field.
 * @author  Hermia
 * @created 2026-07-28
 * @deps    vitest, po-cache.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FullPO } from "../finale/core-client";

// ── Mock db ──────────────────────────────────────────────────────────────

vi.mock("../db", () => ({
    createClient: vi.fn(),
    probePostgrest: vi.fn(),
}));

import { createClient, probePostgrest } from "../db";
import { cacheFinalePos, readCachedPos } from "./po-cache";
import { CACHE_ACTIVE_STATUS_VALUES } from "./active-po-status";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockDb() {
    const upsert = vi.fn().mockResolvedValue({ error: null, data: [] });
    const from = vi.fn(() => ({ upsert }));
    return { from, upsert };
}

// ── Suite ────────────────────────────────────────────────────────────────

describe("po-cache vendorPartyId propagation", () => {
    let mockDb: ReturnType<typeof makeMockDb>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDb = makeMockDb();

        (probePostgrest as any).mockResolvedValue(true);
        (createClient as any).mockReturnValue(mockDb);
    });

    it("stores vendor_party_id in the upsert payload when FullPO has a vendorPartyId", async () => {
        const pos: FullPO[] = [
            {
                orderId: "PO-001",
                vendorName: "ULINE",
                vendorPartyId: "10083",
                orderDate: "2026-07-01",
                expectedDate: null,
                receiveDate: null,
                status: "Committed",
                total: 500,
                items: [{ productId: "BOX-123", quantity: 10 }],
                finaleUrl: "",
            },
        ];

        await cacheFinalePos(pos);

        expect(mockDb.from).toHaveBeenCalledWith("purchase_orders");
        expect(mockDb.upsert).toHaveBeenCalledTimes(1);

        const upsertArg = mockDb.upsert.mock.calls[0][0];
        expect(Array.isArray(upsertArg)).toBe(true);
        expect(upsertArg[0]).toMatchObject({
            po_number: "PO-001",
            vendor_name: "ULINE",
            vendor_party_id: "10083",
        });
    });

    it("stores null vendor_party_id when FullPO has null", async () => {
        const pos: FullPO[] = [
            {
                orderId: "PO-002",
                vendorName: "Some Vendor",
                vendorPartyId: null,
                orderDate: "2026-07-01",
                expectedDate: null,
                receiveDate: null,
                status: "Committed",
                total: 100,
                items: [],
                finaleUrl: "",
            },
        ];

        await cacheFinalePos(pos);

        const upsertArg = mockDb.upsert.mock.calls[0][0];
        expect(upsertArg[0].vendor_party_id).toBeNull();
    });

    it("stores null vendor_party_id when FullPO vendorPartyId is undefined", async () => {
        const pos = [
            {
                orderId: "PO-003",
                vendorName: "Legacy",
                // no vendorPartyId set — simulates old cached data
                orderDate: "2026-07-01",
                expectedDate: null,
                receiveDate: null,
                status: "Committed",
                total: 200,
                items: [],
                finaleUrl: "",
            },
        ] as FullPO[];

        await cacheFinalePos(pos);

        const upsertArg = mockDb.upsert.mock.calls[0][0];
        expect(upsertArg[0].vendor_party_id).toBeNull();
    });
});

function makeSelectDb() {
    const calls: {
        select?: unknown[];
        in?: unknown[];
        gte?: unknown[];
        order?: unknown[];
        limit?: unknown[];
    } = {};
    const chain: Record<string, unknown> = {};
    const rec = (name: keyof typeof calls) =>
        vi.fn((...args: unknown[]) => {
            calls[name] = args;
            return chain;
        });
    chain.select = rec("select");
    chain.in = rec("in");
    chain.gte = rec("gte");
    chain.order = rec("order");
    chain.limit = rec("limit");
    chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: [], error: null }));
    const from = vi.fn(() => chain);
    return { from, calls };
}

describe("readCachedPos query shape", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (probePostgrest as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    });

    it("filters active statuses, honours daysBack, orders by issue_date — not updated_at LIMIT 500", async () => {
        const mockDb = makeSelectDb();
        (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

        await readCachedPos(60);

        expect(mockDb.from).toHaveBeenCalledWith("purchase_orders");
        expect(mockDb.calls.in?.[0]).toBe("status");
        expect(mockDb.calls.in?.[1]).toEqual([...CACHE_ACTIVE_STATUS_VALUES]);
        expect(mockDb.calls.gte?.[0]).toBe("issue_date");
        const cutoff = mockDb.calls.gte?.[1] as string;
        expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const expected = new Date();
        expected.setUTCDate(expected.getUTCDate() - 60);
        expect(cutoff).toBe(expected.toISOString().split("T")[0]);
        expect(mockDb.calls.order?.[0]).toBe("issue_date");
        expect(mockDb.calls.order?.[1]).toEqual({ ascending: false });
        expect(mockDb.calls.limit).toBeUndefined();
    });
});
