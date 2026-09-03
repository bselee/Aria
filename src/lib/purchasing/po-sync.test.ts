/**
 * @file    po-sync.test.ts
 * @purpose Regression tests for po-sync's terminal-truth sync: Finale
 *          auto-completes POs (status="Completed", receiveDate set), and the
 *          local purchase_orders row must preserve lifecycle_state=COMPLETED
 *          + receive_date so Receivings can exclude completed POs and the
 *          3-way gate can see the receipt leg. PO 125212 was the live case:
 *          Finale completed it, the cache said "received" with receive_date
 *          null, and the dashboard kept it in the action list forever.
 * @author  Hermia
 * @created 2026-08-27
 * @deps    vitest, @/lib/purchasing/po-sync, @/lib/db
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: vi.fn(),
}));

import { createClient } from "@/lib/db";
import { FinaleClient } from "@/lib/finale/client";
import { syncPurchaseOrders } from "./po-sync";

const mockedCreateClient = vi.mocked(createClient);
const mockedFinale = vi.mocked(FinaleClient);

/** Build a fake PostgREST-ish client that records upserts. */
function fakeDb() {
    const upserts: Array<Record<string, unknown>> = [];
    return {
        from: vi.fn(() => {
            const chain = {
                select: vi.fn(() => chain),
                order: vi.fn(() => chain),
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                upsert: vi.fn((row: Record<string, unknown>) => {
                    upserts.push(row);
                    return Promise.resolve({ data: null, error: null });
                }),
            };
            return chain;
        }),
        __upserts: upserts,
    };
}

/** Point the FinaleClient mock at a fixed PO list. */
function stubFinale(pos: Array<Record<string, unknown>>) {
    mockedFinale.mockImplementation(function (this: unknown) {
        return {
            getRecentPurchaseOrders: vi.fn().mockResolvedValue(pos),
        };
    } as any);
}

describe("syncPurchaseOrders — terminal truth from Finale", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const db = fakeDb();
        mockedCreateClient.mockReturnValue(db as any);
    });

    it("preserves lifecycle_state=COMPLETED + receive_date when Finale says Completed", async () => {
        const db = fakeDb();
        mockedCreateClient.mockReturnValue(db as any);
        stubFinale([
            {
                orderId: "125212",
                vendorName: "Aloe Corp",
                vendorPartyId: "10003",
                status: "Completed",
                orderDate: "2026-08-19",
                receiveDate: "2026-08-28",
                total: 3960,
                items: [{ productId: "ACP101", quantity: 20, unitPrice: 198 }],
            },
        ]);

        const stats = await syncPurchaseOrders(90);

        expect(stats.synced).toBe(1);
        const row = db.__upserts[0];
        // Simple display enum still collapsed (consumers depend on it)
        expect(row.status).toBe("received");
        // Terminal truth preserved for the completed-exclusion + receipt leg
        expect(row.lifecycle_state).toBe("COMPLETED");
        expect(row.lifecycle_stage).toBe("COMPLETED");
        expect(row.receive_date).toContain("2026-08-28");
    });

    it("maps Cancelled -> CANCELLED but leaves intermediate states untouched", async () => {
        const db = fakeDb();
        mockedCreateClient.mockReturnValue(db as any);
        stubFinale([
            { orderId: "1001", status: "Received", receiveDate: "2026-08-20", total: 10, items: [] },
            { orderId: "1002", status: "Committed", receiveDate: null, total: 10, items: [] },
            { orderId: "1003", status: "Cancelled", receiveDate: null, total: 10, items: [] },
        ]);

        await syncPurchaseOrders(90);

        const byPo = Object.fromEntries(db.__upserts.map((r) => [r.po_number, r]));
        // Finale "Received" is NOT terminal (pipeline owns RECEIVED state) — no stamp
        expect(byPo["1001"].lifecycle_state).toBeUndefined();
        expect(byPo["1001"].receive_date).toContain("2026-08-20");
        // "Committed" is intermediate — pipeline owns OPEN/ACKNOWLEDGED/etc — no stamp
        expect(byPo["1002"].lifecycle_state).toBeUndefined();
        expect(byPo["1002"].receive_date).toBeUndefined();
        // "Cancelled" IS terminal — stamped
        expect(byPo["1003"].lifecycle_state).toBe("CANCELLED");
        expect(byPo["1003"].receive_date).toBeUndefined();
    });
});
