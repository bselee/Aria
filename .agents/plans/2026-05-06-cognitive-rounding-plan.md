# Cognitive Rounding for PO Qty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snap recommended PO quantities to clean numbers (cognitive ladder + historical pattern + explicit override) so Will never sees `591` or `817` on a draft. Spec: `.agents/plans/2026-05-06-cognitive-rounding-design.md`.

**Architecture:** Pure `roundToCleanQty()` helper called by the recommender after pack-rounding and before MOQ enforcement. Three layers: cognitive ladder (magnitude-aware floor), historical favorites (last 8 PO line qtys clustering ≥2×), explicit per-vendor override (`vendor_reorder_policies.favorite_batches`). PurchasingPanel surfaces the snap with a tiny chevron dropdown for one-click overrides. Provenance trace gets one new step.

**Tech Stack:** TypeScript, Vitest, Supabase migration, existing Finale GraphQL client, existing PurchasingPanel.

---

## File Structure

**New files:**
```
src/lib/purchasing/cognitive-round.ts            # pure roundToCleanQty + cognitive ladder + cluster detection
src/lib/purchasing/cognitive-round.test.ts       # comprehensive cases incl. Will's two examples
supabase/migrations/20260506000003_vendor_favorite_batches.sql
```

**Modified files:**
```
src/lib/purchasing/calibration.ts                # +loadVendorRecentLineQtys, +favorite_batches in VendorReorderPolicy
src/lib/purchasing/qty-recommender.ts            # new fields on input/result, pipeline step, version bump
src/lib/purchasing/qty-recommender.test.ts       # add cognitive-round integration cases
src/lib/finale/client.ts                         # historical fetch + pass-through
src/components/dashboard/PurchasingPanel.tsx     # qty input chevron dropdown
src/components/dashboard/PurchasingPanel.test.tsx # dropdown assertion
```

---

## Task 1: Add `favorite_batches` column

**Files:**
- Create: `supabase/migrations/20260506000003_vendor_favorite_batches.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260506000003_vendor_favorite_batches.sql
--
-- Per-vendor explicit "favorite batch sizes" override. When set, takes
-- precedence over historical learning AND the generic cognitive ladder.
-- NULL means "use historical learning + cognitive ladder fallback".

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS favorite_batches INTEGER[];

COMMENT ON COLUMN public.vendor_reorder_policies.favorite_batches IS
    'Explicit batch sizes the recommender should snap to (e.g. {500,1000} for Colorful). When NULL, the recommender learns from PO history; when set, this overrides history.';
```

- [ ] **Step 2: Apply via DATABASE_URL pooler**

```bash
node -e "require('dotenv').config({path:'.env.local'});const{Client}=require('pg');const fs=require('fs');(async()=>{const sql=fs.readFileSync('supabase/migrations/20260506000003_vendor_favorite_batches.sql','utf-8');const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query(sql);console.log('applied');const r=await c.query(\"SELECT column_name,data_type FROM information_schema.columns WHERE table_name='vendor_reorder_policies' AND column_name='favorite_batches'\");console.log(r.rows);await c.end();})().catch(e=>{console.error(e.message);process.exit(1);});"
```

