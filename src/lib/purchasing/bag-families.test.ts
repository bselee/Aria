/**
 * @file bag-families.test.ts
 * @purpose Unit tests for printed-bag variant family derivation and the
 *          ordering-board family check builder.
 * @author Hermia
 * @created 2026-10-28
 * @deps bag-families.ts
 */

import { describe, it, expect } from "vitest";
import { deriveBagFamily, buildBagFamilyChecks, FOLD_IN_WINDOW_DAYS } from './bag-families';

describe('deriveBagFamily', () => {
    it('derives the family stem for standard printed bag SKUs', () => {
        expect(deriveBagFamily('GnarBar01BAG')).toBe('GNARBAR');
        expect(deriveBagFamily('GnarBar06BAG')).toBe('GNARBAR');
        expect(deriveBagFamily('CWP01BAG')).toBe('CWP');
        expect(deriveBagFamily('CWP02BAG')).toBe('CWP');
        expect(deriveBagFamily('BBV101BAG')).toBe('BBV');
        expect(deriveBagFamily('BBV102BAG')).toBe('BBV');
        expect(deriveBagFamily('OAG214BAG')).toBe('OAG');
        expect(deriveBagFamily('CRAFT1BAG')).toBe('CRAFT');
        expect(deriveBagFamily('CRAFT10BAG')).toBe('CRAFT');
    });

    it('strips unit suffixes from size tokens', () => {
        expect(deriveBagFamily('BIG6100GBAG')).toBe('BIG6');
        expect(deriveBagFamily('BIG6300GBAG')).toBe('BIG6');
        expect(deriveBagFamily('BIG61KGBAG')).toBe('BIG6');
        expect(deriveBagFamily('BAV1LBBAG')).toBe('BAV');
        expect(deriveBagFamily('BAF00BAG')).toBe('BAF');
        expect(deriveBagFamily('QUE215BAG')).toBe('QUE');
    });

    it('keeps numeric stems as their own family', () => {
        expect(deriveBagFamily('3.0BAGCP')).toBe('3.0');
    });

    it('returns null for non-bag SKUs', () => {
        expect(deriveBagFamily('S-4128')).toBeNull();
        expect(deriveBagFamily('CWP09')).toBeNull();
        expect(deriveBagFamily('')).toBeNull();
        expect(deriveBagFamily('BAG')).toBeNull();
    });
});

describe('buildBagFamilyChecks', () => {
    const base = {
        suggestedQty: 0,
        urgency: 'ok',
        leadTimeDays: 60,
        covered: false,
    };

    it('emits a family only when a member is actionable and there are 2+ variants', () => {
        const checks = buildBagFamilyChecks([
            { ...base, productId: 'GnarBar06BAG', productName: 'GnarBar Milled 2lb BAG', decision: 'order', suggestedQty: 250, runwayDays: 52.5 },
            { ...base, productId: 'GnarBar01BAG', productName: 'GnarBar Whole 2lb BAG', decision: 'order', suggestedQty: 50, runwayDays: 80 },
            { ...base, productId: 'GnarBar02BAG', productName: 'GnarBar Whole 6lb BAG', decision: 'hold', runwayDays: 178 },
        ]);
        expect(checks).toHaveLength(1);
        expect(checks[0].family).toBe('GNARBAR');
        expect(checks[0].members.map(m => m.sku)).toEqual(['GnarBar06BAG', 'GnarBar01BAG', 'GnarBar02BAG']);
    });

    it('flags a sibling that triggers within the fold-in window (lead + 30 + 30)', () => {
        const checks = buildBagFamilyChecks([
            { ...base, productId: 'GnarBar06BAG', decision: 'order', runwayDays: 52.5 },
            // trigger = 110 - (60 + 30) = 20d → fold in
            { ...base, productId: 'GnarBar01BAG', decision: 'hold', runwayDays: 110 },
            // trigger = 178 - 90 = 88d → too far, hold
            { ...base, productId: 'GnarBar02BAG', decision: 'hold', runwayDays: 178 },
        ]);
        const fam = checks.find(c => c.family === 'GNARBAR')!;
        expect(fam).toBeDefined();
        const near = fam.members.find(m => m.sku === 'GnarBar01BAG')!;
        expect(near.triggerInDays).toBe(20);
        expect(near.foldInNow).toBe(true);
        const far = fam.members.find(m => m.sku === 'GnarBar02BAG')!;
        expect(far.triggerInDays).toBe(88);
        expect(far.foldInNow).toBe(false);
    });

    it('never folds in a member covered by an open/draft PO', () => {
        const checks = buildBagFamilyChecks([
            { ...base, productId: 'GnarBar06BAG', decision: 'order', runwayDays: 52.5 },
            { ...base, productId: 'GnarBar01BAG', decision: 'hold', runwayDays: 110, covered: true },
            { ...base, productId: 'GnarBar02BAG', decision: 'hold', runwayDays: 178 },
        ]);
        const covered = checks.find(c => c.family === 'GNARBAR')!.members.find(m => m.sku === 'GnarBar01BAG')!;
        expect(covered.covered).toBe(true);
        expect(covered.foldInNow).toBe(false);
    });

    it('does not emit singleton families even when actionable', () => {
        const checks = buildBagFamilyChecks([
            { ...base, productId: '3.0BAGCP', decision: 'order', runwayDays: 109 },
            { ...base, productId: 'QUE215BAG', decision: 'hold', runwayDays: 540 },
        ]);
        expect(checks).toHaveLength(0);
    });

    it('does not emit a family with no actionable member', () => {
        const checks = buildBagFamilyChecks([
            { ...base, productId: 'CWP01BAG', decision: 'hold', runwayDays: 300 },
            { ...base, productId: 'CWP02BAG', decision: 'hold', runwayDays: 546 },
        ]);
        expect(checks).toHaveLength(0);
    });

    it('sorts members shortest runway first and respects the fold-in window constant', () => {
        expect(FOLD_IN_WINDOW_DAYS).toBe(30);
        const checks = buildBagFamilyChecks([
            { ...base, productId: 'CWP01BAG', decision: 'order', runwayDays: 200 },
            { ...base, productId: 'CWP02BAG', decision: 'hold', runwayDays: 40 },
        ]);
        expect(checks[0].members.map(m => m.sku)).toEqual(['CWP02BAG', 'CWP01BAG']);
    });
});
