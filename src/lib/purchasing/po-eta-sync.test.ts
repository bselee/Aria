/**
 * @file    po-eta-sync.test.ts
 * @purpose Unit tests for the sales-order-variant gate in syncPOETA: a dashed
 *          "-S…-DropshipPO" ref has no Finale PURCHASE_ORDER counterpart, so
 *          the dueDate push must be skipped (observably) instead of 404ing.
 * @author  aria-coder
 * @created 2026-10-29
 * @deps    vitest
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    updateOrderDueDate: vi.fn(async () => true),
}));

vi.mock("@/lib/db", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        eq: () => ({
                            maybeSingle: async () => ({ data: null, error: null }),
                        }),
                    }),
                };
            }
            if (table === "ap_activity_log") {
                return { insert: vi.fn(async () => ({ error: null })) };
            }
            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

vi.mock("@/lib/finale/client", () => ({
    finaleClient: {
        updateOrderDueDate: (...args: any[]) => state.updateOrderDueDate(...args),
    },
}));

import { syncPOETA } from "./po-eta-sync";

beforeEach(() => {
    state.updateOrderDueDate.mockClear();
});

describe("syncPOETA (sales-order-variant gate)", () => {
    it("skips the Finale dueDate push for a -S- sales-order variant", async () => {
        const result = await syncPOETA("23582767-S-DropshipPO", "2026-11-01", "test");

        expect(result).toBe(false);
        expect(state.updateOrderDueDate).not.toHaveBeenCalled();
    });

    it("still pushes dueDate for a real Finale PO (plain dropship)", async () => {
        const result = await syncPOETA("23580227-DropshipPO", "2026-11-01", "test");

        expect(result).toBe(true);
        expect(state.updateOrderDueDate).toHaveBeenCalledWith("23580227-DropshipPO", "2026-11-01");
    });
});
