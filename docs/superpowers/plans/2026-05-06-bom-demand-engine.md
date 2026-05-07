# BOM Demand Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add demand-driven BOM component purchasing to the existing purchasing panel — items tagged by type, filterable by mode, with build-batch context for BOM materials.

**Architecture:**
- **Pure functions** (`computeComponentBurnRates`, `classifyUrgency`, `mergeIntoGroups`) live in `src/lib/finale/bom-demand.ts` with their own tests — no Finale dependency, no module cache.
- **Async pipeline** is a public method `FinaleClient.getBOMDemand()` on `client.ts` (alongside `getPurchasingIntelligence`) so it shares auth/state legitimately. It calls the public methods `client.getBillOfMaterials(sku)` and `client.getProductActivity(sku, daysBack)` (the latter promoted from private in Task 1) plus `leadTimeService.getForVendor()` for lead times.
- **Route** (`/api/dashboard/purchasing`) holds the BOM cache the same way it holds the resale cache, accepts `?mode=all|resale|bom` and `?summary=bom`, and merges via `mergeIntoGroups`.
- **UI** adds a mode toggle and BOM-only "feeds" context line.

**Tech Stack:** TypeScript, Next.js API routes, React (PurchasingPanel), Finale REST + GraphQL APIs, vitest for tests.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/lib/finale/client.ts` | Extend `PurchasingItem` with `itemType` + `feedsFinishedGoods`; promote `getProductActivity` to `public`; export shared `EXCLUDED_VENDOR_PATTERN`; add `FinaleClient.getBOMDemand()` method |
| Create | `src/lib/finale/bom-demand.ts` | Pure functions only: `computeComponentBurnRates`, `classifyUrgency`, `mergeIntoGroups` + types |
| Create | `src/lib/finale/bom-demand.test.ts` | Unit tests for the three pure functions |
| Modify | `src/app/api/dashboard/purchasing/route.ts` | Add `?mode=` + `?summary=bom` params, hold BOM cache, merge groups |
| Modify | `src/components/dashboard/PurchasingPanel.tsx` | Mode selector toggle, BOM badge, "feeds" line |
| Create | `src/components/dashboard/ComponentDemandCard.tsx` | Read-only build-screen summary card (top N components by urgency) |
| Modify | `src/components/dashboard/BuildSchedulePanel.tsx` | Slot `ComponentDemandCard` into panel |

---

### Task 1: Extend PurchasingItem + expose internals BOM pipeline needs

**Files:**
- Modify: `src/lib/finale/client.ts`

This task makes the small, isolated `client.ts` changes the rest of the plan depends on: new optional fields on `PurchasingItem`, promoting `getProductActivity` to public, and extracting the dropship/excluded-vendor regex to a shared module-level const so both pipelines reference the same source of truth.

- [ ] **Step 1: Add `itemType`, `feedsFinishedGoods`, `totalBurnRate` to `PurchasingItem`**

Find the `PurchasingItem` interface in `src/lib/finale/client.ts` (grep anchor: `^export interface PurchasingItem`). Add these fields at the end of the interface, just before the closing `}`:

```typescript
    /** v3 — BOM demand engine: classifies item as resale or BOM component */
    itemType?: 'resale' | 'bom-component';
    /** v3 — which finished goods consume this component, with demand context.
     *  buildsWorth is approximate (uses dailySalesRate*30 as batch proxy in v1). */
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    /** v3 — total daily burn rate summed across all FG consumers (BOM items only) */
    totalBurnRate?: number;
```

- [ ] **Step 2: Promote `getProductActivity` to public**

Find the method declaration (grep anchor: `private async getProductActivity`). Remove the `private` keyword:

```typescript
async getProductActivity(sku: string, daysBack: number): Promise<{
```

CLAUDE.md already documents `getProductActivity` as effectively public (combined-query pattern shared with `findCommittedPOsForProduct`). The BOM pipeline reuses it for FG sales velocity.

- [ ] **Step 3: Extract excluded-vendor regex to a shared module-level const**

Currently the dropship/manufactured exclusion regex is duplicated inside the closure-scoped `resolveParty` helpers (around line 4193 and 4839 — search anchor: `autopot|printful|grand`). Add a module-level export near the other top-of-file constants (search anchor: `URGENCY_RANK` or `_partyCacheShared`):

```typescript
/** Vendors we never order from on the purchasing dashboard:
 *  internal manufacturing depts + dropship vendors handled outside the PO flow.
 *  Shared by getPurchasingIntelligence and getBOMDemand so the two pipelines stay aligned. */
export const EXCLUDED_VENDOR_PATTERN =
    /buildasoil|manufacturing|soil dept|bas soil|autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;
```

Then update the two closure-scoped uses to call `EXCLUDED_VENDOR_PATTERN.test(groupName)` instead of inline regex literals (preserve their existing isManufactured/isDropship split — those stay separate booleans; this constant is just the *combined* gate). Concretely: in each `resolveParty` closure, the existing `isManufactured = ...test(groupName)` and `isDropship = ...test(groupName)` lines are unchanged. Only the BOM pipeline (Task 3) will use the combined `EXCLUDED_VENDOR_PATTERN` directly. **No behavior change in this step** — just exporting the combined pattern.

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck:cli 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator" | head -20
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat(purchasing): extend PurchasingItem + expose BOM-pipeline internals

- Add itemType/feedsFinishedGoods/totalBurnRate optional fields
- Promote getProductActivity to public (shared with BOM pipeline)
- Export EXCLUDED_VENDOR_PATTERN — single source for dropship/mfg exclusion

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Pure compute functions in bom-demand.ts

**Files:**
- Create: `src/lib/finale/bom-demand.ts`
- Create: `src/lib/finale/bom-demand.test.ts`

- [ ] **Step 1: Write failing tests for burn rate computation**

Create `src/lib/finale/bom-demand.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeComponentBurnRates, classifyUrgency, mergeIntoGroups } from './bom-demand';