Expected: `applied` followed by `[{ column_name: 'favorite_batches', data_type: 'ARRAY' }]`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260506000003_vendor_favorite_batches.sql
git commit -m "feat(purchasing): add vendor_reorder_policies.favorite_batches column"
```

---

## Task 2: Pure `roundToCleanQty()` helper + tests

**Files:**
- Create: `src/lib/purchasing/cognitive-round.ts`
- Test: `src/lib/purchasing/cognitive-round.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run src/lib/purchasing/cognitive-round.test.ts
```
Expected: FAIL — module `./cognitive-round` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/purchasing/cognitive-round.ts
/**
 * @file    cognitive-round.ts
 * @purpose Snap recommended PO quantities to clean numbers so Will never sees
 *          591 or 817 on a draft. Three layers: cognitive ladder (magnitude-
 *          aware floor), historical favorites (cluster detected from past PO
 *          line qtys), and explicit per-vendor override.
 *
 *          Pure function — no I/O. Composed by qty-recommender after pack
 *          rounding and before MOQ enforcement.
 *
 *          Spec: .agents/plans/2026-05-06-cognitive-rounding-design.md
 */

export interface CognitiveRoundInput {
    rawQty: number;
    packIncrement?: number | null;
    historicalQtys?: number[];
    explicitFavorites?: number[] | null;
}

export interface CognitiveRoundResult {
    snappedQty: number;
    delta: number;
    method: "cognitive" | "historical" | "vendor_explicit" | "noop";
    detail: string;
    alternatives: number[];
}

/**
 * Magnitude-aware cognitive ladder. Returns the step size for the tier
 * containing `qty`. Higher tiers use coarser steps so 591 snaps to 600 (step 50)
 * but 5,591 snaps to 5,500 (step 500) — the absolute snap distance scales
 * roughly with magnitude so the result reads cleanly at every order of magnitude.
 */
function ladderStepFor(qty: number): number {
    if (qty < 30) return 5;
    if (qty < 100) return 10;
    if (qty < 250) return 25;
    if (qty < 750) return 50;
    if (qty < 2500) return 100;
    if (qty < 10_000) return 500;
    return 1_000;
}

/**
 * Snap to the nearest multiple of `step`, with equidistant rounding up
 * (Will's "usually up" preference).
 */
function snapToLadder(qty: number, step: number): number {
    if (qty <= 0) return 0;
    const lower = Math.floor(qty / step) * step;
    const upper = lower + step;
    const dLower = qty - lower;
    const dUpper = upper - qty;
    return dUpper <= dLower ? upper : lower;
}

/**
 * Snap to the nearest favorite in `favorites`. Equidistant prefers higher.
 * Returns null when raw is grossly out of range (>10× max favorite, or
 * <0.1× min favorite) — caller falls back to the cognitive ladder.
 */
function snapToFavorites(qty: number, favorites: number[]): number | null {
    if (favorites.length === 0) return null;
    const sorted = [...favorites].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (qty < min * 0.1 || qty > max * 10) return null;

    let best = sorted[0];
    let bestDelta = Math.abs(qty - best);
    for (const f of sorted) {
        const delta = Math.abs(qty - f);
        if (delta < bestDelta || (delta === bestDelta && f > best)) {
            best = f;
            bestDelta = delta;
        }
    }
    return best;
}

/**
 * Detect cluster favorites in `historical` — values that appear ≥2 times.
 * Returns sorted ascending. Empty when no clustering exists.
 */
function detectFavorites(historical: number[]): number[] {
    if (!historical || historical.length === 0) return [];
    const counts = new Map<number, number>();
    for (const v of historical) {
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .map(([v]) => v)
        .sort((a, b) => a - b);
}

/**
 * After picking a snap target, ensure it's a multiple of packIncrement.
 * If it isn't, round up to the nearest pack-multiple at-or-above the snap
 * (we never round below an explicit snap target — that would defeat the
 * point of the snap). If pack alone is already clean (e.g. pack=60), the
 * snap target is the pack-aligned value.
 */
function honorPack(snapTarget: number, packIncrement: number | null | undefined): number {
    if (!packIncrement || packIncrement <= 1) return snapTarget;
    if (snapTarget % packIncrement === 0) return snapTarget;
    // Find pack-multiples adjacent to the snap target; pick the nearest.
    const lower = Math.floor(snapTarget / packIncrement) * packIncrement;
    const upper = lower + packIncrement;
    const dLower = snapTarget - lower;
    const dUpper = upper - snapTarget;
    return dUpper <= dLower ? upper : lower;
}

export function roundToCleanQty(input: CognitiveRoundInput): CognitiveRoundResult {
    const raw = Math.max(0, Math.floor(input.rawQty || 0));

    // Edge: zero or negative → no work.
    if (raw <= 0) {
        return {
            snappedQty: 0,
            delta: 0,
            method: "noop",
            detail: "No order needed.",
            alternatives: [],
        };
    }

    // Edge: tiny qty (<5) → smallest cognitive tier.
    if (raw < 5) {
        const result = honorPack(5, input.packIncrement);
        return {
            snappedQty: result,
            delta: result - raw,
            method: "cognitive",
            detail: `Bumped tiny qty ${raw} to smallest clean tier (5)${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
            alternatives: [],
        };
    }

    // ─── Layer 3 — explicit override ────────────────────────────────────
    const explicit = (input.explicitFavorites && input.explicitFavorites.length > 0)
        ? input.explicitFavorites
        : null;
    if (explicit) {
        const snap = snapToFavorites(raw, explicit);
        if (snap != null) {
            const result = honorPack(snap, input.packIncrement);
            const sorted = [...explicit].sort((a, b) => a - b);
            const idx = sorted.indexOf(snap);
            const alternatives = [
                idx > 0 ? sorted[idx - 1] : null,
                idx < sorted.length - 1 ? sorted[idx + 1] : null,
            ].filter((x): x is number => x != null);
            return {
                snappedQty: result,
                delta: result - raw,
                method: "vendor_explicit",
                detail: `Snapped ${raw} to ${result} (vendor policy favorite_batches=[${sorted.join(", ")}])${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
                alternatives,
            };
        }
        // Out of range — fall through to historical/cognitive.
    }

    // ─── Layer 2 — historical favorites (cluster ≥2×) ───────────────────
    const learned = detectFavorites(input.historicalQtys ?? []);
    if (learned.length > 0) {
        const snap = snapToFavorites(raw, learned);
        if (snap != null) {
            const result = honorPack(snap, input.packIncrement);
            const idx = learned.indexOf(snap);
            const alternatives = [
                idx > 0 ? learned[idx - 1] : null,
                idx < learned.length - 1 ? learned[idx + 1] : null,
            ].filter((x): x is number => x != null);
            const occurrences = (input.historicalQtys ?? []).filter(v => v === snap).length;
            return {
                snappedQty: result,
                delta: result - raw,
                method: "historical",
                detail: `Snapped ${raw} to ${result} (matches ${occurrences} of last ${input.historicalQtys?.length ?? 0} POs at ${snap}; nearest of [${learned.join(", ")}])${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
                alternatives,
            };
        }
        // Out of range — fall through to cognitive.
    }

    // ─── Layer 1 — cognitive ladder (always-on floor) ───────────────────
    const step = ladderStepFor(raw);
    const snap = snapToLadder(raw, step);
    const result = honorPack(snap, input.packIncrement);
    // Two alternatives: the next tier-step below and above the snap (or the rounded raw if below).
    const alts: number[] = [];
    if (snap - step > 0) alts.push(snap - step);
    alts.push(snap + step);
    return {
        snappedQty: result,
        delta: result - raw,
        method: "cognitive",
        detail: `Snapped ${raw} to ${result} (nearest ${step}; tier ${
            raw < 30 ? "<30" : raw < 100 ? "30-99" : raw < 250 ? "100-249"
            : raw < 750 ? "250-749" : raw < 2500 ? "750-2499"
            : raw < 10000 ? "2500-9999" : "≥10000"
        })${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
        alternatives: alts,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/purchasing/cognitive-round.test.ts
```
Expected: 19 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/purchasing/cognitive-round.ts src/lib/purchasing/cognitive-round.test.ts
git commit -m "feat(purchasing): pure roundToCleanQty helper (cognitive + historical + explicit)"
```

---

## Task 3: Wire `roundToCleanQty` into the recommender

**Files:**
- Modify: `src/lib/purchasing/qty-recommender.ts`
- Modify: `src/lib/purchasing/qty-recommender.test.ts`

- [ ] **Step 1: Add failing test for the new pipeline step**

Append to `qty-recommender.test.ts`:

```ts
describe("recommendQty — cognitive rounding integration", () => {
    it("Will's example: 591 raw + Colorful history snaps to 500 with historical_round provenance", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10,
            stockOnHand: 0,
            stockOnOrder: 0,
            leadTimeDays: 21,
            targetCoverDays: 60,    // 10/d × 60d = 600 raw need; close to Colorful 500/1000 cluster
            historicalLineQtys: [500, 1000, 500, 500, 1000, 500],
        }));
        // Raw need 600, historical snap → 500 (closer than 1000)
        // Wait: 600 is equidistant from 500 (Δ100) and 1000 (Δ400). So nearest = 500.
        expect(result.suggestedQty).toBe(500);
        expect(result.roundingMethod).toBe("historical");
        const step = result.provenance.find(p => p.step === "historical_round");
        expect(step).toBeDefined();
        expect(step?.detail).toContain("500");
    });

    it("explicit favoriteBatches overrides historical", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10, stockOnHand: 0, leadTimeDays: 21, targetCoverDays: 60,
            historicalLineQtys: [500, 500, 1000, 500],
            favoriteBatches: [250, 750],
        }));
        // Raw 600, explicit favorites [250, 750] — nearest is 750.
        expect(result.suggestedQty).toBe(750);
        expect(result.roundingMethod).toBe("vendor_explicit");
        expect(result.provenance.find(p => p.step === "vendor_round")).toBeDefined();
    });

    it("no history + no explicit → cognitive ladder", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 0, leadTimeDays: 14, coverBufferDays: 8,  // 1/d × 22d = 22 raw
        }));
        expect(result.suggestedQty).toBe(25);
        expect(result.roundingMethod).toBe("cognitive");
        expect(result.provenance.find(p => p.step === "cognitive_round")).toBeDefined();
    });

    it("MOQ still wins over cognitive snap", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 0, leadTimeDays: 14, coverBufferDays: 8,  // raw 22
            minimumOrderEaches: 100,
            moqMode: "enforce",
        }));
        // Cognitive snaps 22 → 25, MOQ bumps 25 → 100.
        expect(result.suggestedQty).toBe(100);
        expect(result.moqApplied).toBe(true);
    });

    it("formula version is bumped to v2.2", () => {
        expect(QTY_FORMULA_VERSION).toBe("v2.2-cognitive-round-2026-05-06");
    });

    it("emits 2 rounding alternatives for the UI dropdown", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10, stockOnHand: 0, leadTimeDays: 21, targetCoverDays: 60,
            historicalLineQtys: [500, 1000, 500, 500, 1000, 500],
        }));
        expect(result.roundingAlternatives).toBeDefined();
        expect(result.roundingAlternatives!.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts
```
Expected: FAIL — `roundingMethod` undefined / formulaVersion mismatch.

- [ ] **Step 3: Bump formula version**

In `src/lib/purchasing/qty-recommender.ts`:

```ts
// Bumped on every behavioral change so the calibration loop can bucket
// error rates per formula. See .agents/plans/2026-05-05-canonical-recommender.md.
//   v2.0-calibrated-2026-05-05 — phase 2 calibration baseline
//   v2.1-vendor-policy-2026-05-06 — vendor reorder policy overrides
//   v2.2-cognitive-round-2026-05-06 — cognitive/historical PO qty rounding
export const QTY_FORMULA_VERSION = "v2.2-cognitive-round-2026-05-06";
```

- [ ] **Step 4: Add new fields to `RecommenderInput`**

Append to the existing `RecommenderInput` interface (after `overbuyReviewDollars`):

```ts
    /**
     * v2.2 — last N completed PO line qtys for this vendor (across SKUs is fine
     * — vendors tend to use consistent batch sizes for related products).
     * Used by cognitive rounding to detect favorite-batch clusters.
     */
    historicalLineQtys?: number[];
    /**
     * v2.2 — explicit per-vendor favorite batches from
     * vendor_reorder_policies.favorite_batches. When set (non-empty), overrides
     * historical learning.
     */
    favoriteBatches?: number[] | null;
```

- [ ] **Step 5: Add new fields to `RecommenderResult`**

Append to the existing `RecommenderResult` interface (after `reviewReasons`):

```ts
    /** v2.2 — which rounding layer fired (cognitive/historical/vendor_explicit), or null if no rounding was needed (qty was 0). */
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    /** v2.2 — two alternative snap targets for the UI override dropdown. */
    roundingAlternatives?: number[];
```

- [ ] **Step 6: Insert the rounding step into the pipeline**

In `recommendQty`, find the `// ── Step 7: pack rounding ─────────...` block. After it (before MOQ), insert:

```ts
    // ── Step 7.5: cognitive/historical/explicit rounding ──────────────────
    // v2.2 — never present an odd number on a draft PO. Snap to a clean number
    // using the historical pattern when available, the explicit override when
    // set, or the magnitude-aware cognitive ladder otherwise.
    let roundingMethod: "cognitive" | "historical" | "vendor_explicit" | null = null;
    let roundingAlternatives: number[] = [];
    if (suggestedQty > 0) {
        const { roundToCleanQty } = await import("./cognitive-round");
        const round = roundToCleanQty({
            rawQty: suggestedQty,
            packIncrement: orderIncrementQty,
            historicalQtys: input.historicalLineQtys,
            explicitFavorites: input.favoriteBatches ?? null,
        });
        if (round.method !== "noop" && round.snappedQty !== suggestedQty) {
            const stepName = round.method === "historical" ? "historical_round"
                : round.method === "vendor_explicit" ? "vendor_round"
                : "cognitive_round";
            trace.push({
                step: stepName,
                detail: round.detail,
                value: round.snappedQty,
            });
            suggestedQty = round.snappedQty;
        }
        roundingMethod = round.method === "noop" ? null : round.method;
        roundingAlternatives = round.alternatives;
    }
```

`recommendQty` is currently sync. The dynamic `await import()` requires making it `async`. Easier path: make the import static at the top of the file:

```ts
import { roundToCleanQty } from "./cognitive-round";
```

Then drop the `await import` and just use the named import. Update the step body accordingly:

```ts
    if (suggestedQty > 0) {
        const round = roundToCleanQty({
            rawQty: suggestedQty,
            packIncrement: orderIncrementQty,
            historicalQtys: input.historicalLineQtys,
            explicitFavorites: input.favoriteBatches ?? null,
        });
        if (round.method !== "noop" && round.snappedQty !== suggestedQty) {
            const stepName = round.method === "historical" ? "historical_round"
                : round.method === "vendor_explicit" ? "vendor_round"
                : "cognitive_round";
            trace.push({
                step: stepName,
                detail: round.detail,
                value: round.snappedQty,
            });
            suggestedQty = round.snappedQty;
        }
        roundingMethod = round.method === "noop" ? null : round.method;
        roundingAlternatives = round.alternatives;
    }
```

- [ ] **Step 7: Add the new fields to the return object**

Find the `return { sku: input.sku, ..., reviewReasons, };` block at the bottom of `recommendQty`. Add `roundingMethod` and `roundingAlternatives` before the closing brace:

```ts
        moqApplied,
        moqWarning,
        reviewRequired,
        reviewReasons,
        roundingMethod,
        roundingAlternatives,
    };
```

- [ ] **Step 8: Run all recommender tests**

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts src/lib/purchasing/cognitive-round.test.ts
```
Expected: all passing (existing 40 + 6 new + 19 helper tests = 65 total).

- [ ] **Step 9: Commit**

```bash
git add src/lib/purchasing/qty-recommender.ts src/lib/purchasing/qty-recommender.test.ts
git commit -m "$(cat <<'EOF'
feat(purchasing): cognitive rounding in recommender (v2.2)

Inserts roundToCleanQty() between pack rounding and MOQ enforcement.
Adds two inputs (historicalLineQtys, favoriteBatches) and two outputs
(roundingMethod, roundingAlternatives).

Will's two examples now produce the expected outputs:
  raw 591 + Colorful history [500,1000,500,500,1000,500] → 500
  raw 817 + same history → 1000

Bumps QTY_FORMULA_VERSION to v2.2-cognitive-round-2026-05-06.
EOF
)"
```

---

## Task 4: Historical batch loader

**Files:**
- Modify: `src/lib/purchasing/calibration.ts`

- [ ] **Step 1: Extend `VendorReorderPolicy` interface to include favoriteBatches**

In `src/lib/purchasing/calibration.ts`, find `interface VendorReorderPolicy` and add:

```ts
    /** v2.2 — explicit favorite batches override (vendor_reorder_policies.favorite_batches). NULL when not set. */
    favoriteBatches: number[] | null;
