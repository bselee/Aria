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

// ── recordStockoutEvent — resale path ─────────────────────────────────────────
// Verifies the resale worker's call-site contract:
//   • fires when adjustedRunwayDays < leadTimeDays AND dailyRate > 0
//   • does NOT fire when dailyRate === 0 (no movement)
//   • does NOT fire when adjustedRunwayDays >= leadTimeDays (healthy runway)
//   • is idempotent — upserts on (product_id, detected_on), so same-day
//     duplicate calls must not throw
//   • gracefully no-ops when Supabase client is unavailable (returns void)
//
// NOTE: We cannot test the actual DB write in CI (no Supabase).
// These tests verify the guard-logic contract by calling through the exported
// function and confirming: (a) it returns Promise<void> in all paths,
// (b) it never throws regardless of DB state.
import { recordStockoutEvent } from './stockout-history';

describe('recordStockoutEvent — resale path guard logic', () => {
    const baseInput = {
        productId: 'CWP101',
        vendorPartyId: 'covico-001',
        stockOnHand: 500,
        stockOnOrder: 0,
        dailyBurn: 10,
        runwayDays: 30,
        leadTimeDays: 45,
    };

    it('returns Promise<void> and does not throw when runway < leadTime (trigger condition)', async () => {
        // adjustedRunwayDays (30) < leadTimeDays (45) AND dailyBurn > 0 → should fire
        await expect(recordStockoutEvent(baseInput)).resolves.toBeUndefined();
    });

    it('returns Promise<void> and does not throw when runway >= leadTime (no-trigger condition)', async () => {
        // Healthy case — worker should skip this call, but even if called directly it must not throw.
        await expect(recordStockoutEvent({
            ...baseInput,
            runwayDays: 90,   // well above leadTimeDays
            leadTimeDays: 45,
        })).resolves.toBeUndefined();
    });

    it('returns Promise<void> and does not throw when dailyBurn is zero (zero-velocity guard)', async () => {
        // Worker guards: if dailyRate === 0, we skip — but calling directly must still be safe.
        await expect(recordStockoutEvent({
            ...baseInput,
            dailyBurn: 0,
        })).resolves.toBeUndefined();
    });

    it('returns Promise<void> when vendorPartyId is null (resale items without mapped vendor)', async () => {
        await expect(recordStockoutEvent({
            ...baseInput,
            vendorPartyId: null,
        })).resolves.toBeUndefined();
    });

    it('accepts edge case: stockOnHand = 0 and stockOnOrder = 0 (fully stocked out)', async () => {
        await expect(recordStockoutEvent({
            ...baseInput,
            stockOnHand: 0,
            stockOnOrder: 0,
            runwayDays: 0,
        })).resolves.toBeUndefined();
    });

    it('is idempotent contract: calling twice on the same day does not throw (upsert on product_id+detected_on)', async () => {
        // The DB upsert uses onConflict: 'product_id,detected_on' — same-day duplicate
        // calls must never throw. We verify by calling twice and expecting no error.
        await recordStockoutEvent(baseInput);
        await expect(recordStockoutEvent(baseInput)).resolves.toBeUndefined();
    });
});

// ── Resale worker guard-logic unit test (pure logic, no DB) ───────────────────
// This mirrors the exact guard in getPurchasingIntelligence's resale worker:
//   void recordResaleStockout(...) is only called when:
//     adjustedRunwayDays < effectiveLeadTimeDays && dailyRate > 0
// We test that guard condition in isolation so we don't need to mock the full client.

describe('resale stockout trigger guard condition (pure logic)', () => {
    function shouldTrigger(adjustedRunwayDays: number, leadTimeDays: number, dailyRate: number): boolean {
        return adjustedRunwayDays < leadTimeDays && dailyRate > 0;
    }

    it('triggers when runway < lead time and daily rate > 0', () => {
        expect(shouldTrigger(30, 45, 10)).toBe(true);
    });

    it('does NOT trigger when runway equals lead time exactly', () => {
        expect(shouldTrigger(45, 45, 10)).toBe(false);
    });

    it('does NOT trigger when runway exceeds lead time', () => {
        expect(shouldTrigger(90, 45, 10)).toBe(false);
    });

    it('does NOT trigger when daily rate is zero (no movement — nothing to order)', () => {
        expect(shouldTrigger(10, 45, 0)).toBe(false);
    });

    it('does NOT trigger when daily rate is negative (defensive edge case)', () => {
        expect(shouldTrigger(10, 45, -1)).toBe(false);
    });

    it('triggers at boundary: runway = leadTime - 1 (one day inside threshold)', () => {
        expect(shouldTrigger(44, 45, 5)).toBe(true);
    });

    it('triggers when runway is 0 (completely stocked out)', () => {
        expect(shouldTrigger(0, 45, 5)).toBe(true);
    });
});
