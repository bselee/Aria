/**
 * @file    src/lib/storage/po-cache-change.test.ts
 * @purpose Regression lock for po-finale-sync flood fix: unchanged cache
 *          must not enqueue (enqueued === 0 path).
 * @author  Hermia
 * @created 2026-08-07
 */
import { describe, expect, it } from "vitest";
import { poCacheNeedsEnqueue, type POCacheChangeFields } from "./po-cache-change";

const BASE: POCacheChangeFields = {
    status: "ORDERED",
    total_amount: 100.5,
    line_items: JSON.stringify([{ sku: "A", qty: 1 }]),
    lifecycle_state: "open",
    estimated_eta: "2026-08-15",
    updated_at: "2026-08-07T12:00:00.000Z",
};

describe("poCacheNeedsEnqueue", () => {
    it("returns true when cache is missing (new PO)", () => {
        expect(poCacheNeedsEnqueue(null, BASE)).toBe(true);
        expect(poCacheNeedsEnqueue(undefined, BASE)).toBe(true);
    });

    it("returns false when every watched field is unchanged", () => {
        // Regression: po-finale-sync flood — unchanged → enqueued === 0
        expect(poCacheNeedsEnqueue({ ...BASE }, { ...BASE })).toBe(false);
    });

    it("returns true when status changes", () => {
        expect(
            poCacheNeedsEnqueue(BASE, { ...BASE, status: "COMPLETED" }),
        ).toBe(true);
    });

    it("returns true when total_amount changes", () => {
        expect(
            poCacheNeedsEnqueue(BASE, { ...BASE, total_amount: 101 }),
        ).toBe(true);
    });

    it("returns true when line_items change", () => {
        expect(
            poCacheNeedsEnqueue(BASE, {
                ...BASE,
                line_items: JSON.stringify([{ sku: "A", qty: 2 }]),
            }),
        ).toBe(true);
    });

    it("returns true when lifecycle_state changes", () => {
        expect(
            poCacheNeedsEnqueue(BASE, { ...BASE, lifecycle_state: "received" }),
        ).toBe(true);
    });

    it("returns true when estimated_eta changes", () => {
        expect(
            poCacheNeedsEnqueue(BASE, { ...BASE, estimated_eta: "2026-08-20" }),
        ).toBe(true);
    });

    it("returns true when updated_at changes", () => {
        expect(
            poCacheNeedsEnqueue(BASE, {
                ...BASE,
                updated_at: "2026-08-07T13:00:00.000Z",
            }),
        ).toBe(true);
    });

    it("simulates a full sync batch: all unchanged → enqueued count 0", () => {
        const batch = [
            { ...BASE, status: "ORDERED" },
            { ...BASE, status: "PARTIAL", total_amount: 50 },
            { ...BASE, lifecycle_state: "in_transit" },
        ];
        let enqueued = 0;
        for (const row of batch) {
            if (poCacheNeedsEnqueue(row, row)) enqueued++;
        }
        expect(enqueued).toBe(0);
    });
});