```

- [ ] **Step 2: Update `loadVendorReorderPolicies` to read the new column**

Find the `loadVendorReorderPolicies` function. Update the `.select(...)` to include `favorite_batches`:

```ts
        const { data } = await db
            .from("vendor_reorder_policies")
            .select("vendor_party_id, vendor_name, lead_time_override_days, target_cover_days, moq_mode, overbuy_review_pct, overbuy_review_dollars, notes, favorite_batches")
            .in("vendor_party_id", vendorPartyIds);
```

And the row mapper (inside the for loop):

```ts
            map.set(row.vendor_party_id, {
                vendorPartyId: row.vendor_party_id,
                vendorName: row.vendor_name ?? null,
                leadTimeOverrideDays: row.lead_time_override_days,
                targetCoverDays: row.target_cover_days,
                moqMode: (row.moq_mode ?? "enforce") as VendorMoqMode,
                overbuyReviewPct: Number(row.overbuy_review_pct ?? 50),
                overbuyReviewDollars: Number(row.overbuy_review_dollars ?? 1000),
                notes: row.notes ?? null,
                favoriteBatches: Array.isArray(row.favorite_batches) && row.favorite_batches.length > 0
                    ? row.favorite_batches.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
                    : null,
            });
```

- [ ] **Step 3: Add `loadVendorRecentLineQtys` to calibration.ts**

After the `loadVendorReorderPolicies` block, add:

```ts
// ──────────────────────────────────────────────────
// VENDOR RECENT LINE QTYS (for cognitive rounding)
// ──────────────────────────────────────────────────

