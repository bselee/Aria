import { describe, it, expect } from 'vitest';
import { leadTimeMultiplierFromStockouts } from './stockout-history';

describe('leadTimeMultiplierFromStockouts', () => {
    it('returns 1 when no events', () => {
        expect(leadTimeMultiplierFromStockouts(0)).toBe(1);
    });
    it('returns 1.5 for one event', () => {
        expect(leadTimeMultiplierFromStockouts(1)).toBe(1.5);
    });
    it('returns 2.0 for two events', () => {
        expect(leadTimeMultiplierFromStockouts(2)).toBe(2);
    });
    it('caps at 2.5 for three or more events', () => {
        expect(leadTimeMultiplierFromStockouts(3)).toBe(2.5);
        expect(leadTimeMultiplierFromStockouts(10)).toBe(2.5);
        expect(leadTimeMultiplierFromStockouts(100)).toBe(2.5);
    });
});

// ── loadStockoutCounts windowDays parameter ───────────────────────────────────
// These tests verify the interface contract — not the Supabase query (no DB in CI).
// The function signature must accept an optional windowDays param without breaking.
import { loadStockoutCounts } from './stockout-history';

describe('loadStockoutCounts windowDays parameter', () => {
    it('accepts default (180d) with no arguments — backward-compatible', async () => {
        // No Supabase in CI — returns empty Map. We just verify it does not throw.
        const result = await loadStockoutCounts();
        expect(result).toBeInstanceOf(Map);
    });
    it('accepts custom window (365d) without throwing', async () => {
        const result = await loadStockoutCounts(365);
        expect(result).toBeInstanceOf(Map);
    });
    it('accepts a short window (30d) without throwing', async () => {
        const result = await loadStockoutCounts(30);
        expect(result).toBeInstanceOf(Map);
    });
});