describe('computeComponentBurnRates', () => {
    it('sums burn rate across multiple FGs sharing a component', () => {
        const fgVelocities = [
            { sku: 'LIGHT-MIX', name: 'Light Mix', dailySalesRate: 10, bom: [{ componentSku: 'PERLITE', quantity: 2 }, { componentSku: 'COMPOST', quantity: 5 }] },
            { sku: 'CRAFT-LITE', name: 'Craft Lite', dailySalesRate: 5, bom: [{ componentSku: 'PERLITE', quantity: 3 }] },
        ];
        const result = computeComponentBurnRates(fgVelocities);
        // PERLITE: 10*2 + 5*3 = 35/day
        expect(result.get('PERLITE')!.totalBurnRate).toBe(35);
        expect(result.get('PERLITE')!.feedsFinishedGoods).toHaveLength(2);
        // COMPOST: 10*5 = 50/day
        expect(result.get('COMPOST')!.totalBurnRate).toBe(50);
        expect(result.get('COMPOST')!.feedsFinishedGoods).toHaveLength(1);
    });

    it('computes buildsWorth from stock and per-unit qty', () => {
        const fgVelocities = [
            { sku: 'LIGHT-MIX', name: 'Light Mix', dailySalesRate: 10, bom: [{ componentSku: 'PERLITE', quantity: 2 }] },
        ];
        const result = computeComponentBurnRates(fgVelocities);
        const perlite = result.get('PERLITE')!;
        // With 100 units of PERLITE and typical build size 50, buildsWorth = 100/(2*50) = 1
        const buildsWorth = perlite.computeBuildsWorth(100, 50);
        expect(buildsWorth).toBe(1);
    });
});

describe('classifyUrgency', () => {
    it('returns critical when runway < lead time', () => {
        expect(classifyUrgency(10, 14)).toBe('critical');
    });
    it('returns warning when runway < lead time + 30', () => {
        expect(classifyUrgency(30, 14)).toBe('warning');
    });
    it('returns watch when runway < lead time + 60', () => {
        expect(classifyUrgency(60, 14)).toBe('watch');
    });
    it('returns ok when runway >= lead time + 60', () => {
        expect(classifyUrgency(90, 14)).toBe('ok');
    });
});