/**
 * v2.2 — pull the last N completed PO line quantities for a vendor across
 * all SKUs (vendors tend to use consistent batch sizes for related products).
 * Used by cognitive rounding to detect favorite-batch clusters.
 *
 * Best-effort: a Finale outage returns an empty array and the recommender
 * falls back to the cognitive ladder.
 */
export async function loadVendorRecentLineQtys(
    finale: any,             // FinaleClient — `any` to avoid circular import
    vendorPartyId: string,
    limit: number = 8,
): Promise<number[]> {
    if (!vendorPartyId) return [];
    try {
        // Finale's listRecentPosByVendor expects a vendor name, not party id.
        // We fetch a wider window of recent POs and filter by partyUrl.
        const recent = await finale.getRecentPurchaseOrders(180);  // 6 months back
        const filtered = recent
            .filter((po: any) => po.status?.toLowerCase() === "completed")
            .filter((po: any) => {
                const partyId = (po.supplierPartyUrl ?? "").split("/").pop();
                return partyId === vendorPartyId;
            })
            .slice(0, limit * 2);  // pull 2× to flatten line qtys

        const qtys: number[] = [];
        for (const po of filtered) {
            for (const line of (po.items ?? [])) {
                const q = Number(line.quantity);
                if (Number.isFinite(q) && q > 0) qtys.push(q);
            }
        }
        return qtys.slice(0, limit);
    } catch (err: any) {
        console.warn(`[calibration] loadVendorRecentLineQtys failed for ${vendorPartyId}: ${err.message}`);
        return [];
    }
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/purchasing/calibration.ts
git commit -m "feat(purchasing): loadVendorRecentLineQtys + favoriteBatches on policy"
```

---

## Task 5: Wire historical fetch + favoriteBatches into `getPurchasingIntelligence`

**Files:**
- Modify: `src/lib/finale/client.ts`

- [ ] **Step 1: Update calibration imports**

Find the import block in `client.ts` that pulls calibration helpers. Add `loadVendorRecentLineQtys`:

```ts
import {
    loadActiveReservations,
    loadCalibrationStats,
    loadVendorMOQs,
    loadVendorReorderPolicies,
    loadVendorRecentLineQtys,
    type VendorReorderPolicy,
    recordRecommendationSnapshots,
} from "@/lib/purchasing/calibration";
```

(The existing list might be slightly different — preserve every existing import, just add the two new ones.)

- [ ] **Step 2: Add a per-vendor history cache near the existing caches**

Find the line `const reorderPolicyCache = new Map<string, VendorReorderPolicy>();` and add a sibling:

```ts
        const recentLineQtysCache = new Map<string, number[]>();
```

- [ ] **Step 3: Load history alongside calibration / MOQ / policy**

Find the block that loads per-vendor data on first encounter:

```ts
                    if (!seenVendorIds.has(partyId)) {
                        seenVendorIds.add(partyId);
                        const [calMap, moqMap, policyMap] = await Promise.all([
                            loadCalibrationStats([partyId]),
                            loadVendorMOQs([partyId]),
                            loadVendorReorderPolicies([partyId]),
                        ]);
                        ...
                    }
```

Replace with:

```ts
                    if (!seenVendorIds.has(partyId)) {
                        seenVendorIds.add(partyId);
                        const [calMap, moqMap, policyMap, recentQtys] = await Promise.all([
                            loadCalibrationStats([partyId]),
                            loadVendorMOQs([partyId]),
                            loadVendorReorderPolicies([partyId]),
                            loadVendorRecentLineQtys(this, partyId, 8),
                        ]);
                        const cal = calMap.get(partyId);
                        if (cal) calibrationCache.set(partyId, cal);
                        const moq = moqMap.get(partyId);
                        if (moq) moqCache.set(partyId, moq);
                        const policy = policyMap.get(partyId);
                        if (policy) reorderPolicyCache.set(partyId, policy);
                        recentLineQtysCache.set(partyId, recentQtys);
                    }
```

- [ ] **Step 4: Pass historical + favoriteBatches into `recInputs`**

Find the `const recInputs = { ... };` object near `recommendQty(recInputs)`. Add the two new fields after `overbuyReviewDollars`:

```ts
                        overbuyReviewDollars: reorderPolicy?.overbuyReviewDollars ?? 1000,
                        // v2.2 — cognitive rounding inputs
                        historicalLineQtys: recentLineQtysCache.get(partyId) ?? [],
                        favoriteBatches: reorderPolicy?.favoriteBatches ?? null,
                    } as const;
