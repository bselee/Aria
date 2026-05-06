# Cognitive Rounding for PO Qty Recommendations — Design

**Date:** 2026-05-06
**Status:** approved (Will, 2026-05-06)
**Author:** Aria session
**Supersedes:** none — extends `2026-05-05-vendor-reorder-policy-overrides.md`

---

## Problem

The recommender produces exact-math quantities like `591` and `817`. Will can't
present odd numbers to vendors — every PO line needs to be a "presentable"
clean number. Current behavior:

- Pack increment from Finale (`orderIncrementQty`) handles vendor case sizes.
- After pack rounding, the qty is still arbitrary (e.g. 591 with pack=1).
- Will manually rounds before sending the PO, every time, for every line.

This is the cognitive friction Aria should eliminate.

## Goal

Never show a raw odd number on a draft PO. The math stays auditable in the
provenance trace, but `suggestedQty` is always a clean number with a
sensible upward bias when judgment-call constraints (truck fill, container
counts, 6-month windows) might apply.

## Non-Goals

- No truck-fill optimization, container-count math, or freight-pound matching.
  Those judgment calls stay with Will. Aria only removes the cognitive friction
  of "should this be 500 or 600?"
- No automatic order-cycle planning beyond what the existing `targetCoverDays`
  policy provides.
- No SKU-level historical override (only vendor-level). Adding SKU-level
  granularity is a follow-on if vendor-level proves too coarse.

---

## Three-layer rounding strategy

Applied **after** pack increment, **before** MOQ enforcement. Order:

```
raw need (591) → pack increment → cognitive/historical snap → MOQ enforce → suggestedQty (500)
```

### Layer 1 — Cognitive ladder (always-on floor)

Magnitude-aware nearest-clean snap. Works without history; handles cold-start.

| Range | Snap step |
|---|---|
| < 30 | nearest 5 |
| 30–99 | nearest 10 |
| 100–249 | nearest 25 |
| 250–749 | nearest 50 |
| 750–2,499 | nearest 100 |
| 2,500–9,999 | nearest 500 |
| ≥ 10,000 | nearest 1,000 |

Examples: `22 → 25` (nearest 5, up), `31 → 30` (nearest 10, down by 1),
`591 → 600` (nearest 100), `817 → 800` (nearest 100).

