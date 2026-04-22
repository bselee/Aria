# Oracle Cleanup + Batch Vendor Resolution + Forecast Chaining

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land 7 tasks — batch vendor resolver wired into build-risk, chained 12-week forecast, typed adapter, confidence tiers, stale comment deletion, Oracle UI enabled, and Oracle→PO draft wire-up.

**Architecture:** `ComponentDemand.vendorName` is populated by `build-risk.ts` via a new `FinaleClient.lookupComponentVendorBatch()`. The oracle reads pre-populated `ComponentDemand.vendorName` directly (no oracle-side cache). PurchasingPanel remains source of truth for PO qty decisions.

**Branch strategy:** All commits go to `feature/build-demand-oracle` worktree. Do NOT commit directly to `main`.

**Tech Stack:** TypeScript, tsx, vitest (`npx vitest run`), Finale REST API

---

## Task 1: Wire vendor resolution into `build-risk.ts` (ComponentDemand.vendorName)

**Files:**
- Modify: `src/lib/finale/client.ts` — add `lookupComponentVendorBatch()`
- Modify: `src/lib/builds/build-risk.ts` — call batch resolver at stock verification step
- Test: `src/lib/builds/build-demand-oracle.test.ts` (new)

**Context (verified):**
- `lookupProduct(sku)` at client.ts:1198 returns `FinaleProductDetail | null`
- `FinaleProductDetail.suppliers: SupplierInfo[]` — each has `partyUrl` (e.g. `https://…/partygroup/abc123`)
- `partyId` = `partyUrl.split('/').pop()`
- `FinaleClient.get(partyUrl)` fetches `{ groupName }` — same as private `resolvePartyName`
- `PARTY_CACHE_TTL = 60 * 60 * 1000` (1h) — vendor name is cached within FinaleClient

**Step 1: Add `lookupComponentVendorBatch()` to `FinaleClient` in `client.ts`**

Add near `lookupProduct()` (after line 1220):

```typescript
/**
 * Batch-resolve vendor name + partyId for an array of component SKUs.
 * Calls lookupProduct() per SKU (suppliers already resolved via parseProductDetail).
 * Extracts MAIN supplier's partyUrl → partyId + groupName.
 * Returns sku → { vendorName, vendorPartyId }.
 * Unresolvable SKUs produce { vendorName: 'Unknown Vendor', vendorPartyId: null }.
 */
async lookupComponentVendorBatch(
    skus: string[],
): Promise<Map<string, { vendorName: string; vendorPartyId: string | null }>> {
    const results = new Map<string, { vendorName: string; vendorPartyId: string | null }>();

    await Promise.allSettled(
        skus.map(async (sku) => {
            try {
                const product = await this.lookupProduct(sku);
                if (!product || product.suppliers.length === 0) {
                    results.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null });
                    return;
                }
                const main = product.suppliers.find(s => s.role === 'MAIN') ?? product.suppliers[0];
                const partyId = main.partyUrl.split('/').pop() ?? null;
                const vendorName = main.name || 'Unknown Vendor';
                results.set(sku, {
                    vendorName,
                    vendorPartyId: partyId,
                });
            } catch {
                results.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null });
            }
        }),
    );

    return results;
}
```

**Step 2: Call batch resolver in `build-risk.ts` at stock verification step**

Read `build-risk.ts` around the stock verification step (search for `demandEntries.map`):

```typescript
const demandEntries = Array.from(componentDemandTracker.values());
```

Before that line, add:

```typescript
// Batch-resolve vendor info for all component SKUs before parallel stock verification
const allSkus = demandEntries.map(d => d.componentSku);
const vendorMap = await finale.lookupComponentVendorBatch(allSkus);
```

Inside the parallel task, after updating fields from `profile`, add:

```typescript
// Attach vendor resolution (already resolved above)
const resolved = vendorMap.get(demand.componentSku);
if (resolved) {
    demand.vendorName = resolved.vendorName;
    demand.vendorPartyId = resolved.vendorPartyId;
}
```

**Keep** the `vendorName: null` and `vendorPartyId: null` initialization in the component-demand tracker constructor (lines 249-250) as fallbacks — they serve as defaults until the async task populates them.

**Step 3: Write failing test**