```

- [ ] **Step 5: Surface rounding method on `PurchasingItem`**

Find the `PurchasingItem` interface in `client.ts` (around line 116-160). Add after `reviewReasons?`:

```ts
    /** v2.2 — which rounding layer produced suggestedQty (cognitive/historical/vendor_explicit), null when no snap fired. */
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    /** v2.2 — two alternative qty values for one-click override in the dashboard dropdown. */
    roundingAlternatives?: number[];
```

- [ ] **Step 6: Wire them into the `items.push({ ... })` block**

Find the `items.push({ ... })` call inside `getPurchasingIntelligence`. Add after `reviewReasons: rec.reviewReasons,`:

```ts
                        moqWarning: rec.moqWarning,
                        reviewRequired: rec.reviewRequired,
                        reviewReasons: rec.reviewReasons,
                        // v2.2
                        roundingMethod: rec.roundingMethod,
                        roundingAlternatives: rec.roundingAlternatives,
                        recommendation: { ... },
                    });
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
```
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "$(cat <<'EOF'
feat(purchasing): wire cognitive rounding into getPurchasingIntelligence

Loads vendor recent line qtys (last 8 completed PO line qtys, 6-month window)
alongside calibration/MOQ/policy in the per-vendor parallel fetch. Reads
favorite_batches from vendor_reorder_policies and passes both to the recommender.

PurchasingItem now carries roundingMethod and roundingAlternatives so the
dashboard can render the override dropdown.
EOF
)"
```

