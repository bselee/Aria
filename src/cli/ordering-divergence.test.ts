/**
 * @file    src/cli/ordering-divergence.test.ts
 * @purpose Fixture tests for the ordering divergence CLI — the Phase 3
 *          sibling-sweep verification instrument. >3x splits must flag,
 *          <=3x must not, and zero-ledger/zero-history rows must be handled
 *          without false alarms. Pure function — no Finale, no DB, no fs.
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    vitest, ./ordering-divergence
 */
import { describe, expect, it } from "vitest";

import { analyzeDivergence, type DivergenceInputRow } from "./ordering-divergence";

function resale(partial: Partial<DivergenceInputRow> & { productId: string }): DivergenceInputRow {
    return { dailyRateSource: "receipts", ...partial };
}

describe("analyzeDivergence", () => {
    it("flags a >3x reality-cap breach (rice bran case: BOM rate 100x the ledger)", () => {
        // RAWRICEBRAN shape: chosen rate inflated far past the physical signal.
        const rows = analyzeDivergence(
            [resale({ productId: "RAWRICEBRAN", dailyRate: 17224, purchaseVelocity: 173 })],
            [],
        );
        expect(rows[0].flagged).toBe(true);
        expect(rows[0].resaleCapBreach).toBe(true);
        expect(rows[0].crossPathDivergence).toBe(false);
    });

    it("does not flag a <=3x split", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "BLV101", dailyRate: 12, purchaseVelocity: 5 })],
            [],
        );
        expect(rows[0].flagged).toBe(false);
        expect(rows[0].resaleCapBreach).toBe(false);
    });

    it("flags cross-path divergence when resale and BOM paths disagree >3x on one SKU", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "CFR101", dailyRate: 9, purchaseVelocity: 9 })],
            [{ productId: "CFR101", dailyRate: 40, dailyRateSource: "demand", purchaseVelocity: 9 }],
        );
        expect(rows[0].crossPathDivergence).toBe(true);
        expect(rows[0].flagged).toBe(true);
    });

    it("does not flag cross-path agreement", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "GRIP101", dailyRate: 0.6, purchaseVelocity: 0.6 })],
            [{ productId: "GRIP101", dailyRate: 1.2, dailyRateSource: "demand", purchaseVelocity: 0.6 }],
        );
        expect(rows[0].crossPathDivergence).toBe(false);
        expect(rows[0].flagged).toBe(false);
    });

    it("handles a zero-ledger row — falls back to receipts, no false flag", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "LABELX", dailyRate: 4, dailyRateSource: "demand", purchaseVelocity: 0 })],
            [],
        );
        // chosen 4 vs receipts 0: no physical evidence, cap cannot assert.
        expect(rows[0].flagged).toBe(false);
        expect(rows[0].receipts).toBe(0);
    });

    it("handles a SKU present on only one path (no cross-path false positive)", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "SOLO1", dailyRate: 10, purchaseVelocity: 10 })],
            [],
        );
        expect(rows[0].bomRate).toBeNull();
        expect(rows[0].flagged).toBe(false);
    });

    it("treats null/negative rates as no signal", () => {
        const rows = analyzeDivergence(
            [resale({ productId: "NULLY", dailyRate: null, purchaseVelocity: -3 })],
            [{ productId: "NULLY", dailyRate: 0 }],
        );
        expect(rows[0].flagged).toBe(false);
        expect(rows[0].resaleRate).toBeNull();
        expect(rows[0].bomRate).toBeNull();
    });

    it("sorts flagged rows first", () => {
        const rows = analyzeDivergence(
            [
                resale({ productId: "AAA", dailyRate: 1, purchaseVelocity: 1 }),
                resale({ productId: "ZZZ", dailyRate: 99, purchaseVelocity: 1 }),
            ],
            [],
        );
        expect(rows[0].productId).toBe("ZZZ");
        expect(rows[0].flagged).toBe(true);
    });
});