Create `src/lib/builds/build-demand-oracle.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { computeBuildDemandOracle } from './build-demand-oracle';
import type { BuildRiskReport } from './build-risk';

const makeReport = (overrides: Partial<BuildRiskReport> = {}): BuildRiskReport => ({
  runsOn: new Date().toISOString(),
  asOf: new Date().toISOString(),
  builds: [],
  components: new Map(),
  fgVelocity: new Map(),
  ...overrides,
} as BuildRiskReport);

describe('build-demand-oracle', () => {
  it('uses ComponentDemand.vendorName for oracle grouping', async () => {
    const report = makeReport({
      components: new Map([['CMP-001', {
        componentSku: 'CMP-001',
        onHand: 10,
        stockoutDays: null,
        leadTimeDays: 14,
        incomingPOs: [],
        usedIn: new Set(),
        designations: new Set(),
        riskLevel: 'WARNING' as const,
        earliestBuildDate: new Date().toISOString(),
        hasFinaleData: true,
        vendorName: 'BioAg',
        vendorPartyId: 'party-123',
      }]]),
    });
    const oracle = await computeBuildDemandOracle(report);
    expect(oracle.ordersNeededNow[0]?.vendorName).toBe('BioAg');
    expect(oracle.ordersNeededNow[0]?.vendorPartyId).toBe('party-123');
  });

  it('falls back to Unknown Vendor for null vendorName', async () => {
    const report = makeReport({
      components: new Map([['UNKNOWN-SKU', {
        componentSku: 'UNKNOWN-SKU',
        onHand: 5,
        stockoutDays: null,
        leadTimeDays: 14,
        incomingPOs: [],
        usedIn: new Set(),
        designations: new Set(),
        riskLevel: 'CRITICAL' as const,
        earliestBuildDate: new Date().toISOString(),
        hasFinaleData: true,
        vendorName: null,
        vendorPartyId: null,
      }]]),
    });
    const oracle = await computeBuildDemandOracle(report);
    expect(oracle.ordersNeededNow[0]?.vendorName).toBe('Unknown Vendor');
    expect(oracle.ordersNeededNow[0]?.vendorPartyId).toBe(null);
  });
});
```

`computeBuildDemandOracle` reads from `ComponentDemand.vendorName` directly — no oracle-side cache needed.

**Step 4: Update `build-demand-oracle.ts` to read from `ComponentDemand`**

In `build-demand-oracle.ts`, replace the `resolveVendorName` placeholder with:

```typescript
function resolveVendorName(comp: ComponentDemand): { vendorName: string; vendorPartyId: string | null } {
    return {
        vendorName: comp.vendorName ?? 'Unknown Vendor',
        vendorPartyId: comp.vendorPartyId ?? null,
    };
}
```

Remove: `_vendorCache`, `resolveVendorBatch`, the `ORACLE_ENABLED = false` gate, and `isOracleEnabled()`. The oracle is always live once `ComponentDemand.vendorName` is populated by build-risk.

**Step 5: Make call sites async in `BuildSchedulePanel.tsx`**

Both `BuildDemandSection` and `OracleForecastSection` currently use `useMemo` with sync `computeBuildDemandOracle`. Convert to `useEffect + useState`:

```typescript
// Before (sync):
const oracle = useMemo<BuildDemandOracle | null>(() => {
  if (!snapshot) return null;
  const { builds, components, fgVelocity } = snapshotDataToReport(snapshot);
  return computeBuildDemandOracle({ builds, components, fgVelocity } as any);
}, [snapshot]);

// After (async):
const [oracle, setOracle] = useState<BuildDemandOracle | null>(null);
useEffect(() => {
  if (!snapshot) { setOracle(null); return; }
  setOracle(null); // reset while loading
  (async () => {
    const { builds, components, fgVelocity } = snapshotDataToReport(snapshot);
    const result = await computeBuildDemandOracle({ builds, components, fgVelocity } as any);
    setOracle(result);
  })();
}, [snapshot]);
```

Apply to both `BuildDemandSection` and `OracleForecastSection`.

**Step 6: Run test to verify it fails**