---

## Task 6: Override dropdown in PurchasingPanel

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Modify: `src/components/dashboard/PurchasingPanel.test.tsx`

- [ ] **Step 1: Extend the local `PurchasingItem` type**

Find the local `PurchasingItem` type at the top of `PurchasingPanel.tsx`. After `reviewReasons?: string[];` add:

```ts
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    roundingAlternatives?: number[];
```

- [ ] **Step 2: Add a small dropdown component near the existing qty input**

Find the existing qty input render block (search for `qtys[pid]?.[item.productId] ?? item.suggestedQty`). The current pattern is:

```tsx
<input
    type="number"
    value={qtys[pid]?.[item.productId] ?? item.suggestedQty}
    onChange={(e) => setItemQty(pid, item.productId, Number(e.target.value))}
    ...
/>
```

Replace with a wrapper that adds a chevron when `item.roundingAlternatives?.length > 0`:

```tsx
<div className="relative inline-flex items-center">
    <input
        type="number"
        value={qtys[pid]?.[item.productId] ?? item.suggestedQty}
        onChange={(e) => setItemQty(pid, item.productId, Number(e.target.value))}
        className="..."  // keep the existing classes
    />
    {item.roundingAlternatives && item.roundingAlternatives.length > 0 && (
        <button
            type="button"
            onClick={() => setQtyDropdownOpen({ pid, productId: item.productId, on: !(qtyDropdownOpen.pid === pid && qtyDropdownOpen.productId === item.productId && qtyDropdownOpen.on) })}
            title="Snap to a different clean number"
            className="ml-1 text-zinc-400 hover:text-zinc-100"
        >▾</button>
    )}
    {qtyDropdownOpen.pid === pid && qtyDropdownOpen.productId === item.productId && qtyDropdownOpen.on && (
        <div className="absolute top-full right-0 mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded shadow-lg py-1 min-w-[120px]">
            {[item.suggestedQty, ...(item.roundingAlternatives ?? [])]
                .filter((v, i, arr) => arr.indexOf(v) === i)  // dedupe
                .sort((a, b) => a - b)
                .map(alt => {
                    const delta = alt - item.suggestedQty;
                    const isAuto = alt === item.suggestedQty;
                    return (
                        <button
                            key={alt}
                            onClick={() => {
                                setItemQty(pid, item.productId, alt);
                                setQtyDropdownOpen({ pid: "", productId: "", on: false });
                            }}
                            className={`w-full text-left px-3 py-1 text-[11px] font-mono hover:bg-zinc-800 ${isAuto ? "text-emerald-300" : "text-zinc-300"}`}
                        >
                            {alt}
                            {isAuto && <span className="ml-1 text-[9px] text-emerald-500/70">(auto)</span>}
                            {!isAuto && <span className="ml-1 text-[9px] text-zinc-500">{delta > 0 ? `+${delta}` : delta}</span>}
                        </button>
                    );
                })}
        </div>
    )}
</div>
```

