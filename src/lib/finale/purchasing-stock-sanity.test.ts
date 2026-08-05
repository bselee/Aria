/**
 * @file    src/lib/finale/purchasing-stock-sanity.test.ts
 * @purpose Regression guard for the 2026-07-30 Finale schema break.
 *
 *          Finale silently removed `orderIncrementQuantity` from the GraphQL
 *          `product` type. Every getProductActivity() call threw, so every SKU
 *          returned null stock -> runway 0 -> 282/303 items flagged "critical"
 *          and ~$1.2M of bogus order recommendations hit the Ordering screen.
 *
 *          These tests pin the two defenses:
 *            1. the missing-stock ratio gate that aborts a poisoned scan
 *            2. the stdPackingUnitsPerCase fallback chain for order increment
 * @author  Hermia
 * @created 2026-07-30
 */
import { describe, it, expect } from "vitest";

/** Mirrors the constants in purchasing.ts. Keep in sync. */
const MAX_MISSING_STOCK_RATIO = 0.5;
const MIN_ITEMS_FOR_STOCK_SANITY_CHECK = 20;

/** Extracted decision logic from the abort block in getPurchasingIntelligence. */
function shouldAbortScan(items: Array<{ stockOnHand: number | null }>): boolean {
    if (items.length < MIN_ITEMS_FOR_STOCK_SANITY_CHECK) return false;
    const missing = items.filter(i => i.stockOnHand == null).length;
    return missing / items.length > MAX_MISSING_STOCK_RATIO;
}

/** Mirrors the order-increment fallback chain. */
function resolveOrderIncrement(prod: {
    orderIncrementQuantity?: number | null;
    stdPackingUnitsPerCase?: number | null;
    activityIncrement?: number | null;
}): number | null {
    return prod.orderIncrementQuantity
        ?? prod.stdPackingUnitsPerCase
        ?? prod.activityIncrement
        ?? null;
}

const mk = (n: number, stock: number | null) =>
    Array.from({ length: n }, () => ({ stockOnHand: stock }));

describe("purchasing stock sanity gate", () => {
    it("ABORTS the 2026-07-30 scenario: 301/303 items with null stock", () => {
        const items = [...mk(301, null), ...mk(2, 500)];
        expect(shouldAbortScan(items)).toBe(true);
    });

    it("allows a healthy scan where nearly all items have stock", () => {
        const items = [...mk(295, 100), ...mk(8, null)];
        expect(shouldAbortScan(items)).toBe(false);
    });

    it("tolerates a normal minority of unstocked SKUs (RMC102/BLM212 pattern)", () => {
        const items = [...mk(200, 50), ...mk(60, null)]; // ~23% missing
        expect(shouldAbortScan(items)).toBe(false);
    });

    it("does not abort on small scans where the ratio is noise", () => {
        const items = mk(10, null); // 100% missing but below min count
        expect(shouldAbortScan(items)).toBe(false);
    });

    it("aborts exactly above the ratio, not at or below it", () => {
        expect(shouldAbortScan([...mk(50, null), ...mk(50, 10)])).toBe(false); // 50%
        expect(shouldAbortScan([...mk(51, null), ...mk(49, 10)])).toBe(true);  // 51%
    });
});

describe("order increment fallback after Finale schema change", () => {
    it("prefers orderIncrementQuantity when Finale still returns it", () => {
        expect(resolveOrderIncrement({
            orderIncrementQuantity: 12,
            stdPackingUnitsPerCase: 6,
        })).toBe(12);
    });

    it("falls back to stdPackingUnitsPerCase once the old field is gone", () => {
        expect(resolveOrderIncrement({
            orderIncrementQuantity: null,
            stdPackingUnitsPerCase: 6,
        })).toBe(6);
    });

    it("falls back to the activity value when neither product field exists", () => {
        expect(resolveOrderIncrement({
            orderIncrementQuantity: null,
            stdPackingUnitsPerCase: null,
            activityIncrement: 24,
        })).toBe(24);
    });

    it("returns null (no rounding) when nothing is available", () => {
        expect(resolveOrderIncrement({})).toBeNull();
    });
});
