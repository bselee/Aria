# BOM Demand — Receipt-Velocity Primary Signal

**Date:** 2026-05-12
**Status:** Design approved, pending spec sign-off
**Author:** Aria + Will
**Supersedes:** Partial — refines the BOM half of `2026-05-06-bom-demand-engine-design.md`

## Problem

The dashboard Ordering screen's BOM pipeline ([client.ts:4940 `getBOMDemand`](src/lib/finale/client.ts#L4940)) drops every component whose feeding finished goods had `dailySalesRate <= 0` over the last 90 days. Components consumed by build-ahead, contract, or wholesale FGs — and the vendors that supply them (Malibu, Gary's Worm, Seacoast, Marion Ag, …) — never surface as items to order.

## Goal

Surface BOM components based on **what Aria has historically purchased** (the only signal that already reflects builds, contracts, wholesale, growth, and seasonality), with the FG-derived burn rate kept only as a fallback for components without purchase history.

## Non-goals

- Reading the Google Calendar build schedule as a primary demand driver (added only as context in the explanation line, not as math input).
- Restructuring the resale pipeline.
- Changing cache/prewarm behavior, the API route, or panel filter logic.

## Design

### Primary signal: component receipt velocity

For each component the pipeline already calls `getProductActivity(compSku, daysBack)`. That call returns `purchasedQty` over the window. Compute:

```
receiptVelocity = purchasedQty / daysBack
```

Use this as the primary daily-burn signal.

### Fallback: FG-derived demand

Keep the existing math (`Σ fg.dailySalesRate × bomQty`) as `bomDerivedVelocity`. Use it when `receiptVelocity` is zero (e.g., new component, never ordered).

### Combination rule

```
dailyBurn       = receiptVelocity || bomDerivedVelocity || 0
dailyRateSource = receiptVelocity > 0 ? 'receipts'
                : bomDerivedVelocity > 0 ? 'bom'
                : 'none'
```

`dailyRateSource` is surfaced on the `PurchasingItem` so the panel can show provenance ("0.42/d from receipts" vs "0.18/d from FG sales × BOM").

### Inclusion gate

Replace `if (dailySalesRate <= 0) continue` in the FG loop with: **do not gate on FG sales velocity at all**. Components are included if `dailyBurn > 0` once we reach the component loop. This is the change that lets purchase-only components surface.

The current FG loop still runs — we still need the `feedsFinishedGoods` provenance — but its zero-sales-rate exclusion is removed. Components with non-zero receipts AND zero feeding-FG sales become valid items.

### Receipt-velocity reality cap

Mirror the resale pipeline's `chooseVelocitySignal` cap. After computing `receiptVelocity`:

1. Inspect `purchasedPOs` (already returned by `getProductActivity`).
2. If a single PO contributes >70% of `purchasedQty`, the velocity is "bulk-buy-inflated."
3. Cap to `purchasedQty / (window between first and last PO date, in days)` instead of the raw `daysBack` window.
4. Set `velocityInflated = true`, populate `velocityRawRate` and `velocityRealityCap`. The panel already renders these fields.

### Receipt confidence

Add a confidence value derived from PO count and date spread:

| PO count | Date spread | confidence |
|---|---|---|
| ≥ 4 | ≥ 180 days | `high` |
| 2-3 | ≥ 90 days | `medium` |
| 1, or all POs within 30 days | any | `low` |

This goes into the existing `assessment.confidence` field consumed by `assessPurchasingGroups`.

### Calendar peek (explanation only)

After all numeric work, if `build-parser`'s upcoming builds list contains a build that consumes this component, append to the item's `explanation` string:

```
… · Next build 2026-05-19 consumes 50 lb.
```

This does **not** influence quantity or urgency calculations. It is informational. If `build-parser` is unavailable or empty, omit silently.

### Output shape

`PurchasingItem` (defined in [client.ts](src/lib/finale/client.ts)) gains three optional fields. None break existing consumers:

```ts
receiptVelocity?: number;         // primary signal value
bomDerivedVelocity?: number;      // fallback signal value
dailyRateSource?: 'receipts' | 'bom' | 'sales' | 'demand' | 'none';  // existing enum, add 'receipts'
```

`feedsFinishedGoods[]` stays as-is.

## Implementation footprint

| File | Change |
|---|---|
| [src/lib/finale/client.ts](src/lib/finale/client.ts) `getBOMDemand` | Remove FG sales-velocity gate; compute `receiptVelocity` from `compActivity.purchasedQty`; apply combination ladder + reality cap + confidence. |
| [src/lib/finale/bom-demand.ts](src/lib/finale/bom-demand.ts) | Optional: extract combination/cap helpers as pure functions for testability. |
| [src/components/dashboard/PurchasingPanel.tsx](src/components/dashboard/PurchasingPanel.tsx) | Read `dailyRateSource` and show the source label in the existing explanation block. No structural change. |

No new files. No new dependencies. No cache or route changes.

## Tests

Pure-function tests in [src/lib/finale/bom-demand.test.ts](src/lib/finale/bom-demand.test.ts):

1. `chooseBomVelocity(receipts=0.42, bom=0.18)` returns `{value: 0.42, source: 'receipts'}`.
2. `chooseBomVelocity(receipts=0, bom=0.18)` returns `{value: 0.18, source: 'bom'}`.
3. `chooseBomVelocity(receipts=0, bom=0)` returns `{value: 0, source: 'none'}`.
4. Reality cap: `purchasedQty=1000` over 365d with one PO contributing 900 units triggers `velocityInflated=true` and caps to PO-spread velocity.
5. Confidence: 1 PO → `low`; 4 POs spread 180+ days → `high`; 3 POs within 30 days → `low`.

Integration: extend [client.test.ts](src/lib/finale/client.test.ts) with a `getBOMDemand` case where a component has zero feeding-FG sales but non-zero `purchasedQty` and assert it lands in the output.

## Rollout

Single commit, single restart. No flag — the new behavior is strictly more inclusive. If a vendor starts surfacing items Will doesn't want to order, that's a `do-not-reorder` flag in Finale or a snooze on the panel, not a rollback.

## Open questions

None. Will approved the precedence ladder, reality-cap inclusion in v1, and calendar-peek-as-context-only on 2026-05-12.

## Out of scope (v2 candidates)

- Seasonal weighting with 2-year lookback.
- Vendor freight-route bundling hints.
- 24h `getBillOfMaterials` cache.