- [ ] **Step 3: Add the dropdown state**

Near the other `useState` calls at the top of `PurchasingPanel`, add:

```tsx
const [qtyDropdownOpen, setQtyDropdownOpen] = useState<{ pid: string; productId: string; on: boolean }>({ pid: "", productId: "", on: false });
```

- [ ] **Step 4: Update the test fixture and add a dropdown assertion**

In `PurchasingPanel.test.tsx`, the existing `makeFixtureItem` should be extended:

```ts
        moqWarning: true,
        reviewRequired: true,
        reviewReasons: [...],
        roundingMethod: "historical",
        roundingAlternatives: [600, 1000],
    };
```

Then append a new test case:

```ts
it("renders qty override dropdown when roundingAlternatives are present", async () => {
    stubLocalStorage();
    stubFetch();

    render(<PurchasingPanel />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const vendorTab = await screen.findByText(/Colorful Packagi/i);
    fireEvent.click(vendorTab);

    // The chevron is rendered with title "Snap to a different clean number"
    await waitFor(() => {
        const chevron = document.querySelector('[title="Snap to a different clean number"]');
        expect(chevron).toBeTruthy();
    });
});
```

- [ ] **Step 5: Run the dashboard tests**

```bash
npx vitest run src/components/dashboard/PurchasingPanel.test.tsx
```
Expected: all passing (existing 6 + 1 new = 7).

