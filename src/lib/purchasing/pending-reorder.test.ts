/**
 * @file    pending-reorder.test.ts
 * @purpose Unit tests for the WS6.3 pending-reorder overlay (undrafted rec → Active row).
 * @author  Hermia
 * @created 2026-10-29
 */
import { describe, expect, it } from "vitest";
import {
    PENDING_REORDER_LOOKBACK_DAYS,
    derivePendingReordersBySku,
    findPendingReorder,
} from "./pending-reorder";

describe("derivePendingReordersBySku", () => {
    it("keeps the newest undrafted rec per SKU", () => {
        const bySku = derivePendingReordersBySku([
            { product_id: "RAP101", recommended_qty: 900, recommended_at: "2026-10-29T11:15:44-06:00" },
            { product_id: "RAP101", recommended_qty: 1058, recommended_at: "2026-10-29T08:03:24-06:00" },
            { product_id: "BLM212", recommended_qty: 70, recommended_at: "2026-10-29T09:00:00-06:00" },
        ]);
        expect(bySku.get("RAP101")).toEqual({ sku: "RAP101", qty: 900 });
        expect(bySku.get("BLM212")).toEqual({ sku: "BLM212", qty: 70 });
        expect(bySku.size).toBe(2);
    });

    it("is order-independent (does not trust the query's ORDER BY)", () => {
        const bySku = derivePendingReordersBySku([
            { product_id: "SKU1", recommended_qty: 100, recommended_at: "2026-10-28T09:00:00-06:00" },
            { product_id: "SKU1", recommended_qty: 250, recommended_at: "2026-10-29T09:00:00-06:00" },
        ]);
        expect(bySku.get("SKU1")?.qty).toBe(250);
    });

    it("drops rows with no SKU or a non-positive quantity", () => {
        const bySku = derivePendingReordersBySku([
            { product_id: null, recommended_qty: 50 },
            { product_id: "   ", recommended_qty: 50 },
            { product_id: "ZERO", recommended_qty: 0 },
            { product_id: "NEG", recommended_qty: -20 },
            { product_id: "JUNK", recommended_qty: "not-a-number" },
            { product_id: "GOOD", recommended_qty: "12" },
        ]);
        expect([...bySku.keys()]).toEqual(["GOOD"]);
        expect(bySku.get("GOOD")).toEqual({ sku: "GOOD", qty: 12 });
    });

    it("fails soft on empty input", () => {
        expect(derivePendingReordersBySku([]).size).toBe(0);
        expect(derivePendingReordersBySku(null).size).toBe(0);
        expect(derivePendingReordersBySku(undefined).size).toBe(0);
    });

    it("still keeps a row whose timestamp is unparseable (first one wins)", () => {
        const bySku = derivePendingReordersBySku([
            { product_id: "SKU9", recommended_qty: 40, recommended_at: null },
        ]);
        expect(bySku.get("SKU9")).toEqual({ sku: "SKU9", qty: 40 });
    });

    it("keeps the lookback window as a single named constant", () => {
        expect(PENDING_REORDER_LOOKBACK_DAYS).toBe(7);
    });
});

describe("findPendingReorder", () => {
    const bySku = derivePendingReordersBySku([
        { product_id: "RAP101", recommended_qty: 900, recommended_at: "2026-10-29T11:15:44-06:00" },
    ]);

    it("finds the rec on any line of the PO", () => {
        // PO 125283 is a single-line PO in production; a mixed PO must work too.
        expect(findPendingReorder([{ productId: "OTHER" }, { productId: "RAP101" }], bySku))
            .toEqual({ sku: "RAP101", qty: 900 });
        expect(findPendingReorder([{ productId: "RAP101" }], bySku))
            .toEqual({ sku: "RAP101", qty: 900 });
    });

    it("returns undefined when no line is pending", () => {
        expect(findPendingReorder([{ productId: "OTHER" }], bySku)).toBeUndefined();
        expect(findPendingReorder([], bySku)).toBeUndefined();
        expect(findPendingReorder(null, bySku)).toBeUndefined();
        expect(findPendingReorder([{ productId: "RAP101" }], new Map())).toBeUndefined();
        expect(findPendingReorder([{ productId: "RAP101" }], null)).toBeUndefined();
        // A blank line SKU never matches.
        expect(findPendingReorder([{ productId: "  " }], bySku)).toBeUndefined();
    });
});
