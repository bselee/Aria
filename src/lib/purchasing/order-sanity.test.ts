/**
 * @file    src/lib/purchasing/order-sanity.test.ts
 * @purpose Fixture tests for the ordering sanity flag (Phase 2.2).
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    vitest, ./order-sanity
 */
import { describe, expect, it } from "vitest";

import { sanityFlagQty } from "./order-sanity";

describe("sanityFlagQty", () => {
    it("flags the rice-bran case: 1.8M recommendation vs 42K order history", () => {
        const r = sanityFlagQty(1_800_000, [42_000, 40_000, 44_000]);
        expect(r.flag).toBe(true);
        expect(r.detail).toMatch(/42,000/);
    });

    it("does not flag a SKU with no order history", () => {
        const r = sanityFlagQty(500, []);
        expect(r.flag).toBe(false);
        expect(r.detail).toBe("");
    });

    it("a single fill-in order does not skew the median — the recommendation still flags against it", () => {
        // One huge one-off; median == that value, so a sane re-order is fine.
        expect(sanityFlagQty(600, [120_000]).flag).toBe(false);
        // ...but a 10x jump over it still flags (median cannot be dragged).
        expect(sanityFlagQty(1_200_000, [120_000]).flag).toBe(true);
    });

    it("a deliberate buy-up still flags but the flag carries no suppression", () => {
        // Real pattern: buy 4 months instead of 1. Flag fires; caller must
        // still show the quantity — this test pins that the helper returns
        // detail, never an adjusted qty.
        const r = sanityFlagQty(8_000, [2_000, 2_100, 1_950, 2_050]);
        expect(r.flag).toBe(true);
        expect(r.detail).toMatch(/8,000/);
        expect(Object.keys(r)).not.toContain("qty");
    });

    it("within 3x of recent history is normal — no flag", () => {
        expect(sanityFlagQty(2_400, [2_000, 2_200, 1_900]).flag).toBe(false);
    });

    it("handles null/zero recommendations and garbage history", () => {
        expect(sanityFlagQty(0, [2_000]).flag).toBe(false);
        expect(sanityFlagQty(null, [2_000]).flag).toBe(false);
        expect(sanityFlagQty(500, [null, undefined, -5, 0]).flag).toBe(false);
    });

    it("uses only the last 5 orders, not the whole history", () => {
        // Ancient bulk order (1M) must not mute the flag on recent 2K orders.
        const r = sanityFlagQty(10_000, [2_000, 2_000, 2_000, 1_000_000, 2_000, 2_000, 2_000]);
        expect(r.flag).toBe(true);
    });
});