describe('mergeIntoGroups', () => {
    it('merges BOM items into existing vendor group', () => {
        const resaleGroups = [{
            vendorName: 'Acme Corp', vendorPartyId: 'p1', urgency: 'ok' as const,
            items: [{ productId: 'WIDGET', supplierPartyId: 'p1', itemType: 'resale' as const } as any],
        }];
        const bomGroups = [{
            vendorName: 'Acme Corp', vendorPartyId: 'p1', urgency: 'critical' as const,
            items: [{ productId: 'PERLITE', supplierPartyId: 'p1', itemType: 'bom-component' as const } as any],
        }];
        const merged = mergeIntoGroups(resaleGroups, bomGroups);
        expect(merged).toHaveLength(1);
        expect(merged[0].items).toHaveLength(2);
        // Worst urgency wins
        expect(merged[0].urgency).toBe('critical');
    });

    it('keeps vendor groups separate when different vendors', () => {
        const resaleGroups = [{ vendorName: 'A', vendorPartyId: 'p1', urgency: 'ok' as const, items: [] }];
        const bomGroups = [{ vendorName: 'B', vendorPartyId: 'p2', urgency: 'warning' as const, items: [] }];
        const merged = mergeIntoGroups(resaleGroups, bomGroups);
        expect(merged).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/finale/bom-demand.test.ts 2>&1 | tail -20`
Expected: FAIL — module `./bom-demand` does not exist.

- [ ] **Step 3: Implement `bom-demand.ts` — pure computation functions**

Create `src/lib/finale/bom-demand.ts`:

```typescript
import { PurchasingGroup, PurchasingItem } from './client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FGVelocity {
    sku: string;
    name: string;
    dailySalesRate: number;
    bom: Array<{ componentSku: string; quantity: number }>;
}

export interface ComponentDemand {
    componentSku: string;
    totalBurnRate: number;
    feedsFinishedGoods: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        qtyPerUnit: number;
    }>;
    /** Compute builds-worth given current stock and a specific FG batch size */
    computeBuildsWorth: (stock: number, batchSize: number) => number;
}

// ── Pure computation ───────────────────────────────────────────────────────

/**
 * Given FG sales velocities and their BOMs, compute per-component burn rates.
 * This is a pure function — no API calls.
 */
export function computeComponentBurnRates(fgVelocities: FGVelocity[]): Map<string, ComponentDemand> {
    const components = new Map<string, ComponentDemand>();

    for (const fg of fgVelocities) {
        for (const comp of fg.bom) {
            const existing = components.get(comp.componentSku);
            const burnContribution = fg.dailySalesRate * comp.quantity;

            if (existing) {
                existing.totalBurnRate += burnContribution;
                existing.feedsFinishedGoods.push({
                    sku: fg.sku,
                    name: fg.name,
                    dailySalesRate: fg.dailySalesRate,
                    qtyPerUnit: comp.quantity,
                });
            } else {
                components.set(comp.componentSku, {
                    componentSku: comp.componentSku,
                    totalBurnRate: burnContribution,
                    feedsFinishedGoods: [{
                        sku: fg.sku,
                        name: fg.name,
                        dailySalesRate: fg.dailySalesRate,
                        qtyPerUnit: comp.quantity,
                    }],
                    computeBuildsWorth: (stock: number, batchSize: number) => {
                        if (batchSize <= 0 || comp.quantity <= 0) return 0;
                        return stock / (comp.quantity * batchSize);
                    },
                });
            }
        }
    }

    return components;
}

/**
 * Classify urgency based on runway days vs lead time.
 * Same tiers as getPurchasingIntelligence.
 */
export function classifyUrgency(runwayDays: number, leadTimeDays: number): 'critical' | 'warning' | 'watch' | 'ok' {
    if (runwayDays < leadTimeDays) return 'critical';
    if (runwayDays < leadTimeDays + 30) return 'warning';
    if (runwayDays < leadTimeDays + 60) return 'watch';
    return 'ok';
}

/**
 * Merge BOM groups into resale groups by vendorPartyId.
 * Same vendor → one group with both item types; urgency = worst of merged.
 */
export function mergeIntoGroups(
    resaleGroups: PurchasingGroup[],
    bomGroups: PurchasingGroup[]
): PurchasingGroup[] {
    const urgencyRank = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
    const merged = new Map<string, PurchasingGroup>();

    for (const g of resaleGroups) {
        merged.set(g.vendorPartyId, { ...g, items: [...g.items] });
    }

    for (const g of bomGroups) {
        const existing = merged.get(g.vendorPartyId);
        if (existing) {
            existing.items.push(...g.items);
            if (urgencyRank[g.urgency] < urgencyRank[existing.urgency]) {
                existing.urgency = g.urgency;
            }
        } else {
            merged.set(g.vendorPartyId, { ...g, items: [...g.items] });
        }
    }

    // Sort: worst urgency first, then alphabetical
    return Array.from(merged.values()).sort((a, b) => {
        const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
        return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/finale/bom-demand.test.ts 2>&1 | tail -20`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/finale/bom-demand.ts src/lib/finale/bom-demand.test.ts
git commit -m "feat(purchasing): BOM demand engine — pure computation functions with tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add `FinaleClient.getBOMDemand()` method

**Files:**
- Modify: `src/lib/finale/client.ts`

This task adds the async pipeline as a public method on `FinaleClient`, alongside the existing `getPurchasingIntelligence()`. Living on the class means it has direct access to `this.apiBase / this.accountPath / this.authHeader / this.get(...)` — no `as any` casts. It calls the public methods promoted in Task 1 and the pure functions written in Task 2.

- [ ] **Step 1: Add the method**

Find a good insertion point near `getPurchasingIntelligence` (grep anchor: `async getPurchasingIntelligence`). Add this method on `FinaleClient`:

```typescript
    /**
     * Demand-driven BOM component purchasing pipeline.
     *
     * 1. Page active SKUs (productViewConnection)
     * 2. For each active SKU: getBillOfMaterials → if non-empty, treat as FG candidate
     * 3. For FG candidates with sales in window: collect (sku, name, dailySalesRate, bom)
     * 4. Explode burn rates per component (computeComponentBurnRates)
     * 5. For each component: REST product GET → stock, supplier; resolve vendor;
     *    leadTimeService.getForVendor(); classify urgency
     * 6. Group by vendor, sort worst-first
     *
     * Returns PurchasingGroup[] where every item has itemType='bom-component'.
     * Caching is the route's responsibility (same pattern as getPurchasingIntelligence).
     *
     * v1 simplification: pages all Active products and BOM-checks each one. Most
     * Active SKUs have no BOM, so this wastes ~1 product GET per non-FG SKU. The
     * 30-min route cache absorbs the cost. v2 should narrow the candidate set
     * via a productAssocList GraphQL filter or a sales-velocity prefilter.
     */
    async getBOMDemand(daysBack = 90): Promise<PurchasingGroup[]> {
        const { computeComponentBurnRates, classifyUrgency, type FGVelocity } =
            await import('./bom-demand');

        // ── Step 1: Page Active SKUs ──
        const PAGE_SIZE = 500;
        let cursor: string | null = null;
        const activeSkus: string[] = [];

        while (true) {
            const afterClause = cursor ? `, after: "${cursor}"` : '';
            const body = {
                query: `{
                    productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                        pageInfo { hasNextPage endCursor }
                        edges { node { productId status } }
                    }
                }`
            };
            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json: any = await res.json();
            const conn = json.data?.productViewConnection;
            if (!conn) break;
            for (const edge of conn.edges || []) {
                if (edge.node.status === 'Active') activeSkus.push(edge.node.productId);
            }
            if (!conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
        }

        // ── Step 2-3: Find FG candidates (have BOM + have sales) ──
        const fgVelocities: FGVelocity[] = [];
        const skuQueue = [...activeSkus];

        await Promise.all(Array.from({ length: 3 }, async () => {
            while (skuQueue.length > 0) {
                const sku = skuQueue.shift()!;
                try {
                    const bom = await this.getBillOfMaterials(sku);
                    if (bom.length === 0) continue; // not an FG

                    const activity = await this.getProductActivity(sku, daysBack);
                    const dailySalesRate = activity.soldQty / daysBack;
                    if (dailySalesRate <= 0) continue; // no demand signal

                    const prodData = await this.get(
                        `/${this.accountPath}/api/product/${encodeURIComponent(sku)}`
                    );
                    const name: string = prodData.internalName || prodData.productId || sku;
                    fgVelocities.push({ sku, name, dailySalesRate, bom });
                } catch (err: any) {
                    console.error(`[bom-demand] FG ${sku} failed:`, err.message);
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        if (fgVelocities.length === 0) return [];

        // ── Step 4: Burn rates ──
        const componentDemands = computeComponentBurnRates(fgVelocities);

        // ── Step 5: Resolve each component (stock, vendor, lead time, urgency) ──
        const { leadTimeService } = await import('@/lib/builds/lead-time-service');
        const items: PurchasingItem[] = [];
        const componentQueue = Array.from(componentDemands.entries());

        await Promise.all(Array.from({ length: 3 }, async () => {
            while (componentQueue.length > 0) {
                const [compSku, demand] = componentQueue.shift()!;
                try {
                    const prodData = await this.get(
                        `/${this.accountPath}/api/product/${encodeURIComponent(compSku)}`
                    );
                    const suppliers: any[] = prodData.supplierList || [];
                    const mainSupplier = suppliers.find((s: any) =>
                        s.supplierPrefOrderId?.includes('MAIN')
                    ) || suppliers[0];
                    if (!mainSupplier?.supplierPartyUrl) continue;

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                    let groupName = 'Unknown';
                    try {
                        const partyRes = await fetch(
                            `${this.apiBase}/${this.accountPath}/api/partygroup/${partyId}`,
                            { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
                        );
                        const partyData = await partyRes.json();
                        groupName = partyData.groupName || partyData.name || 'Unknown';
                    } catch { /* keep Unknown */ }

                    if (EXCLUDED_VENDOR_PATTERN.test(groupName)) continue;

                    const stockOnHand: number =
                        parseFloat(prodData.quantityOnHand ?? prodData.stockLevel ?? '0') || 0;

                    const lt = await leadTimeService.getForVendor(groupName, compSku);
                    const leadTimeDays = lt.days;
                    const leadTimeProvenance = lt.label;

                    const runwayDays = demand.totalBurnRate > 0
                        ? stockOnHand / demand.totalBurnRate
                        : 9999;
                    const urgency = classifyUrgency(runwayDays, leadTimeDays);

                    // buildsWorth approximation: batch ≈ dailySalesRate*30. Phase 2 derives
                    // real batch sizes from production receipt history.
                    const feedsFinishedGoods = demand.feedsFinishedGoods.map(fg => {
                        const batchSize = fg.dailySalesRate * 30;
                        const buildsWorth = batchSize > 0 && fg.qtyPerUnit > 0
                            ? stockOnHand / (fg.qtyPerUnit * batchSize)
                            : 0;
                        return {
                            sku: fg.sku,
                            name: fg.name,
                            dailySalesRate: fg.dailySalesRate,
                            buildsWorth: Math.round(buildsWorth * 10) / 10,
                        };
                    });

                    const coverDays = 60;
                    const suggestedQty = Math.max(
                        0,
                        Math.ceil(demand.totalBurnRate * coverDays - stockOnHand)
                    );

                    items.push({
                        productId: compSku,
                        productName: prodData.internalName || compSku,
                        supplierName: groupName,
                        supplierPartyId: partyId,
                        unitPrice: mainSupplier.unitPrice ?? mainSupplier.price ?? 0,
                        stockOnHand,
                        stockOnOrder: 0, // v2: fetch open POs for components
                        purchaseVelocity: 0,
                        salesVelocity: 0,
                        demandVelocity: demand.totalBurnRate,
                        dailyRate: demand.totalBurnRate,
                        dailyRateSource: 'demand',
                        runwayDays: Math.round(runwayDays * 10) / 10,
                        adjustedRunwayDays: Math.round(runwayDays * 10) / 10,
                        leadTimeDays,
                        leadTimeProvenance,
                        openPOs: [],
                        urgency,
                        explanation:
                            `BOM component — burns ${demand.totalBurnRate.toFixed(1)}/day across ` +
                            `${demand.feedsFinishedGoods.length} FGs. ${Math.round(runwayDays)}d runway.`,
                        suggestedQty,
                        orderIncrementQty: prodData.orderIncrementQuantity ?? null,
                        isBulkDelivery: true, // BOM materials route to production facility
                        finaleReorderQty: null,
                        finaleStockoutDays: null,
                        finaleConsumptionQty: null,
                        finaleDemandQty: null,
                        itemType: 'bom-component',
                        feedsFinishedGoods,
                        totalBurnRate: demand.totalBurnRate,
                    });
                } catch (err: any) {
                    console.error(`[bom-demand] component ${compSku} failed:`, err.message);
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        // ── Step 6: Group by vendor, worst-urgency-first ──
        const urgencyRank = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
        const vendorMap = new Map<string, PurchasingGroup>();
        for (const item of items) {
            const existing = vendorMap.get(item.supplierPartyId);
            if (existing) {
                existing.items.push(item);
                if (urgencyRank[item.urgency] < urgencyRank[existing.urgency]) {
                    existing.urgency = item.urgency;
                }
            } else {
                vendorMap.set(item.supplierPartyId, {
                    vendorName: item.supplierName,
                    vendorPartyId: item.supplierPartyId,
                    urgency: item.urgency,
                    items: [item],
                });
            }
        }
        return Array.from(vendorMap.values()).sort((a, b) => {
            const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
            return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
        });
    }
```

Key differences from a naïve port:
- No `(client as any)` — uses `this.apiBase / this.accountPath / this.authHeader / this.get / this.getBillOfMaterials / this.getProductActivity` directly.
- Lead time comes from `leadTimeService.getForVendor()` — same source as resale path.
- Vendor exclusion uses the shared `EXCLUDED_VENDOR_PATTERN` exported in Task 1 (no inline regex).
- No module cache — that's the route's job.

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck:cli 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator" | head -20
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat(purchasing): FinaleClient.getBOMDemand() — async pipeline

Lives on FinaleClient alongside getPurchasingIntelligence so it shares
auth/state. Pages Active SKUs, BOM-checks each, explodes burn rates,
resolves vendor + lead time per component, groups by vendor.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Wire BOM Demand into API Route

**Files:**
- Modify: `src/app/api/dashboard/purchasing/route.ts`

- [ ] **Step 1: Add BOM cache + mode param handling**

> **assessPurchasingGroups compatibility note**: `shouldSuppressAsNonMoving` checks `salesVelocity || demandVelocity || purchaseVelocity || finaleConsumptionQty || finaleDemandQty || finaleReorderQty || openPOs.length || urgency==critical/warning`. BOM items have `demandVelocity = totalBurnRate > 0`, so they pass the suppression filter unchanged. No assessment-service change is required.

Replace the full content of `src/app/api/dashboard/purchasing/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';

// Module-level caches — full scans take minutes and make hundreds of API calls.
let cache: PurchasingGroup[] | null = null;
let cacheAt = 0;
let bomCache: PurchasingGroup[] | null = null;
let bomCacheAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Scan-in-progress locks: concurrent requests de-duplicate to the same promise.
let cachePromise: Promise<PurchasingGroup[]> | null = null;
let bomCachePromise: Promise<PurchasingGroup[]> | null = null;

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');
    const urgency = req.nextUrl.searchParams.get('urgency');
    const mode = (req.nextUrl.searchParams.get('mode') || 'all') as 'all' | 'resale' | 'bom';
    // ?daysBack=730 for 24-month deep-dive history search; default 365
    const daysBack = Math.min(730, Math.max(30, parseInt(req.nextUrl.searchParams.get('daysBack') ?? '365') || 365));
    // ?bomDaysBack for BOM velocity window (shorter default — 90 days)
    const bomDaysBack = Math.min(365, Math.max(30, parseInt(req.nextUrl.searchParams.get('bomDaysBack') ?? '90') || 90));
    // ?summary=bom&limit=N — lightweight endpoint for build screen card
    const summary = req.nextUrl.searchParams.get('summary');
    const summaryLimit = parseInt(req.nextUrl.searchParams.get('limit') ?? '10') || 10;

    const client = new FinaleClient();

    // ── Resale pipeline (existing) ──
    let resaleGroups: PurchasingGroup[] = [];
    if (mode === 'all' || mode === 'resale') {
        const needsScan = bust || !cache || Date.now() - cacheAt > CACHE_TTL;
        if (needsScan) {
            if (!cachePromise) {
                cachePromise = (async () => {
                    try {
                        cache = await client.getPurchasingIntelligence(daysBack);
                        cacheAt = Date.now();
                        return cache;
                    } catch (err: any) {
                        cache = null;
                        cacheAt = 0;
                        throw err;
                    } finally {
                        cachePromise = null;
                    }
                })();
            }
            try {
                await cachePromise;
            } catch (err: any) {
                return NextResponse.json(
                    { error: err.message },
                    { status: 500, headers: { 'Cache-Control': 'no-store' } }
                );
            }
        }
        resaleGroups = (cache || []).map(g => ({
            ...g,
            items: g.items.map(item => ({ ...item, itemType: item.itemType || 'resale' as const })),
        }));
    }

    // ── BOM pipeline ──
    let bomGroups: PurchasingGroup[] = [];
    if (mode === 'all' || mode === 'bom' || summary === 'bom') {
        const needsBomScan = bust || !bomCache || Date.now() - bomCacheAt > CACHE_TTL;
        if (needsBomScan) {
            if (!bomCachePromise) {
                bomCachePromise = (async () => {
                    try {
                        bomCache = await client.getBOMDemand(bomDaysBack);
                        bomCacheAt = Date.now();
                        return bomCache;
                    } catch (err: any) {
                        console.error('[purchasing/route] BOM demand error:', err.message);
                        bomCache = []; // non-fatal — empty BOM but resale still works
                        bomCacheAt = Date.now();
                        return bomCache;
                    } finally {
                        bomCachePromise = null;
                    }
                })();
            }
            try {
                await bomCachePromise;
            } catch { /* swallowed above */ }
        }
        bomGroups = bomCache || [];
    }

    // ── Summary mode (for build screen card) ──
    if (summary === 'bom') {
        const allBomItems = bomGroups.flatMap(g => g.items)
            .sort((a, b) => a.runwayDays - b.runwayDays)
            .slice(0, summaryLimit);
        return NextResponse.json(
            { items: allBomItems, cachedAt: new Date(bomCacheAt || Date.now()).toISOString() },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    // ── Merge & filter ──
    let groups: PurchasingGroup[];
    if (mode === 'all') {
        groups = mergeIntoGroups(resaleGroups, bomGroups);
    } else if (mode === 'bom') {
        groups = bomGroups;
    } else {
        groups = resaleGroups;
    }

    if (urgency) {
        const allowed = urgency.split(',') as Array<'critical' | 'warning' | 'watch' | 'ok'>;
        groups = groups.filter(g => allowed.includes(g.urgency));
    }

    const assessment = assessPurchasingGroups(groups);
    const responseGroups = assessment.groups.map(group => ({
        vendorName: group.vendorName,
        vendorPartyId: group.vendorPartyId,
        urgency: group.urgency,
        items: group.items.map(line => ({
            ...line.item,
            candidate: line.candidate,
            assessment: line.assessment,
        })),
    }));

    return NextResponse.json(
        {
            groups: responseGroups,
            cachedAt: new Date(cacheAt).toISOString(),
            vendorSummaries: assessment.vendorSummaries,
            mode,
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}

export async function POST(req: NextRequest) {
    try {
        const { vendorPartyId, items, memo, purchaseDestination } = await req.json();

        if (!vendorPartyId || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { error: 'vendorPartyId and non-empty items are required' },
                { status: 400 }
            );
        }

        const client = new FinaleClient();
        const result = await client.createDraftPurchaseOrder(vendorPartyId, items, memo, purchaseDestination);

        // Invalidate both caches so next GET reflects the new PO
        cache = null;
        bomCache = null;

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator" | head -20`
Expected: No errors (or only pre-existing ones).

- [ ] **Step 3: Test manually via curl**

Start dev server (`npm run dev`) and test:
```bash
curl -s "http://localhost:3000/api/dashboard/purchasing?mode=bom&bust=1" | jq '.groups | length'
curl -s "http://localhost:3000/api/dashboard/purchasing?summary=bom&limit=5" | jq '.items | length'
```
Expected: Numeric output (even if 0 on first run — confirms no crash).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/dashboard/purchasing/route.ts
git commit -m "feat(purchasing): wire BOM demand into API route with mode param

?mode=all|resale|bom controls which pipeline runs.
?summary=bom&limit=N for build screen card.
Both caches invalidated on PO creation.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Add Mode Selector to PurchasingPanel

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`

> **Anchor strategy:** the panel is ~1700 lines and shifts often. Don't rely on the line numbers below — use the grep anchors. PurchasingPanel.tsx is large enough that a wrong insertion point will produce silent UI bugs.

- [ ] **Step 1: Add itemMode state and type**

Find the other panel-state declarations (grep anchor: `const [focusFilter, setFocusFilter] = useState`). Add nearby:

```typescript
type ItemMode = 'all' | 'resale' | 'bom';
const [itemMode, setItemMode] = useState<ItemMode>('all');
```

- [ ] **Step 2: Update the `load` function to pass mode**

Find the `load` function inside the component (it builds a URL like `/api/dashboard/purchasing?...`). Update the URL to include the mode param:

```typescript
const url = `/api/dashboard/purchasing?${bust ? 'bust=1&' : ''}mode=${itemMode}`;
```

Also add `itemMode` to the dependency array of the `useEffect` that triggers `load`.

- [ ] **Step 3: Add mode selector UI before the lifecycle tabs**

Find the lifecycle-tabs render block (grep anchor: `Lifecycle bucket counts` or the `URGENCY[g.urgency]` mapping inside the focusGroups render). Insert a new filter row just above the lifecycle tabs and just below the ordering focus buttons (the focus buttons render at grep anchor: `focusFilter === b.k`):

```typescript
{/* ── Item type mode: All / Resale / BOM Materials ── */}
<div className="flex items-center gap-1 px-3 py-1 border-b border-zinc-800/60 bg-zinc-950/30">
    <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider mr-1 shrink-0">type</span>
    {([
        { k: 'all' as const, label: 'All', tone: 'bg-zinc-700 text-zinc-200 border-zinc-500' },
        { k: 'resale' as const, label: 'Resale', tone: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
        { k: 'bom' as const, label: 'BOM Materials', tone: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
    ]).map(t => (
        <button key={t.k}
            onClick={() => setItemMode(t.k)}
            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors shrink-0 ${
                itemMode === t.k ? t.tone : 'text-zinc-500 border-zinc-700 hover:text-zinc-300'
            }`}
        >
            {t.label}
        </button>
    ))}
</div>
```

- [ ] **Step 4: Add BOM badge to item rows**

Find the per-item render block — the row that shows the SKU name and urgency tone. Grep anchor: search for `productName` near a `<span>` rendering inside the per-vendor `items.map(...)` loop. Add a badge next to the SKU name when `item.itemType === 'bom-component'`:

```typescript
{item.itemType === 'bom-component' && (
    <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 ml-1">
        BOM
    </span>
)}
```

- [ ] **Step 5: Add "feeds" line for BOM items**

Below the SKU name/badge, render the feeds context for BOM items. Note "≈" prefix and "builds covered" wording — the buildsWorth math uses `dailySalesRate*30` as a v1 batch-size proxy, so the value is approximate.

```typescript
{item.itemType === 'bom-component' && item.feedsFinishedGoods && item.feedsFinishedGoods.length > 0 && (
    <div className="text-[9px] text-zinc-500 font-mono mt-0.5 truncate">
        feeds: {item.feedsFinishedGoods.slice(0, 2).map(fg =>
            `${fg.name} (≈${fg.buildsWorth} builds covered)`
        ).join(' · ')}
        {item.feedsFinishedGoods.length > 2 && ` · +${item.feedsFinishedGoods.length - 2} more`}
    </div>
)}
```

- [ ] **Step 6: Verify in browser**

Run `npm run dev`, open the dashboard purchasing panel. Toggle between All / Resale / BOM Materials. Confirm:
- Mode buttons render and toggle
- BOM badge appears on BOM items
- "feeds:" line shows below BOM item names
- Existing resale functionality unchanged

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/PurchasingPanel.tsx
git commit -m "feat(purchasing): add item mode selector (All/Resale/BOM) + BOM badges

Mode toggle filters by item type. BOM items show purple badge
and 'feeds: FG1 (X builds) · FG2 (Y builds)' context line.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Build Screen Component Demand Summary Card

**Files:**
- Create: `src/components/dashboard/ComponentDemandCard.tsx`
- Modify: `src/components/dashboard/BuildSchedulePanel.tsx`

- [ ] **Step 1: Create ComponentDemandCard component**

Create `src/components/dashboard/ComponentDemandCard.tsx`:

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Package, ChevronDown, ArrowRight } from 'lucide-react';

interface BOMSummaryItem {
    productId: string;
    productName: string;
    supplierName: string;
    runwayDays: number;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';
    totalBurnRate: number;
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        buildsWorth: number;
    }>;
}

const URGENCY_COLORS = {
    critical: 'text-red-400',
    warning: 'text-amber-400',
    watch: 'text-yellow-400',
    ok: 'text-emerald-400',
} as const;

const URGENCY_BG = {
    critical: 'bg-red-500/15 border-red-500/30',
    warning: 'bg-amber-500/15 border-amber-500/30',
    watch: 'bg-yellow-500/10 border-yellow-500/20',
    ok: 'bg-emerald-500/10 border-emerald-500/20',
} as const;

export default function ComponentDemandCard() {
    const [items, setItems] = useState<BOMSummaryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/dashboard/purchasing?summary=bom&limit=10');
                if (!res.ok) throw new Error('Failed to fetch');
                const data = await res.json();
                setItems(data.items || []);
            } catch (err) {
                console.error('[ComponentDemandCard] fetch error:', err);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    if (loading || items.length === 0) return null;

    const criticalCount = items.filter(i => i.urgency === 'critical').length;
    const warningCount = items.filter(i => i.urgency === 'warning').length;

    return (
        <div className="border-t border-zinc-800/50">
            <button
                onClick={() => setCollapsed(!collapsed)}
                className="w-full px-4 py-2.5 flex items-center justify-between bg-purple-500/5 hover:bg-purple-500/10 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Package className="w-3.5 h-3.5 text-purple-400" />
                    <span className="text-xs font-mono text-purple-300 font-medium">
                        Component Demand
                    </span>
                    {criticalCount > 0 && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">
                            {criticalCount} critical
                        </span>
                    )}
                    {warningCount > 0 && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            {warningCount} warning
                        </span>
                    )}
                </div>
                <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
            </button>

            {!collapsed && (
                <div className="px-4 py-2 space-y-1.5">
                    {items.map(item => (
                        <div key={item.productId}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded border text-xs font-mono ${URGENCY_BG[item.urgency]}`}
                        >
                            <span className={`w-1.5 h-1.5 rounded-full ${
                                item.urgency === 'critical' ? 'bg-red-400' :
                                item.urgency === 'warning' ? 'bg-amber-400' :
                                item.urgency === 'watch' ? 'bg-yellow-400' : 'bg-emerald-400'
                            }`} />
                            <span className="text-zinc-200 truncate flex-1">{item.productName}</span>
                            <span className={`${URGENCY_COLORS[item.urgency]} tabular-nums`}>
                                {Math.round(item.runwayDays)}d
                            </span>
                            {item.feedsFinishedGoods?.[0] && (
                                <span className="text-zinc-500 text-[9px] truncate max-w-[110px]">
                                    ≈{item.feedsFinishedGoods[0].buildsWorth} builds
                                </span>
                            )}
                            <span className="text-zinc-600 text-[9px] truncate max-w-[80px]">
                                {item.supplierName}
                            </span>
                        </div>
                    ))}

                    {/* Dashboard tab/mode aren't query-param driven yet — link to /dashboard
                        and let Will click the Purchasing tab → BOM Materials button.
                        TODO(v2): wire up ?tab= and ?mode= for direct navigation. */}
                    <a href="/dashboard"
                        className="flex items-center gap-1 text-[10px] font-mono text-purple-400 hover:text-purple-300 pt-1 transition-colors"
                    >
                        View all in Purchasing <ArrowRight className="w-2.5 h-2.5" />
                    </a>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Import and render in BuildSchedulePanel**

In `src/components/dashboard/BuildSchedulePanel.tsx`, add the import at the top:

```typescript
import ComponentDemandCard from './ComponentDemandCard';
```

Then render `<ComponentDemandCard />` just before the `BuildDemandSection` (grep anchor: `<BuildDemandSection snapshot={snapshot}` — currently line 448, but use the anchor):

```typescript
<ComponentDemandCard />
<BuildDemandSection snapshot={snapshot} />
```

- [ ] **Step 3: Verify in browser**

Run `npm run dev`, open the dashboard build schedule panel. Confirm:
- Component Demand card renders with purple header
- Shows top components by urgency with runway days and "≈X builds" approx label
- Collapses/expands
- "View all in Purchasing →" link navigates to `/dashboard` (Will manually clicks the Purchasing tab + BOM Materials)
- Returns `null` (hidden) when no BOM data available

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/ComponentDemandCard.tsx src/components/dashboard/BuildSchedulePanel.tsx
git commit -m "feat(builds): add Component Demand summary card to build screen

Read-only card showing top 10 BOM components by urgency.
Links to purchasing panel filtered to BOM mode.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Integration Test & Verify End-to-End

> **Old Task 7 (tagging resale items via getPurchasingIntelligence) was dropped** — Task 4's route already does `item.itemType || 'resale'` on every resale item before serializing, so an explicit tag inside the producer is redundant. If the resale items grow other consumers that need the type, revisit.

**Files:**
- Create: `src/lib/finale/bom-demand.integration.test.ts` (optional, manual verification)

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck:all 2>&1 | grep "error TS" | grep -v "finale/client.ts\|folder-watcher\|validator" | head -20
```
Expected: no output.

- [ ] **Step 2: Run unit tests**

```bash
npx vitest run src/lib/finale/bom-demand.test.ts src/components/dashboard/PurchasingPanel.test.tsx
```
Expected: all pass. Existing PurchasingPanel tests must still pass — the mode toggle and BOM badge are additive.

- [ ] **Step 3: Manual browser verification**

Start `npm run dev` and verify:
1. Purchasing panel → mode toggle visible (All / Resale / BOM Materials)
2. Click "BOM Materials" → shows only BOM components with purple badges
3. Click "Resale" → shows only resale items (no BOM badge)
4. Click "All" → both types merged, vendors with both show combined
5. BOM items show `feeds: Light Mix (≈X builds covered) · ...` line
6. Build screen → Component Demand card visible with urgency-sorted items and `≈X builds` approx label
7. "View all in Purchasing →" navigates to `/dashboard` (manual click into Purchasing tab is expected — no deep-link in v1)
8. Creating a Draft PO still works (same flow). Creating a PO invalidates BOTH caches; next refetch shows updated state.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(purchasing): integration fixes from end-to-end verification

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 2 (Future — not in this plan)

- Suggested quantities rounded to build-batch multiples
- "Feeds" expandable row with full per-FG breakdown
- Vendor group headers showing combined value + item type counts
- Open PO fetching for BOM components (stockOnOrder)
- Build-batch size derived from actual production receipt history (median)
