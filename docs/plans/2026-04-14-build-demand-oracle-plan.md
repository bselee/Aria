# Purchasing Ordering Bugs Fix + Build Demand Oracle — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix all 11 bugs in the purchasing/ordering logic (making it accurate), then build the Build Demand Oracle tab in PurchasingPanel that integrates build calendar component demand with sales-driven purchasing into one unified PO workflow.

**Architecture:** Fix purchasing intelligence accuracy first (bugs #1-11), then add Build Demand Oracle section with two tabs: `Build Demand` and `Oracle Forecast`, both flowing into the same PO draft workflow as existing sales-driven items.

**Tech Stack:** TypeScript, Next.js, Supabase, Finale REST+GraphQL, React

---

## PART 1: FIX PURCHASING ORDERING BUGS

Working directory: `C:\Users\BuildASoil\Documents\Projects\aria\.worktrees\build-demand-oracle`

---

### Bug 1 (Critical): GraphQL Stock `--` → 0 → False CRITICAL

**Files:**
- Modify: `src/lib/finale/client.ts` around lines 4490-4510 (getPurchasingIntelligence stock resolution)
- Test: `src/lib/purchasing/policy-engine.test.ts`

**Root cause:** `getProductActivity()` uses `parseFinaleNum()` which returns `null` for `--`, but the fallback at line 4506 uses `prodData.quantityOnHand` which is undefined for most products → falls through to `0`.

**Fix:** Apply the same fallback chain that `getComponentStockProfile()` uses — check `unitsInStock` field first, then `quantityOnHand`, with proper `parseFinaleNum()` handling.

```typescript
// In getPurchasingIntelligence, replace the stock resolution block:
const stockNode = data?.stockInfo?.edges?.[0]?.node;
const rawStock = stockNode?.unitsInStock ?? stockNode?.stockOnHand ?? null;
const stockOnHand = this.parseFinaleNum(rawStock) ?? parseFinaleNumber(prodData.quantityOnHand ?? null);
// if stockOnHand is still null, do NOT fall back to 0 — leave it null and let urgency logic handle it
```

Key: `parseFinaleNum` returns `null` for `"--"`, and urgency should treat `stockOnHand: null` differently from `stockOnHand: 0`.

---

### Bug 2: Hardcoded Runway Color Thresholds vs Dynamic Urgency

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx` runwayColor function
- No new test needed — visual fix only

**Fix:** Make `runwayColor` use lead-time-aware thresholds matching the policy engine:

```typescript
function runwayColor(days: number, leadTime: number = 14): string {
    if (!Number.isFinite(days)) return 'text-zinc-500';
    if (days < leadTime) return 'text-red-400 font-semibold';
    if (days < leadTime + 30) return 'text-yellow-400 font-semibold';
    if (days < leadTime + 60) return 'text-green-400';
    return 'text-zinc-500';
}
```

Pass `leadTimeDays` from item data as second arg.

---

### Bug 3: `suggestedQty` Ignores `minimumOrderQty` Pack Size Floor

**Files:**
- Modify: `src/lib/finale/client.ts` suggestedQty computation
- Modify: `src/lib/purchasing/policy-engine.ts` deriveEffectiveOrderQty

**Fix:** Apply minimum before snapping to increment:

```typescript
const minQty = item.minimumOrderQty ?? 0;
const rawSuggestedQty = Math.max(minQty, Math.max(1, dailyRate * (leadTimeDays + 60)));
const suggestedQty = Math.ceil(rawSuggestedQty / orderIncrementQty) * orderIncrementQty;
```

---

### Bug 4: Velocity Fallback Only When dailyRate === 0 (Strict)

**Files:**
- Modify: `src/lib/finale/client.ts` getProductActivity fallback logic
- Test: Add unit test for this edge case

**Fix:** Change fallback trigger from `dailyRate === 0` to `dailyRate < purchaseVelocity * 0.5` — if purchase history shows significantly higher velocity than demand signal, trust the purchase history:

```typescript
if ((dailyRate === 0 || dailyRate < purchaseVelocity * 0.5) && purchaseVelocity > 0) {
    dailyRate = purchaseVelocity;
    rateSource = dailyRate === 0 ? rateSource : 'receipts';
}
```

---

### Bug 5: `directDemand` Fallback to `salesVelocity` Wrong for Components

**Files:**
- Modify: `src/lib/purchasing/policy-candidates.ts`
- Test: Add unit test for component demand scenario

**Fix:** Prefer `demandVelocity` (which includes BOM consumption in Finale) over `salesVelocity` for direct demand:

```typescript
const directDemand = context.directDemand
    ?? Math.max(item.demandVelocity > 0 ? item.demandVelocity : item.salesVelocity, 0);
```

---

### Bug 6: `isOnOrderCoverageHealthy` Uses Runway, Not PO Match

**Files:**
- Modify: `src/lib/purchasing/policy-engine.ts`
- Test: Add test case

**Fix:** Add minimum PO coverage check — PO only "counts" if it covers at least `leadTimeDays` of demand:

```typescript
function isOnOrderCoverageHealthy(input: PurchasingCandidateInput): boolean {
    const onOrder = input.stockOnOrder ?? 0;
    if (onOrder <= 0) return false;
    if (input.adjustedRunwayDays === null) return false;
    const baselineCoverage = Math.max(input.leadTimeDays ?? 0, HEALTHY_FINISHED_GOODS_COVERAGE_DAYS);
    const poMeetsMinimumCoverage = onOrder >= (input.dailyRate ?? 0) * (input.leadTimeDays ?? 0);
    return input.adjustedRunwayDays >= baselineCoverage && poMeetsMinimumCoverage;
}
```

---

### Bug 7: `chooseVelocitySignal` Ignores PurchaseVelocity for Nonzero Demand

**Files:**
- Modify: `src/lib/finale/client.ts` chooseVelocitySignal function
- Test: Add test case

**Fix:** If primary signal returns near-zero but purchase history is meaningfully higher, prefer purchase history:

```typescript
const primaryRate = chosenSignal === 'demand' ? demandVelocity : salesVelocity;
if (primaryRate < 0.5 * purchaseVelocity && purchaseVelocity > 0) {
    return { dailyRate: purchaseVelocity, source: 'receipts' };
}
```

---

### Bug 8: Two Hold Conditions Can Conflict

**Files:**
- Modify: `src/lib/purchasing/policy-engine.ts`
- Test: Add test case

**Fix:** Add explicit priority — on-order coverage check only applies to sales-driven items, not BOM-driven ones. Check `demandSource` before applying on-order hold.

```typescript
// In applyHold for on-order coverage: skip if demandSource === 'bom' or item has no sales velocity
```

---

### Bug 9: Focus Bucket OR Logic Inflates Counts

**Files:**
- Modify: `src/lib/purchasing/dashboard-focus.ts`
- Test: Add unit test

**Fix:** Change `||` to `&&`:

```typescript
if (item.urgency === 'critical' && runwayDays <= leadTimeDays) return 'today';
if (item.urgency === 'warning' && runwayDays <= leadTimeDays + 7) return 'week';
```

---

### Bug 10: `runUlineConfirmationSync` Is Empty Placeholder

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
**Fix:** Add `// TODO: implement` comment with reference to reconciliation workflow.

---

### Bug 11: Auto-Select Critical Items Policy Would Hold

**Files:**
- Modify: `src/lib/purchasing/dashboard-focus.ts`
- Test: Add unit test

**Fix:** Check `assessment.decision` BEFORE urgency:

```typescript
export function shouldAutoSelectItem(item: FocusItem, ...): boolean {
    const decision = item.assessment?.decision;
    if (decision === 'order' || decision === 'reduce') return true;
    if (decision === 'hold' || decision === 'manual_review') return false;
    return item.urgency === 'critical';
}
```

---

## PART 2: BUILD DEMAND ORACLE

---

### Task B1: Oracle Computation Engine

**Files:**
- Create: `src/lib/builds/build-demand-oracle.ts`
- Test: `src/lib/builds/build-demand-oracle.test.ts`

```typescript
export interface OracleForecastItem {
    componentSku: string;
    weeks14Confirmed: number;
    weeks58Projected: number;
    weeks912Extrapolated: number;
    onHand: number | null;
    leadTimeDays: number | null;
    runwayDays: number | null;
    status: 'ORDER NOW' | 'REORDER SOON' | 'COVERED';
    demandSource: 'mfg' | 'mixed';
    blocksBuilds: string[];
}

export function computeOracleForecast(
    components: Map<string, ComponentDemand>,
    fgVelocity: Map<string, FGVelocity>
): OracleForecastItem[]
```

- `weeks14Confirmed` = current `totalRequiredQty` from BOM explosion (already in ComponentDemand)
- `weeks58Projected` = monthly run rate × 1
- `weeks912Extrapolated` = modify by any FG velocity trend
- Status: `ORDER NOW` if onHand < weeks14Confirmed; `REORDER SOON` if covers weeks 1-4 but not 5-8; `COVERED` otherwise

---

### Task B2: Integrate Oracle into BuildRiskReport

**Files:**
- Modify: `src/lib/builds/build-risk.ts` (add oracle to return)
- Modify: `src/lib/builds/build-risk-logger.ts` (save oracle to snapshot)

---

### Task B3: Build Demand Tab in PurchasingPanel

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Add new tab: `Build Demand`

Transform `ComponentDemand[]` into `PurchasingItem[]` so existing row rendering, checkbox selection, qty editing, and PO creation all work unchanged.

---

### Task B4: Oracle Forecast Tab

**Files:**
- Modify: `PurchasingPanel.tsx` — oracle tab
- Table columns: SKU | Wk 1-4 (est.) | Wk 5-8 (est.) | Wk 9-12 (est.) | On Hand | Runway | Status
- Checkbox to add items to PO draft
- Collapsible row showing which builds this component supports

---

### Task B5: Unified PO Draft

**Files:**
- Modify: PO creation flow to accept items from all tabs
- Show `demandSource` tag per line item in review modal
- Handle `TBD` pricing for MFG items

---

### Task B6: `demandSource` Tag for All Purchasing Items

**Files:**
- Modify: `src/lib/finale/client.ts` — add demandSource to PurchasingItem
- Modify: `src/lib/purchasing/policy-engine.ts` — MFG items excluded from on-order hold

---

## Testing Strategy

For each bug fix: write failing unit test → fix → verify pass → commit
For Oracle: probe script verifies numbers against manual calculation

## Commit Plan

1. Bugs #1-3 (stock cascade, runway colors, minimumOrderQty)
2. Bugs #4-6 (velocity fallback, directDemand, on-order check)
3. Bugs #7-9 (chooseVelocitySignal, hold conflicts, focus bucket)
4. Bugs #10-11 (placeholder, auto-select)
5. Task B1 (oracle engine)
6. Task B2 (snapshot storage)
7. Task B3 (Build Demand tab)
8. Task B4 (Oracle Forecast tab)
9. Task B5-B6 (unified PO + demandSource)