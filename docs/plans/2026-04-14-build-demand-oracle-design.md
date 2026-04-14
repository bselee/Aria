# Build Demand Oracle — Design

## Overview
Add a "Build Demand Oracle" section to the BuildSchedulePanel dashboard that surfaces:
- Immediate procurement needs (orders needed now)
- A 12-week forward projection of component demand ("crystal ball")
- Foreknowledge of stockout risk before builds can't be completed

Driven by existing data: BOM explosion from calendar builds + FG sales velocity + current stock levels. No new Finale API calls needed — all data already fetched by `runBuildRiskAnalysis()` and stored in `build_risk_snapshots`.

---

## Two-Part Structure

### Part A — "Orders Needed Now" (Immediate)

CRITICAL + WARNING components only. Organized by vendor group.

Columns per row:
| SKU | On Hand | 30d Build Need | Gap | Order Qty | Lead Time | Blocks | Risk |

- **Gap** = `max(0, onHand - 30dNeed)` — negative means stockout
- **Order Qty** = `abs(gap) + safetyBuffer` where `safetyBuffer = leadTimeDays * avgDailyConsumption`
- **Blocks** = which FGs will be halted if this component goes to zero (e.g., "CRAFT1, CRAFT4")
- **Grouped by vendor** — each group is a potential draft PO

Collapsible vendor groups with a "Create Draft PO" action per group.

Top summary: "🔴 X CRITICAL · 🟡 Y WARNING · Z units to order"

---

### Part B — "Oracle: 12-Week Forecast" (Crystal Ball)

**Accuracy tiers — be transparent about confidence:**

| Tier | Window | Source | Confidence |
|------|--------|--------|------------|
| 1 - Confirmed | Weeks 1-4 | Actual calendar builds + BOM explosion | HIGH |
| 2 - Projected | Weeks 5-8 | Monthly baseline repeated + FG velocity modifier | MEDIUM |
| 3 - Extrapolated | Weeks 9-12 | FG sales velocity → build frequency inference | LOWER |

**Monthly baseline logic:**
Since builds are similar each month, the 30-day BOM demand = monthly run rate. For weeks 5-12, we repeat that baseline, adjusted by any FG velocity trend.

**FG velocity → build frequency projection:**
- `dailyRate` per FG from `FGVelocity`
- `onHand` per FG from stock
- `runway = onHand / dailyRate` — when will this FG run out at current sales?
- When a FG runway < some threshold, that triggers a build → component demand
- This chains through the BOM to project component demand

**Oracle output table:**
| SKU | Wk 1-4 | Wk 5-8 | Wk 9-12 | Lead Time | On Hand | Runway | Status |

- **Wk 1-4**: Confirmed demand from calendar BOM explosion (high confidence)
- **Wk 5-8, 9-12**: Projected based on monthly run rate × velocity modifier
- **Runway**: Days until component stockout at build-consumption rate (not sales rate)
- **Status**: `⚠️ ORDER NOW` | `👀 REORDER SOON` | `✅ COVERED`

**Status logic:**
- `ORDER NOW`: current onHand + all confirmed/expected POs won't cover weeks 1-4
- `REORDER SOON`: onHand will cover weeks 1-4 but weeks 5-8 show gap
- `COVERED`: onHand + POs cover through week 12 at projected rate

---

## Confidence labeling

Each projected column (Wk 5-8, 9-12) shows a subtle (est.) suffix to signal projected data. Data in the Oracle comes from actual calendar builds + BOM explosion — projected weeks are repeated monthly baseline with velocity modifier.

---

## Key Metrics to Surface

For each component:
1. **On Hand** — current stock from Finale
2. **30d Build Demand** — from BOM explosion of confirmed calendar builds
3. **Projected Monthly Need (Wk 5-12)** — repeated baseline × velocity
4. **Lead Time** — from Finale product data
5. **Runway** — `onHand / avgDailyConsumptionFromBuilds`
6. **Order Threshold** — `leadTimeDays * avgDailyConsumption` = when you must order by

---

## Data Sources (No new API calls)

All data is already in `BuildRiskReport` and `build_risk_snapshots`:
- `builds[]` — calendar-derived finished goods schedule
- `components[]` — BOM-exploded demand with `totalRequiredQty`, `onHand`, `stockoutDays`, `leadTimeDays`, `riskLevel`, `incomingPOs`, `usedIn`
- `fgVelocity` — `dailyRate`, `daysOfFinishedStock`, `stockOnHand` per FG

New computation: for oracle weeks 5-12, derive build frequency from FG sales velocity and repeat monthly baseline.

---

## Component Grouping for Purchasing

Group components by their primary vendor (from Finale `supplier` field on the product). Each group becomes a natural draft PO. Show:
- Vendor name
- List of components needed with quantities
- Combined order value estimate (if cost data available)

---

## UI Layout

Integrated into existing `BuildSchedulePanel.tsx` as a third collapsible section below:
1. "Build Schedule" (calendar timeline — existing)
2. "Build Demand" (orders needed now — new)
3. "Oracle Forecast" (12-week projection — new)

BuildDemand and Oracle sections collapse/expand independently, state persisted in localStorage.

---

## Snapshot Schema Addition

`build_risk_snapshots` already stores `components` as JSONB — no schema change needed. The Oracle logic is computed client-side from existing snapshot data, or can be pre-computed server-side in `runBuildRiskAnalysis()` and stored as additional fields.

Optional: add `oracle_forecast` JSONB column to `build_risk_snapshots` if we want to pre-compute and store the 12-week projection.

---

## Implementation Notes

- Use existing `runBuildRiskAnalysis()` — no new API calls
- Oracle projection logic in a new `build-demand-oracle.ts` util
- Reuse `BuildRiskPanel.tsx` risk badge styles for consistency
- Group components by vendor using `finale.getProduct(id)` supplier data (may need a batch lookup)
- Show "⚠️ ORDER NOW" badge prominently in red for components where leadTime > runway