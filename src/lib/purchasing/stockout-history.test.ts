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
