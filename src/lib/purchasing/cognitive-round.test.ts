// src/lib/purchasing/cognitive-round.test.ts
import { describe, it, expect } from "vitest";
import { roundToCleanQty } from "./cognitive-round";

describe("cognitive ladder (no historical, no explicit)", () => {
    it("snaps 22 to 25 (nearest 5; tier <30)", () => {
        const r = roundToCleanQty({ rawQty: 22 });
        expect(r.snappedQty).toBe(25);
        expect(r.method).toBe("cognitive");
    });

    it("snaps 31 to 30 (nearest 10; tier 30-99; down by 1 wins)", () => {
        const r = roundToCleanQty({ rawQty: 31 });
        expect(r.snappedQty).toBe(30);
    });

    it("snaps 591 to 600 (nearest 100; tier 250-749 is 50 step but 591 is in tier 750-2499? no, in 250-749 → step 50 → 600)", () => {
        const r = roundToCleanQty({ rawQty: 591 });
        // tier 250-749 → step 50 → nearest is 600 (Δ9) vs 550 (Δ41) → 600
        expect(r.snappedQty).toBe(600);
    });

    it("snaps 817 to 800 (nearest 100; tier 750-2499)", () => {
        const r = roundToCleanQty({ rawQty: 817 });
        expect(r.snappedQty).toBe(800);
    });

    it("equidistant prefers higher (Will's 'usually up' rule)", () => {
        const r = roundToCleanQty({ rawQty: 75 });  // equidistant 70 vs 80 (tier 30-99 → step 10)
        expect(r.snappedQty).toBe(80);
    });

    it("does not snap a zero or negative qty", () => {
        expect(roundToCleanQty({ rawQty: 0 }).snappedQty).toBe(0);
        expect(roundToCleanQty({ rawQty: -5 }).snappedQty).toBe(0);
    });

    it("snaps qty <5 up to the smallest cognitive tier (5)", () => {
        expect(roundToCleanQty({ rawQty: 1 }).snappedQty).toBe(5);
        expect(roundToCleanQty({ rawQty: 4 }).snappedQty).toBe(5);
    });

    it("emits two alternative snap targets for the UI dropdown", () => {
        const r = roundToCleanQty({ rawQty: 591 });
        expect(r.alternatives).toHaveLength(2);
        // Should include 550 and/or 650 (one tier-step above and below the snap)
    });
});

describe("historical favorites (cluster detection)", () => {
    it("detects [500, 1000] cluster from 6 historical qtys", () => {
        const r = roundToCleanQty({
            rawQty: 591,
            historicalQtys: [500, 1000, 500, 500, 1000, 500],
        });
        expect(r.snappedQty).toBe(500);
        expect(r.method).toBe("historical");
        expect(r.detail).toContain("500");
    });

    it("snaps 817 to 1000 with the same Colorful history (past midpoint 750)", () => {
        const r = roundToCleanQty({
            rawQty: 817,
            historicalQtys: [500, 1000, 500, 500, 1000, 500],
        });
        expect(r.snappedQty).toBe(1000);
        expect(r.method).toBe("historical");
    });

    it("ignores historical when raw is 10× the largest favorite (out of range)", () => {
        const r = roundToCleanQty({
            rawQty: 5,
            historicalQtys: [500, 1000, 500, 500, 1000],
        });
        expect(r.snappedQty).toBe(5);
        expect(r.method).toBe("cognitive");
    });

    it("requires ≥2 occurrences for a value to be a favorite", () => {
        // Only 500 appears 2x (qualifies). 600/700/800/900 each appear once → no cluster.
        const r = roundToCleanQty({
            rawQty: 591,
            historicalQtys: [500, 600, 700, 800, 900, 500],
        });
        expect(r.snappedQty).toBe(500);
        expect(r.method).toBe("historical");
    });

    it("falls back to cognitive when no value clusters", () => {
        const r = roundToCleanQty({
            rawQty: 591,
            historicalQtys: [500, 600, 700, 800, 900, 1000],
        });
        expect(r.method).toBe("cognitive");
        expect(r.snappedQty).toBe(600);
    });
});

describe("explicit favorites (vendor_reorder_policies.favorite_batches)", () => {
    it("explicit override beats historical learning", () => {
        const r = roundToCleanQty({
            rawQty: 591,
            historicalQtys: [500, 500, 500, 1000],
            explicitFavorites: [250, 750],
        });
        expect(r.snappedQty).toBe(750);
        expect(r.method).toBe("vendor_explicit");
    });

    it("treats empty array override as null (falls through to history)", () => {
        const r = roundToCleanQty({
            rawQty: 591,
            historicalQtys: [500, 500, 1000],
            explicitFavorites: [],
        });
        expect(r.method).toBe("historical");
        expect(r.snappedQty).toBe(500);
    });

    it("works with single-favorite override", () => {
        const r = roundToCleanQty({
            rawQty: 591,
            explicitFavorites: [1000],
        });
        expect(r.snappedQty).toBe(1000);
        expect(r.method).toBe("vendor_explicit");
    });
});

describe("pack increment interaction", () => {
    it("respects pack increment by snapping to nearest pack-multiple of the cognitive snap", () => {
        // raw 22, pack 12 → cognitive says 25, but 25 isn't a multiple of 12.
        // Nearest pack-multiple to 25 is 24. Should be 24.
        const r = roundToCleanQty({ rawQty: 22, packIncrement: 12 });
        expect(r.snappedQty).toBe(24);
        expect(r.detail).toContain("pack 12");
    });

    it("returns rawQty when pack alone already gives a clean number", () => {
        const r = roundToCleanQty({ rawQty: 60, packIncrement: 60 });
        // 60 is already pack-aligned and a multiple of 10 (clean). No snap needed.
        expect(r.snappedQty).toBe(60);
    });

    it("never returns below rawQty when packIncrement is set (hard vendor constraint)", () => {
        // raw 108 (the recommender already pack-rounded 98 → 108 in step 7).
        // Cognitive ladder snaps 108 → 100 (tier 100-249, step 25). The
        // pack-12 multiples adjacent to 100 are 96 (Δ4) and 108 (Δ8); 96 wins
        // by distance — but 96 < 108 underbuys the pack-rounded demand.
        // Floor forces the result back up to 108.
        const r = roundToCleanQty({ rawQty: 108, packIncrement: 12 });
        expect(r.snappedQty).toBe(108);
    });
});
