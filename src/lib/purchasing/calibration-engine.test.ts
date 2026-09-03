/**
 * @file    src/lib/purchasing/calibration-engine.test.ts
 * @purpose Contract tests for the safety-multiplier derivation. The median
 *          (not mean) must drive self-correction: a vendor under-ordering by
 *          half its lines must widen, even when a few outlier over-orders
 *          skew the mean positive.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    vitest, ./calibration-engine
 * @env     none
 */

import { describe, it, expect } from "vitest";
import { deriveSafetyMultiplier } from "./calibration-engine";

describe("deriveSafetyMultiplier", () => {
    it("returns 1.0 below 5 samples (no signal yet)", () => {
        expect(deriveSafetyMultiplier(4, -65)).toBe(1.0);
        expect(deriveSafetyMultiplier(0, -65)).toBe(1.0);
    });

    it("returns 1.0 when median is null or within tolerance", () => {
        expect(deriveSafetyMultiplier(10, null)).toBe(1.0);
        expect(deriveSafetyMultiplier(10, -24)).toBe(1.0);
        expect(deriveSafetyMultiplier(10, 24)).toBe(1.0);
    });

    it("widens 1.5x for substantial under-ordering (median <= -50)", () => {
        expect(deriveSafetyMultiplier(10, -50)).toBe(1.5);
        expect(deriveSafetyMultiplier(10, -65)).toBe(1.5);
    });

    it("widens 1.25x for under-ordering (median <= -25)", () => {
        expect(deriveSafetyMultiplier(10, -25)).toBe(1.25);
        expect(deriveSafetyMultiplier(10, -49)).toBe(1.25);
    });

    it("tightens 0.75x for substantial over-ordering (median >= +50)", () => {
        expect(deriveSafetyMultiplier(10, 50)).toBe(0.75);
        expect(deriveSafetyMultiplier(10, 120)).toBe(0.75);
    });

    it("tightens 0.85x for over-ordering (median >= +25)", () => {
        expect(deriveSafetyMultiplier(10, 25)).toBe(0.85);
        expect(deriveSafetyMultiplier(10, 49)).toBe(0.85);
    });

    it("Thrive canonical: median -65% widens even though the mean would not", () => {
        // Live data 2026-08-24: Thrive median_error_pct -65% but bias (mean)
        // +18.7%. The median must drive the decision -> 1.5x widen.
        expect(deriveSafetyMultiplier(60, -65)).toBe(1.5);
    });
});
