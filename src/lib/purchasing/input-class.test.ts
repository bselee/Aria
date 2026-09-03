/**
 * @file    input-class.test.ts
 * @purpose Unit tests for input classification, class-aware slack tiers, and
 *          the autonomy-draft gate. Includes the verified 2026-08-24 live-data
 *          split (6 BIG_INPUT / 3 SMALL) and exact slack boundary tables.
 * @author  Hermia
 * @created 2026-08-24
 * @deps    vitest, input-class
 */

import { describe, it, expect } from 'vitest';
import {
    classifyLine,
    slackTier,
    mayAutonomyDraft,
    SMALL_ACT_SLACK,
    SMALL_PLAN_SLACK,
    BIG_ACT_SLACK,
    BIG_PLAN_SLACK,
    type InputClass,
} from './input-class';

/** Build a LineInput with sensible small defaults, overriding as needed. */
function line(overrides: Partial<Parameters<typeof classifyLine>[0]> = {}) {
    return {
        sku: 'TEST',
        lineDollars: 100,
        suggestedQty: 100,
        dailyRate: 1,
        ...overrides,
    };
}

describe('classifyLine — verified split from live data (2026-08-24)', () => {
    it.each([
        ['RAWRICEBRAN', { lineDollars: 10920 }],
        ['RAWSEACOASTCOMPOST', { lineDollars: 8715 }],
        ['RAP101', { lineDollars: 6512 }],
        ['GA101', { lineDollars: 4600 }],
        ['APL102', { dailyRate: 105.82 }],
        ['SBD21410711', { dailyRate: 55.51 }],
    ] as const)('classifies %s as BIG_INPUT', (sku, overrides) => {
        const result = classifyLine(line({ sku, ...overrides }));
        expect(result.class).toBe('BIG_INPUT');
        expect(result.why.length).toBeGreaterThan(0);
    });

    it.each([
        ['CHC101', { lineDollars: 2459 }],
        ['GLB207', { lineDollars: 1250 }],
        ['THC101', { lineDollars: 225 }],
    ] as const)('classifies %s as SMALL', (sku, overrides) => {
        const result = classifyLine(line({ sku, ...overrides }));
        expect(result.class).toBe('SMALL');
        expect(result.why.length).toBeGreaterThan(0);
    });

    it.each([
        ['dollars threshold', { lineDollars: 4000 }],
        ['qty threshold', { suggestedQty: 10000 }],
        ['rate threshold', { dailyRate: 50 }],
    ] as const)('BIG_INPUT at the exact %s boundary (inclusive)', (_label, overrides) => {
        expect(classifyLine(line(overrides)).class).toBe('BIG_INPUT');
    });

    it.each([
        ['dollars just under', { lineDollars: 3999.99 }],
        ['qty just under', { suggestedQty: 9999 }],
        ['rate just under', { dailyRate: 49.99 }],
    ] as const)('SMALL just under the %s boundary', (_label, overrides) => {
        expect(classifyLine(line(overrides)).class).toBe('SMALL');
    });
});

describe('classifyLine — freightConstrained forces BIG_INPUT', () => {
    it('forces BIG_INPUT even with tiny dollars, qty, and rate', () => {
        const result = classifyLine(
            line({ sku: 'TINY', lineDollars: 12, suggestedQty: 3, dailyRate: 0.2, freightConstrained: true }),
        );
        expect(result.class).toBe('BIG_INPUT');
        expect(result.why).toMatch(/freight/i);
    });

    it('stays SMALL when freightConstrained is false and all metrics are tiny', () => {
        expect(
            classifyLine(line({ lineDollars: 12, suggestedQty: 3, dailyRate: 0.2, freightConstrained: false })).class,
        ).toBe('SMALL');
    });
});

describe('slackTier — boundary table', () => {
    it.each([
        // SMALL: slack < 14 -> ACT, slack < 30 -> PLAN, else WATCH
        ['SMALL', 13.9, 'ACT'],
        ['SMALL', 14, 'PLAN'],
        ['SMALL', 29.9, 'PLAN'],
        ['SMALL', 30, 'WATCH'],
        // BIG_INPUT: slack < 25 -> ACT, slack < 45 -> PLAN, else WATCH
        ['BIG_INPUT', 24.9, 'ACT'],
        ['BIG_INPUT', 25, 'PLAN'],
        ['BIG_INPUT', 44.9, 'PLAN'],
        ['BIG_INPUT', 45, 'WATCH'],
    ] as const)('%s with %.1f days slack -> %s', (inputClass, slackDays, expected) => {
        expect(slackTier(slackDays, inputClass)).toBe(expected);
    });

    it.each(['SMALL', 'BIG_INPUT'] as const)('null slack -> ACT for %s (missing data is not permission to relax)', (inputClass) => {
        expect(slackTier(null, inputClass)).toBe('ACT');
    });

    it('uses the exported threshold constants', () => {
        expect(SMALL_ACT_SLACK).toBe(14);
        expect(SMALL_PLAN_SLACK).toBe(30);
        expect(BIG_ACT_SLACK).toBe(25);
        expect(BIG_PLAN_SLACK).toBe(45);
    });
});

describe('mayAutonomyDraft', () => {
    it('returns true only for SMALL', () => {
        const classes: InputClass[] = ['SMALL', 'BIG_INPUT'];
        expect(mayAutonomyDraft('SMALL')).toBe(true);
        expect(classes.filter(mayAutonomyDraft)).toEqual(['SMALL']);
    });

    it('never auto-drafts BIG_INPUT even at huge dollars (production risk needs human eyes)', () => {
        expect(mayAutonomyDraft(classifyLine(line({ sku: 'HUGE', lineDollars: 100000 })).class)).toBe(false);
    });
});