Default bias: pick the nearest. When two snap targets are equidistant, choose
the higher one (Will's stated "usually up" preference).

### Layer 2 — Historical override (when pattern exists)

If the vendor has a clear historical pattern, use **those** values instead of
the cognitive ladder.

**Cluster detection:** look at the last 8 completed PO line quantities for this
vendor (across all SKUs, not just this one — vendors tend to use the same
batch sizes for related products). A value is a "favorite" if it appears
**≥ 2 times** in the last 8 — i.e. used twice in recent memory. Multiple
favorites are allowed (Colorful = `[500, 1000]` is the canonical case).

**Snap rule:** find the favorite nearest to the raw qty. Midpoint between
favorites is the boundary. So with favorites `[500, 1000]`:

- `591` → 500 (closer to 500 than to 1000; 591 < 750 midpoint)
- `817` → 1000 (closer to 1000; 817 > 750 midpoint)

**Out-of-range guard:** if raw qty is outside the favorites' range
(e.g. raw = 5 and favorites = `[500, 1000]`), fall back to the cognitive
ladder. Don't force a tiny order up to a 500-batch — that's overbuy of
~10,000%, well beyond the cover policy.

### Layer 3 — Explicit per-vendor override (deterministic knob)

`vendor_reorder_policies.favorite_batches int[]` (new nullable column).
When set, **overrides** historical learning entirely. Used for:

- New vendors with no PO history yet
- Cases where the historical pattern is wrong (e.g. you've decided to switch
  Colorful from 500/1000 to 250/750)
- Vendors where the historical signal is too noisy

When set, the array values become the snap targets directly. Same nearest-of-set
rule as Layer 2.

---

## UI surface

### Per-row qty input

Today the row shows: `qty 591` plain input.
After: `qty 500 ▾` — same input, snapped value, with a chevron dropdown.

The dropdown shows **3 alternatives** (raw and two adjacent clean numbers):

```
  500  (-91)  · the auto pick — bottom card
  600        · cognitive-ladder pick (when different from auto)
  1000 (+409) · next-up favorite or next ladder rung
```

One click on any alternative replaces the row's qty. Override sticks for that
draft session.

### "Why X?" provenance drawer

Existing trace gets one new step appended after `pack_round`:

- `cognitive_round`: when Layer 1 fired alone.
  *"591 → 600 (nearest 100, magnitude tier 750-2499 was off; 250-749 → 50)"*
- `historical_round`: when Layer 2 fired.
  *"591 → 500 (matches 4 of last 6 Colorful POs at 500; midpoint to 1000 was 750)"*
- `vendor_round`: when Layer 3 fired (explicit override).
  *"591 → 500 (vendor policy favorite_batches=[500, 1000])"*

The previous `pack_round` step still shows the pre-snap value, so the full
chain is auditable: raw → pack → cognitive/historical → MOQ → suggested.

### Out-of-scope alternatives (deliberately not shown in dropdown)

- Estimated total weight per line (truck-fill judgment) — could be added later
  as a row decoration; not needed for v1.
- Estimated tote count — same.
- Vendor-level total (cumulative across selected lines) — same.

---

## Data model

**New column** on `vendor_reorder_policies`:

```sql
ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS favorite_batches INTEGER[];
```

Nullable. NULL means "use historical learning + cognitive ladder fallback."

**No changes to** `qty_recommendations`. The `suggestedQty` written to
`recommended_qty` is the final post-snap number — that's what was actually
recommended, and it's what calibration should measure against actual consumption.

---

## Pure-function contract

```ts
// src/lib/purchasing/cognitive-round.ts (new file)

export interface CognitiveRoundInput {
    rawQty: number;                       // post-pack, pre-MOQ qty
    packIncrement?: number | null;        // ensure result is a multiple of this
    historicalQtys?: number[];            // last N completed line qtys for vendor
    explicitFavorites?: number[] | null;  // vendor_reorder_policies override
}

export interface CognitiveRoundResult {
    snappedQty: number;
    delta: number;                         // snappedQty - rawQty (signed)
    method: "cognitive" | "historical" | "vendor_explicit";
    detail: string;                        // human-readable reason for the trace
    alternatives: number[];                // 2 nearby alternatives for the UI dropdown
}

export function roundToCleanQty(input: CognitiveRoundInput): CognitiveRoundResult;
```

Deterministic and pure (no I/O). Tested in isolation with vitest.

---

## Pipeline composition

In `qty-recommender.ts`, after the existing `pack_round` step and **before**
the existing MOQ enforcement step, add a `cognitive_round` step that calls
`roundToCleanQty` and replaces `suggestedQty` with the snapped value.

`RecommenderInput` gains two optional fields:

```ts
historicalLineQtys?: number[];      // last N completed PO line qtys for vendor
favoriteBatches?: number[] | null;  // vendor_reorder_policies override
```

`RecommenderResult` gains:

```ts
roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
roundingAlternatives?: number[];   // for UI dropdown
```

`QTY_FORMULA_VERSION` bumps to `v2.2-cognitive-round-2026-05-06` (rule from
the canonical-recommender plan: behavioral change → version bump).

---

## Historical batch loader

**New helper** in `src/lib/purchasing/calibration.ts` (or new file
`src/lib/purchasing/vendor-batch-history.ts` — TBD during implementation,
prefer keeping it close to the calibration cluster):

```ts
export async function loadVendorRecentLineQtys(
    vendorPartyId: string,
    limit?: number,        // default 8
): Promise<number[]>;
```

**Source:** Finale `orderViewConnection` filtered by vendor + status=COMPLETED,
last `limit × 2` orders, flatten line qtys. Cached at the `getPurchasingIntelligence`
level by vendor (one fetch per vendor per scan, same pattern as
`loadCalibrationStats` / `loadVendorMOQs`).

Falls back to empty array on error — recommender then uses cognitive ladder only.

---

## Edge cases

| Case | Behavior |
|---|---|
| Raw qty = 0 | No snap. `suggestedQty` stays 0. |
| Raw qty < 5 | Snap to 5 (smallest cognitive tier). |
| Pack increment > nearest cognitive snap | Pack wins. e.g. pack=12, raw=22 → pack=24 → cognitive=25 → use 24 (nearest pack-multiple to 25). |
| MOQ > snapped qty | MOQ wins (existing behavior). e.g. snap=25, MOQ=50 → 50. |
| Historical favorites empty | Use cognitive ladder. |
| Historical favorites = `[1000, 1000, 1000]` (single value) | Snap to 1000 if within range; else cognitive ladder. |
| Vendor explicit override = `[]` (empty array) | Treat as null (no override). |
| Raw qty 10× the largest favorite | Cognitive ladder fallback (don't force a 5,000-unit order to 1,000). |

---

## Test cases (pure helper)

```ts
// Cognitive ladder
roundToCleanQty({ rawQty: 22 })  → { snappedQty: 25, method: "cognitive" }
roundToCleanQty({ rawQty: 31 })  → { snappedQty: 30, method: "cognitive" }
roundToCleanQty({ rawQty: 591 }) → { snappedQty: 600, method: "cognitive" }
roundToCleanQty({ rawQty: 817 }) → { snappedQty: 800, method: "cognitive" }

// Historical override (Will's example)
roundToCleanQty({ rawQty: 591, historicalQtys: [500, 1000, 500, 500, 1000, 500] })
  → { snappedQty: 500, method: "historical", alternatives: [600, 1000] }
roundToCleanQty({ rawQty: 817, historicalQtys: [500, 1000, 500, 500, 1000, 500] })
  → { snappedQty: 1000, method: "historical", alternatives: [500, 800] }

// Explicit override beats history
roundToCleanQty({
    rawQty: 591,
    historicalQtys: [500, 500, 500],
    explicitFavorites: [250, 750],
})
  → { snappedQty: 750, method: "vendor_explicit" }

// Out of favorite range — fall back to cognitive
roundToCleanQty({ rawQty: 5, historicalQtys: [500, 1000, 500] })
  → { snappedQty: 5, method: "cognitive" }  // tiny qty, ladder snaps to 5

// Pack constraint
roundToCleanQty({ rawQty: 22, packIncrement: 12 })
  → { snappedQty: 24, method: "cognitive", detail: contains "pack 12" }

// Equidistant prefers higher (Will's "usually up")
roundToCleanQty({ rawQty: 75 })
  → { snappedQty: 80, method: "cognitive" }  // 75 is equidistant from 70 and 80; 80 wins
```

---

## Acceptance criteria

1. Will's two screenshot examples produce the expected outputs:
   - `BIG6300GBAG` (raw 591) → `suggestedQty: 500` with `historical_round` provenance.
   - `BIG6100GBAG` (raw 817) → `suggestedQty: 1000` with `historical_round` provenance.

2. Cold-start vendor (no historical favorites): `roundToCleanQty({ rawQty: 591 })`
   returns 600 with `cognitive_round` provenance.

3. `qty 500 ▾` dropdown on every row shows 2 alternatives + the snap pick.
   One click overrides for the draft session.

4. `QTY_FORMULA_VERSION === "v2.2-cognitive-round-2026-05-06"` after the change.

5. All existing recommender tests still pass (40 → ~52 with new tests).

6. Dashboard ts-checks both configs clean.

---

## Rollback

If snap behavior produces bad recommendations:

1. Set every vendor policy's `favorite_batches = NULL` (no-op for vendors
   without a row already, but explicit clear for those that have one).
2. Revert the recommender to skip the `cognitive_round` step
   (single-line guard: `if (process.env.COGNITIVE_ROUND_DISABLED) skip`).
3. Re-run purchasing with `?bust=1` to clear the 30-min API cache.

The historical-batch fetch from Finale is best-effort and never blocks. A
Finale outage just means cognitive ladder takes over — same effective behavior
as Layer 1 alone.
