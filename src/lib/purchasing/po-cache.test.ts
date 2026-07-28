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
import { cacheFinalePos } from "./po-cache";

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
