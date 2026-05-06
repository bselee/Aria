# BOM Demand Engine — Design Spec

**Date:** 2026-05-06
**Status:** Draft
**Author:** Will + Claude (brainstorm session)

## Problem

The purchasing screen manages items Aria needs to order, but doesn't distinguish between items sold as-is (resale) and raw materials consumed by manufacturing builds (BOM components). BOM components need different management: their demand is driven by finished-goods sales velocity, not direct sales. Orders are bulk, expensive, and benefit from vendor consolidation across multiple components. The manufacturing team's build calendar is inconsistent — actual sales data is the reliable demand signal.

## Design Decision

**Approach C: Single Panel, Smart Grouping.** Extend the existing purchasing panel with item-type tagging, a mode filter, and build-context enrichment for BOM items. No new screens — the build screen gets a lightweight read-only summary card; all ordering stays on the purchasing screen.

## Source of Truth

```
Finale Shipments (actual FG sales)
  → FG daily sales velocity
  → BOM explosion (Finale recipes — known to be solid)
  → Component burn rate (summed across all FGs using that component)
  → Stock lookup → runway days + builds-worth
  → Vendor resolution → merged with resale items
  → Purchasing Panel (filtered by mode)
  → Draft PO (same flow as today)
```

Sales pull is the demand signal, not the build calendar. Calendar-driven data (Build Risk, Build Demand Oracle) remains as-is for production scheduling visibility — this new pipeline runs alongside it, not replacing it.

## Data Pipeline

### New function: `getBOMDemand(daysBack = 90)`

Lives in `src/lib/finale/client.ts` alongside `getPurchasingIntelligence`.

**Steps:**

1. **FG Sales Velocity** — Query Finale shipment data for manufactured SKUs (products where `isManufactured = true` — currently skipped by purchasing intelligence). Compute `dailySalesRate = shippedQty / daysBack`.

2. **BOM Explosion** — For each FG with sales > 0, call `getBillOfMaterials(sku)` to get component list + quantities per unit. Compute per-component burn: `componentBurnRate = fgDailySalesRate * componentQtyPerUnit`. Sum across all FGs that share the same component.

3. **Component Stock & Runway** — Fetch current stock for each component. `runwayDays = stock / totalBurnRate`. Per-FG `buildsWorth = componentStock / (componentQtyPerUnit * typicalBuildSize)` where `typicalBuildSize` is the median manufactured quantity from Finale's recent production receipts for that FG (last 90 days). If no recent production data exists, fall back to the most recent single production receipt quantity. If none at all, use `dailySalesRate * 30` (a month's worth) as a synthetic batch size.

4. **Vendor Resolution** — Resolve each component's supplier via existing `resolveParty()` + `_partyCacheShared`. Group by vendor.

5. **Urgency Classification** — Same tiers as purchasing intelligence: CRITICAL (runway < leadTime), WARNING (< leadTime + 30), WATCH (< leadTime + 60), OK. Lead times from `LeadTimeService`.

**Efficiency:** Same rules as purchasing intelligence — 3 concurrent workers, 100ms throttle, product-filtered queries, 429 backoff.

### Output Shape

Extends existing interfaces with new fields:

```typescript
// Added to PurchasingItem (or a union type)
itemType: 'resale' | 'bom-component';
feedsFinishedGoods?: {
  sku: string;
  name: string;
  dailySalesRate: number;
  buildsWorth: number;
}[];
totalBurnRate?: number; // summed component consumption across all FGs
```

Resale items get `itemType: 'resale'`, no `feedsFinishedGoods`. BOM items get `itemType: 'bom-component'` with the full FG traceability array.

## API Changes

### `GET /api/dashboard/purchasing`

**New query param:** `?mode=all|resale|bom` (default: `all`)

- `mode=all` or `mode=bom`: runs `getBOMDemand()` alongside `getPurchasingIntelligence()`. Merges vendor groups by `vendorPartyId` — same vendor with both resale and BOM items becomes one group.
- `mode=resale`: existing behavior, no BOM pipeline.
- BOM demand gets its own 30-min cache key. `?bust=1` clears both caches.

### `POST /api/dashboard/purchasing`

**Unchanged.** Draft PO creation accepts `productId + quantity + unitPrice` regardless of item type. No modifications needed.

### Build Screen Summary

**Option A (preferred):** New query param on purchasing route: `?summary=bom&limit=10` — returns top N BOM components by urgency. Avoids a new route.

**Option B:** Dedicated `/api/dashboard/bom-demand` route. Only if the purchasing route becomes unwieldy.

## UI Changes

### Purchasing Panel — Mode Selector

Top of panel, alongside existing snooze toggle:

```
[ All ] [ Resale ] [ BOM Materials ]
```

Default: **All** (preserves current behavior with BOM items mixed in).

### BOM Item Row Enrichment

Each BOM component row gets:

- **Badge:** `BOM` tag next to SKU name
- **"Feeds" line:** `Light Mix (3.2 builds) · LOSOLY3 (5.1 builds) · +2 more` — expandable to show all FGs
- **Suggested qty in build terms:** Instead of "order 500 units" → "order 2,000 lbs (enough for 4 builds of Light Mix)" — rounded to nearest full build batch for the primary FG consumer

### Vendor Group Headers

Show:
- Count of resale + BOM items for that vendor
- Combined estimated order value
- Both types visible in "All" mode for MOQ/shipping consolidation

### Build Schedule Panel — Component Demand Card

New read-only card:

- Top 5-10 components by urgency (lowest runway first)
- Each row: component SKU, runway days, builds-worth (of highest-volume FG), vendor name
- Color-coded urgency badges matching purchasing screen
- "View all in Purchasing →" link navigates to purchasing screen pre-filtered to BOM mode

No PO creation from the build screen. It's a visibility surface only.

## What This Does NOT Change

- **Existing purchasing intelligence** for resale items — untouched, same pipeline, same behavior
- **Build Risk / Build Demand Oracle** — remain calendar-driven, complementary to this demand-driven view
- **Draft PO creation flow** — same POST endpoint, same `createDraftPurchaseOrder()` call
- **Snooze system** — works on BOM items the same way it works on resale items
- **No new database tables** — all computed from Finale data at query time, cached in the API route

## Phases

### Phase 1: Data Engine + Purchasing Filter
- `getBOMDemand()` function
- API route extended with `?mode=` param
- Purchasing panel mode selector (All/Resale/BOM)
- BOM badge on component rows
- `feedsFinishedGoods` + `buildsWorth` displayed inline

### Phase 2: Build-Batch Framing
- Suggested quantities rounded to build batches
- "Feeds" expandable row with per-FG builds-worth breakdown
- Vendor group headers with combined value + item type counts

### Phase 3: Build Screen Summary Card
- Component Demand card on Build Schedule panel
- Top N by urgency, read-only
- Link to purchasing screen filtered to BOM mode