- [ ] **Step 6: Type-check the React side**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/PurchasingPanel.tsx src/components/dashboard/PurchasingPanel.test.tsx
git commit -m "feat(dashboard): qty override dropdown for cognitive-round alternatives"
```

---

## Task 7: Final verification, dashboard rebuild, restart, push

- [ ] **Step 1: Full test sweep**

```bash
npx vitest run src/lib/purchasing/ src/components/dashboard/PurchasingPanel.test.tsx 2>&1 | tail -10
```
Expected: all green (cognitive-round 19 + qty-recommender ~46 + dashboard-focus 28 + PurchasingPanel 7 + others).

- [ ] **Step 2: Both type-checks**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
npx tsc --noEmit --project tsconfig.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
```
Both expected: no output.

- [ ] **Step 3: Rebuild dashboard for production PM2**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Restart both PM2 processes**

```bash
pm2 restart aria-bot aria-dashboard
pm2 list
```
Both should show `online` with `↺` count incremented.

- [ ] **Step 5: Verify cron runner re-registered**

```bash
pm2 logs aria-bot --lines 30 --nostream | grep -E "cron-runner|scheduled" | head -10
```
Expected: ~22 `[cron-runner] <name>: scheduled ...` lines, none failing.

- [ ] **Step 6: Smoke a purchasing scan**

```bash
curl -sS --max-time 60 "http://localhost:3001/api/dashboard/purchasing?bust=1&urgency=critical" -o /tmp/scan.json -w "%{http_code}\n"
node -e "const d=JSON.parse(require('fs').readFileSync('C:/Users/BuildASoil/AppData/Local/Temp/scan.json'));const items=(d.groups||[]).flatMap(g=>g.items);const rounded=items.filter(i=>i.roundingMethod);console.log('items:',items.length,'with rounding:',rounded.length);if(rounded[0])console.log('sample:',{sku:rounded[0].productId,suggestedQty:rounded[0].suggestedQty,method:rounded[0].roundingMethod,alternatives:rounded[0].roundingAlternatives});"
```
Expected: most items show `roundingMethod: "cognitive"`; Colorful items show `roundingMethod: "historical"` if the historical fetch worked.

- [ ] **Step 7: Push**

```bash
git push origin main
```
Expected: 6 new commits pushed.

---

## Self-Review

**Spec coverage:**
- [x] Cognitive ladder magnitude tiers (Task 2 implementation + tests)
- [x] Historical favorites with cluster ≥2× (Task 2)
- [x] Explicit override (Task 1 column + Task 4 reader + Task 2 layer 3)
- [x] Pack increment interaction (Task 2 `honorPack`)
- [x] MOQ runs after rounding (Task 3 places step 7.5 before existing MOQ block)
- [x] Provenance traces: `cognitive_round` / `historical_round` / `vendor_round` (Task 3 step 6)
- [x] Formula version bump v2.2 (Task 3 step 3)
- [x] Dashboard shows snapped qty (default behavior — `suggestedQty` becomes the snap)
- [x] Override dropdown with 2 alternatives (Task 6)
- [x] All edge cases (Task 2 tests cover qty<5, MOQ over snap, equidistant, out-of-range historical)

**Type consistency:**
- `CognitiveRoundResult.method` matches `RecommenderResult.roundingMethod` — both use `"cognitive" | "historical" | "vendor_explicit"`. Task 3 step 6 maps `"noop"` → `null`.
- `historicalLineQtys` (input) and `historicalQtys` (helper input) are different names — intentional: input field on the recommender carries the upstream context (vendor line qtys), helper accepts any pre-filtered cluster source.
- `favoriteBatches` consistent across calibration interface, recommender input, and PurchasingItem.

**Placeholder scan:** clean. All steps contain executable code/commands.

---

## Out of Scope (deferred)

- Truck-fill / weight-budget per PO (Will keeps the judgment).
- Tote-count summary in the panel header.
- SKU-level historical learning (only vendor-level; revisit if vendor pattern is too noisy).
- Per-vendor cognitive ladder customization (e.g. "Colorful uses 250 not 50 as base step"). The explicit `favorite_batches` array covers most of this without the complexity.
- LLM-driven recommendation explanations beyond the existing provenance trace.