```bash
npx vitest run src/lib/builds/build-demand-oracle.test.ts
```
Expected: FAIL (method doesn't exist yet)

**Step 7: Implement `lookupComponentVendorBatch` in `client.ts`**

```bash
npx vitest run src/lib/builds/build-demand-oracle.test.ts
```
Expected: PASS

**Step 8: Run all tests**

```bash
npm run typecheck:cli 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
npx vitest run --reporter=dot
```
Expected: all PASS

**Step 9: Commit**

```bash
git add src/lib/finale/client.ts src/lib/builds/build-risk.ts src/lib/builds/build-demand-oracle.ts src/lib/builds/build-demand-oracle.test.ts src/components/dashboard/BuildSchedulePanel.tsx
git commit -m "feat(build-risk): populate ComponentDemand vendorName/vendorPartyId via batch lookup"
```

---

## Task 2: Chain 12-week forecast — `dailyRate * 7 * componentQtyPerFg` for weeks 5-12

**Files:**
- Modify: `src/lib/builds/build-demand-oracle.ts`
- Test: add test to `build-demand-oracle.test.ts`

**Decision (committed):** Use `FGVelocity.dailyRate * 7 * componentQtyPerFg` as the weekly component demand for weeks 5-12, falling back to the flat wk-1-4 baseline when `dailyRate` is 0 or the component has no `usedIn` FGs with velocity data.

`FGVelocity.dailyRate` = units/day of FG sold. Chaining: `dailyRate (units FG/day) * 7 (days/week) * (componentQtyPerFg)` = units component/week.

A component may be used in multiple FGs — sum contributions across all `usedIn` FGs.

**Step 1: Implement `chainFgVelocityToWeeklyDemand()` helper**

```typescript
/**
 * Chain FG sales velocity → component demand for weeks 5-12.
 * weeklyComponentDemand = fgDailyRate * 7 days * componentQtyPerFg.
 * Falls back to flatBaseline when fgDailyRate is 0 or FG not in fgVelocity map.
 */
function chainFgVelocityToWeeklyDemand(
    componentSku: string,
    componentQtyPerFg: number,  // qty of this component per 1 unit of FG
    fgVelocityMap: Map<string, FGVelocity>,
    flatBaseline: number,
): { w58: number; w912: number } {
    // A component can be used in multiple FGs — sum all contributions
    const usedIn = getUsedInSkus(componentSku); // needs to be passed or closure-scoped
    let totalWeeklyComponentDemand = 0;
    for (const fgSku of usedIn) {
        const fgVel = fgVelocityMap.get(fgSku);
        if (!fgVel || fgVel.dailyRate <= 0) continue;
        totalWeeklyComponentDemand += fgVel.dailyRate * 7 * componentQtyPerFg;
    }
    if (totalWeeklyComponentDemand === 0) {
        return { w58: flatBaseline, w912: flatBaseline };
    }
    return { w58: totalWeeklyComponentDemand, w912: totalWeeklyComponentDemand };
}
```

Note: the oracle already computes `componentQtyPerFg` from the BOM explosion when iterating builds. Pass it into the helper. The `usedIn` FGs for a component are available from `ComponentDemand.usedIn`.

**Step 2: Add test**

```typescript
it('uses dailyRate * 7 * componentQtyPerFg for weeks 5-12', async () => {
  const report = makeReport({
    fgVelocity: new Map([['FG-001', {
      fgSku: 'FG-001',
      dailyRate: 2,      // 2 units FG sold per day
      stockOnHand: 100,
      daysOfFinishedStock: 50,
      openDemandQty: 0,
    }]]),
    components: new Map([['CMP-001', {
      componentSku: 'CMP-001',
      onHand: 100,
      stockoutDays: null,
      leadTimeDays: 14,
      incomingPOs: [],
      usedIn: new Set(['FG-001']),
      designations: new Set(),
      riskLevel: 'OK' as const,
      earliestBuildDate: new Date().toISOString(),
      hasFinaleData: true,
      vendorName: 'BioAg',
      vendorPartyId: 'p1',
    }]]),
    builds: [{
      sku: 'FG-001',
      quantity: 10,
      buildDate: new Date().toISOString(),
      designation: 'SOIL',
      designations: new Set(['SOIL']),
    }],
  });
  const oracle = await computeBuildDemandOracle(report);
  const comp = oracle.twelveWeekForecast[0]?.components[0];
  // 2 units/day * 7 days * 1 CMP per FG = 14 CMP/wk
  expect(comp?.weeklyNeedW158).toBe(14);
  expect(comp?.weeklyNeedW1912).toBe(14);
});
```

**Step 3: Commit**

```bash
git add src/lib/builds/build-demand-oracle.ts src/lib/builds/build-demand-oracle.test.ts
git commit -m "feat(oracle): chain FG dailyRate to component demand for 12-week forecast"
```

---

## Task 3: Type the `snapshotDataToReport` adapter + fix `computeOracleStatus` tests

**Files:**
- Modify: `src/components/dashboard/BuildSchedulePanel.tsx:589-603`
- Test: add tests for `computeOracleStatus` four-way branching

**Step 1: Define complete Snapshot interfaces**

```typescript
interface SnapshotBuild {
  sku: string;
  quantity: number;
  buildDate: string;
  designation: string;
  status?: string;
}

interface SnapshotComponent {
  componentSku: string;
  totalRequiredQty: number;
  onHand: number | null;
  onOrder: number | null;
  stockoutDays: number | null;
  demandQuantity: number | null;
  consumptionQuantity: number | null;
  leadTimeDays: number | null;
  incomingPOs: Array<{ orderId: string; supplier: string; quantity: number; orderDate: string }>;
  usedIn: string[];
  designations: string[];
  riskLevel: ComponentUrgency;
  earliestBuildDate: string;
  hasFinaleData: boolean;
  vendorName: string | null;
  vendorPartyId: string | null;
}

interface Snapshot {
  builds: SnapshotBuild[];
  components: Record<string, SnapshotComponent>;
  fgVelocity?: Record<string, FGVelocity>;
  runsOn: string;
  asOf: string;
}
```

**Step 2: Rewrite adapter with proper types**

```typescript
function snapshotDataToReport(snapshot: Snapshot) {
  const builds = snapshot.builds.map((b: SnapshotBuild) => ({
    ...b,
    designations: new Set([b.designation]),
  }));
  const components = new Map<string, ComponentDemand>(
    Object.entries(snapshot.components ?? {}).map(([sku, comp]: [string, SnapshotComponent]) => [
      sku,
      {
        ...comp,
        usedIn: new Set(comp.usedIn),
        designations: new Set(comp.designations),
        onOrder: comp.onOrder ?? null,
        demandQuantity: comp.demandQuantity ?? null,
        consumptionQuantity: comp.consumptionQuantity ?? null,
      } as ComponentDemand,
    ]),
  );
  const fgVelocity = new Map<string, FGVelocity>(
    Object.entries(snapshot.fgVelocity ?? {}).map(([sku, fgv]: [string, FGVelocity]) => [sku, fgv]),
  );
  return { builds, components, fgVelocity };
}
```

**Step 3: Add `computeOracleStatus` tests**

The four-way `oracleStatus` branching (`ORDER NOW` / `REORDER SOON` / `COVERED`) is the most visible piece to Will. Test all four paths:

```typescript
it('returns ORDER NOW when gap < 0 (stockout risk)', async () => {
  // gap = onHand - thirtyDayNeed < 0 → order NOW
});

it('returns ORDER NOW when stockoutDays < leadTimeDays (imminent stockout)', async () => {
  // stockout imminent even if gap >= 0
});

it('returns REORDER SOON when onHand covers need but runway < leadTime', async () => {
  // covered for now, but reorder before next delivery
});

it('returns COVERED when onHand + incomingPOs cover 30-day need', async () => {
  // no action needed
});
```

**Step 4: Verify build**

```bash
npm run typecheck:cli 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
```

**Step 5: Commit**

```bash
git add src/components/dashboard/BuildSchedulePanel.tsx src/lib/builds/build-demand-oracle.test.ts
git commit -m "fix(build-schedule): type snapshotDataToReport with all required fields"
```

---

## Task 4: Add confidence tier labels to forecast table

**Files:**
- Modify: `src/components/dashboard/BuildSchedulePanel.tsx` (forecast table section)

**Step 1: Find the forecast table JSX** — it renders `weeklyNeedW149`, `weeklyNeedW158`, `weeklyNeedW1912`.

**Step 2: Add (est.) suffix to projected columns only**

- `weeklyNeedW149` (wk 1-4): confirmed calendar builds → no suffix
- `weeklyNeedW158` (wk 5-8): projected → `(est.)` in muted `text-gray-400 text-xs`
- `weeklyNeedW1912` (wk 9-12): projected → `(est.)` in muted `text-gray-400 text-xs`

**Step 3: Commit**

```bash
git add src/components/dashboard/BuildSchedulePanel.tsx
git commit -m "feat(oracle): label projected forecast weeks with (est.) confidence marker"
```

---

## Task 5: Delete stale FIX comment from policy-candidates.ts

**Files:**
- Modify: `src/lib/purchasing/policy-candidates.ts:29-32`

**Step 1: Delete entirely**

Remove all 4 lines of the `FIX(2026-04-14)` comment block. No replacement comment.

**Step 2: Commit**

```bash
git add src/lib/purchasing/policy-candidates.ts
git commit -m "chore: delete stale date-stamped comment from policy-candidates"
```

---

## Task 6: Enable Oracle UI — delete gate entirely

**Files:**
- Modify: `src/lib/builds/build-demand-oracle.ts`

Delete `ORACLE_ENABLED`, `isOracleEnabled()`, and all conditional guards in `BuildSchedulePanel.tsx` that use them. The oracle is always rendered when a snapshot is present.

**Rollback:** `git show <commit>:src/lib/builds/build-demand-oracle.ts | Select-String "ORACLE_ENABLED"` to find the commit, then `git revert <commit>`.

**Step 1: Delete the gate**

Remove:
```typescript
export const ORACLE_ENABLED = false;
export function isOracleEnabled(): boolean { return ORACLE_ENABLED; }
```

Remove `{ isOracleEnabled() && <BuildDemandSection /> }` and `{ isOracleEnabled() && <OracleForecastSection /> }` wrappers in `BuildSchedulePanel.tsx`. Render both sections unconditionally when snapshot is present.

**Step 2: Commit**

```bash
git add src/lib/builds/build-demand-oracle.ts src/components/dashboard/BuildSchedulePanel.tsx
git commit -m "feat(oracle): remove ORACLE_ENABLED gate, oracle always visible"
```

---

## Task 7: Wire Oracle "Orders Needed Now" rows to Draft PO workflow

**Files:**
- Modify: `src/components/dashboard/BuildSchedulePanel.tsx`
- Research: find `createDraftPurchaseOrder()` signature and how PurchasingPanel calls it

**Step 1: Find `createDraftPurchaseOrder()`**

Search `src/` for `createDraftPurchaseOrder` or `draftPurchaseOrder`.

**Step 2: Add "Create PO" button to each Oracle vendor group**

In the `BuildDemandSection` vendor group header, add a "Create PO" button that calls `createDraftPurchaseOrder()` with:
- `vendorPartyId`: from `group.vendorPartyId`
- `items`: from `group.components.map(c => ({ productId: c.componentSku, quantity: c.orderQty }))`

Only enable the button when `group.vendorPartyId !== null`.

**Step 3: Add click handler**

If the component uses a callback to a parent (e.g., `onDraftPO`), pass it up. Otherwise, call `createDraftPurchaseOrder()` directly from the click handler.

**Step 4: Commit**

```bash
git add src/components/dashboard/BuildSchedulePanel.tsx
git commit -m "feat(oracle): wire Orders Needed Now rows to createDraftPurchaseOrder"
```

---

## Task 8: Vendor cache TTL — 4h TTL matching LeadTimeService

**Files:**
- Modify: `src/lib/finale/client.ts` — `lookupComponentVendorBatch()`

**Step 1: Add module-level vendor cache with 4h TTL**

```typescript
const _vendorCache = new Map<string, { vendorName: string; vendorPartyId: string | null; ts: number }>();
const VENDOR_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async lookupComponentVendorBatch(skus: string[]): Promise<...> {
    const now = Date.now();
    const results = new Map<string, { vendorName: string; vendorPartyId: string | null }>();

    // Separate cached vs uncached
    const uncachedSkus: string[] = [];
    for (const sku of skus) {
        const cached = _vendorCache.get(sku);
        if (cached && now - cached.ts < VENDOR_CACHE_TTL) {
            results.set(sku, { vendorName: cached.vendorName, vendorPartyId: cached.vendorPartyId });
        } else {
            uncachedSkus.push(sku);
        }
    }

    if (uncachedSkus.length > 0) {
        // Batch-fetch uncached SKUs
        await Promise.allSettled(
            uncachedSkus.map(async (sku) => {
                try {
                    const product = await this.lookupProduct(sku);
                    // ... resolve vendor ...
                    _vendorCache.set(sku, { vendorName, vendorPartyId, ts: now });
                    results.set(sku, { vendorName, vendorPartyId });
                } catch {
                    _vendorCache.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null, ts: now });
                    results.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null });
                }
            }),
        );
    }

    return results;
}
```

**Step 2: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat(finale): add 4h TTL to lookupComponentVendorBatch cache"
```

---

## Final Verification

After all tasks:

```bash
npm run typecheck:cli 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator"
npx vitest run --reporter=dot
```

All tests should pass. Oracle UI renders with real vendor names and chained 12-week forecast.
