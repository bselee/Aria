# BOM Demand Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add demand-driven BOM component purchasing to the existing purchasing panel — items tagged by type, filterable by mode, with build-batch context for BOM materials.

**Architecture:** New `getBOMDemand()` function in `client.ts` computes component burn rates from FG shipment velocity × BOM explosion. API route merges BOM items with existing resale items. UI adds a mode toggle and enriches BOM rows with "feeds" context.

**Tech Stack:** TypeScript, Next.js API routes, React (PurchasingPanel), Finale REST + GraphQL APIs, vitest for tests.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/finale/bom-demand.ts` | `getBOMDemand()` pipeline — FG velocity, BOM explosion, component stock/runway, vendor grouping |
| Create | `src/lib/finale/bom-demand.test.ts` | Unit tests for burn rate math, urgency classification, vendor merging |
| Modify | `src/lib/finale/client.ts:119-185` | Extend `PurchasingItem` and `PurchasingGroup` with `itemType` + `feedsFinishedGoods` fields |
| Modify | `src/app/api/dashboard/purchasing/route.ts` | Add `?mode=` param, run BOM pipeline, merge vendor groups |
| Modify | `src/components/dashboard/PurchasingPanel.tsx` | Mode selector toggle, BOM badge, "feeds" expandable row |
| Create | `src/components/dashboard/ComponentDemandCard.tsx` | Read-only build-screen summary card (top N components by urgency) |
| Modify | `src/components/dashboard/BuildSchedulePanel.tsx` | Slot `ComponentDemandCard` into panel |

---

### Task 1: Extend PurchasingItem Interface

**Files:**
- Modify: `src/lib/finale/client.ts:119-185`

- [ ] **Step 1: Add `itemType` and `feedsFinishedGoods` to PurchasingItem**

In `src/lib/finale/client.ts`, add these fields to the `PurchasingItem` interface (after the `recommendation` field, around line 177):

```typescript
    /** v3 — BOM demand engine: classifies item as resale or BOM component */
    itemType?: 'resale' | 'bom-component';
    /** v3 — which finished goods consume this component, with demand context */
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    /** v3 — total daily burn rate summed across all FG consumers (BOM items only) */
    totalBurnRate?: number;
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc --noEmit -p tsconfig.cli.json 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator" | head -20`
Expected: No new errors (existing items don't require the new optional fields).

- [ ] **Step 3: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat(purchasing): extend PurchasingItem with itemType + feedsFinishedGoods fields

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Implement `getBOMDemand()` Core Pipeline

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

### Task 3: Implement `getBOMDemand()` Finale Integration

**Files:**
- Modify: `src/lib/finale/bom-demand.ts`

This task adds the async function that calls Finale APIs (FG shipments, BOM fetch, stock lookup, vendor resolution) and assembles `PurchasingGroup[]` with `itemType: 'bom-component'`.

- [ ] **Step 1: Add `getBOMDemand()` async function**

Append to `src/lib/finale/bom-demand.ts`:

```typescript
import { FinaleClient } from './client';
import type { LeadTimeService } from '@/lib/builds/lead-time-service';

// ── Module-level BOM demand cache ──────────────────────────────────────────
let _bomCache: PurchasingGroup[] | null = null;
let _bomCacheAt = 0;
const BOM_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export function clearBOMCache() {
    _bomCache = null;
    _bomCacheAt = 0;
}

export function getBOMCacheAge(): number {
    return _bomCacheAt ? Date.now() - _bomCacheAt : Infinity;
}

/**
 * Demand-driven BOM component purchasing pipeline.
 *
 * 1. Find manufactured FGs with recent sales velocity
 * 2. Explode their BOMs to leaf components
 * 3. Compute per-component burn rate and runway
 * 4. Resolve vendors, classify urgency, group
 *
 * Returns PurchasingGroup[] where every item has itemType='bom-component'.
 */
export async function getBOMDemand(
    daysBack = 90,
    options?: { bust?: boolean }
): Promise<PurchasingGroup[]> {
    if (!options?.bust && _bomCache && Date.now() - _bomCacheAt < BOM_CACHE_TTL) {
        return _bomCache;
    }

    const client = new FinaleClient();
    const accountPath = (client as any).accountPath as string;
    const apiBase = (client as any).apiBase as string;
    const authHeader = (client as any).authHeader as string;

    // ── Step 1: Find manufactured FGs with sales in the window ──
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const beginDate = cutoff.toLocaleDateString('en-CA'); // YYYY-MM-DD
    const endDate = new Date().toLocaleDateString('en-CA');

    // Page all active products, collect those with isManufactured = true
    const PAGE_SIZE = 500;
    let cursor: string | null = null;
    const manufacturedSkus: string[] = [];

    while (true) {
        const afterClause = cursor ? `, after: "${cursor}"` : '';
        const query = {
            query: `{
                productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                    pageInfo { hasNextPage endCursor }
                    edges { node { productId status } }
                }
            }`
        };
        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
        const json: any = await res.json();
        const conn = json.data?.productViewConnection;
        if (!conn) break;

        for (const edge of conn.edges || []) {
            if (edge.node.status === 'Active') {
                manufacturedSkus.push(edge.node.productId);
            }
        }
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }

    // Filter to manufactured products (have BOM) — 3 concurrent workers
    const fgVelocities: FGVelocity[] = [];
    const skuQueue = [...manufacturedSkus];
    const bomCache = new Map<string, Array<{ componentSku: string; quantity: number }>>();

    await Promise.all(Array.from({ length: 3 }, async () => {
        while (skuQueue.length > 0) {
            const sku = skuQueue.shift()!;
            try {
                const bom = await client.getBillOfMaterials(sku);
                if (bom.length === 0) continue; // Not manufactured — no BOM

                bomCache.set(sku, bom);

                // Get FG shipment velocity (sales orders completed in window)
                const activity = await (client as any).getProductActivity(sku, daysBack);
                const dailySalesRate = activity.soldQty / daysBack;
                if (dailySalesRate <= 0) continue; // No sales = no demand signal

                const prodData = await (client as any).get(`/${accountPath}/api/product/${encodeURIComponent(sku)}`);
                const name: string = prodData.internalName || prodData.productId || sku;

                fgVelocities.push({ sku, name, dailySalesRate, bom });
            } catch (err: any) {
                console.error(`[bom-demand] Error processing FG ${sku}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 100)); // Rate limit
        }
    }));

    if (fgVelocities.length === 0) {
        _bomCache = [];
        _bomCacheAt = Date.now();
        return [];
    }

    // ── Step 2: Compute component burn rates ──
    const componentDemands = computeComponentBurnRates(fgVelocities);

    // ── Step 3: For each component, get stock + vendor + lead time ──
    const items: PurchasingItem[] = [];
    const componentQueue = Array.from(componentDemands.entries());

    await Promise.all(Array.from({ length: 3 }, async () => {
        while (componentQueue.length > 0) {
            const [compSku, demand] = componentQueue.shift()!;
            try {
                const prodData = await (client as any).get(`/${accountPath}/api/product/${encodeURIComponent(compSku)}`);
                const suppliers: any[] = prodData.supplierList || [];
                const mainSupplier = suppliers.find((s: any) => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
                if (!mainSupplier?.supplierPartyUrl) continue;

                // Resolve vendor (uses shared cache)
                const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                let groupName = 'Unknown';
                try {
                    const partyRes = await fetch(`${apiBase}/${accountPath}/api/partygroup/${partyId}`, {
                        headers: { Authorization: authHeader, Accept: 'application/json' },
                    });
                    const partyData = await partyRes.json();
                    groupName = partyData.groupName || partyData.name || 'Unknown';
                } catch { /* use Unknown */ }

                // Skip if this component's vendor is also manufactured/dropship
                if (/buildasoil|manufacturing|soil dept|bas soil/i.test(groupName)) continue;
                if (/autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i.test(groupName)) continue;

                const stockOnHand: number = parseFloat(prodData.quantityOnHand ?? prodData.stockLevel ?? '0') || 0;
                const leadTimeDays = parseInt(String(prodData.leadTime ?? ''), 10) || 14;
                const runwayDays = demand.totalBurnRate > 0 ? stockOnHand / demand.totalBurnRate : 9999;
                const urgency = classifyUrgency(runwayDays, leadTimeDays);

                // Compute buildsWorth per FG (use median batch = dailySalesRate * 30 as proxy)
                const feedsFinishedGoods = demand.feedsFinishedGoods.map(fg => {
                    const batchSize = fg.dailySalesRate * 30; // 30 days of sales as typical build
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

                // Suggested qty: cover 60 days of burn
                const coverDays = 60;
                const suggestedQty = Math.max(0, Math.ceil(demand.totalBurnRate * coverDays - stockOnHand));

                items.push({
                    productId: compSku,
                    productName: prodData.internalName || compSku,
                    supplierName: groupName,
                    supplierPartyId: partyId,
                    unitPrice: mainSupplier.price ?? 0,
                    stockOnHand,
                    stockOnOrder: 0, // TODO: could fetch open POs for components
                    purchaseVelocity: 0,
                    salesVelocity: 0,
                    demandVelocity: demand.totalBurnRate,
                    dailyRate: demand.totalBurnRate,
                    dailyRateSource: 'demand',
                    runwayDays: Math.round(runwayDays * 10) / 10,
                    adjustedRunwayDays: Math.round(runwayDays * 10) / 10,
                    leadTimeDays,
                    leadTimeProvenance: parseInt(String(prodData.leadTime ?? ''), 10) > 0
                        ? `${prodData.leadTime}d (Finale)` : '14d default',
                    openPOs: [],
                    urgency,
                    explanation: `BOM component — burns ${demand.totalBurnRate.toFixed(1)}/day across ${demand.feedsFinishedGoods.length} FGs. ${Math.round(runwayDays)}d runway.`,
                    suggestedQty,
                    orderIncrementQty: prodData.orderIncrementQuantity ?? null,
                    isBulkDelivery: true, // BOM materials go to production facility
                    finaleReorderQty: null,
                    finaleStockoutDays: null,
                    finaleConsumptionQty: null,
                    finaleDemandQty: null,
                    itemType: 'bom-component',
                    feedsFinishedGoods,
                    totalBurnRate: demand.totalBurnRate,
                });
            } catch (err: any) {
                console.error(`[bom-demand] Error resolving component ${compSku}:`, err.message);
            }
            await new Promise(r => setTimeout(r, 100));
        }
    }));

    // ── Step 4: Group by vendor ──
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

    const groups = Array.from(vendorMap.values()).sort((a, b) => {
        const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
        return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
    });

    _bomCache = groups;
    _bomCacheAt = Date.now();
    return groups;
}
```

- [ ] **Step 2: Update imports at top of file**

Ensure the import from `./client` at the top includes all needed types:

```typescript
import { FinaleClient, PurchasingGroup, PurchasingItem } from './client';
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.cli.json 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator" | head -20`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/finale/bom-demand.ts
git commit -m "feat(purchasing): getBOMDemand() — full Finale integration pipeline

Fetches manufactured FG sales velocity, explodes BOMs, computes
component burn rates, resolves vendors, classifies urgency.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Wire BOM Demand into API Route

**Files:**
- Modify: `src/app/api/dashboard/purchasing/route.ts`

- [ ] **Step 1: Add BOM cache + mode param handling**

Replace the full content of `src/app/api/dashboard/purchasing/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { getBOMDemand, clearBOMCache, mergeIntoGroups, getBOMCacheAge } from '@/lib/finale/bom-demand';

// Module-level cache — full scan takes several minutes and makes hundreds of API calls.
let cache: PurchasingGroup[] | null = null;
let cacheAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Scan-in-progress lock: concurrent requests de-duplicate to the same promise.
let cachePromise: Promise<PurchasingGroup[]> | null = null;

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

    // ── Resale pipeline (existing) ──
    let resaleGroups: PurchasingGroup[] = [];
    if (mode === 'all' || mode === 'resale') {
        const needsScan = bust || !cache || Date.now() - cacheAt > CACHE_TTL;
        if (needsScan) {
            if (!cachePromise) {
                cachePromise = (async () => {
                    try {
                        const client = new FinaleClient();
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
    if (mode === 'all' || mode === 'bom') {
        try {
            bomGroups = await getBOMDemand(bomDaysBack, { bust });
        } catch (err: any) {
            console.error('[purchasing/route] BOM demand error:', err.message);
            // Non-fatal: return resale data even if BOM fails
        }
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

    // ── Summary mode (for build screen card) ──
    if (summary === 'bom') {
        const allBomItems = bomGroups.flatMap(g => g.items)
            .sort((a, b) => a.runwayDays - b.runwayDays)
            .slice(0, summaryLimit);
        const bomAge = getBOMCacheAge();
        return NextResponse.json(
            { items: allBomItems, cachedAt: new Date(Date.now() - bomAge).toISOString() },
            { headers: { 'Cache-Control': 'no-store' } }
        );
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
        clearBOMCache();

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

- [ ] **Step 1: Add itemMode state and type**

Near the top of the component (after existing state declarations around line 216), add:

```typescript
type ItemMode = 'all' | 'resale' | 'bom';
const [itemMode, setItemMode] = useState<ItemMode>('all');
```

- [ ] **Step 2: Update the `load` function to pass mode**

Find the existing `load` function (fetches from `/api/dashboard/purchasing`). Update the URL to include the mode param:

```typescript
const url = `/api/dashboard/purchasing?${bust ? 'bust=1&' : ''}mode=${itemMode}`;
```

Also add `itemMode` to the dependency array of the `useEffect` that triggers `load`.

- [ ] **Step 3: Add mode selector UI before the lifecycle tabs**

Insert a new filter row just above the lifecycle tabs section (around line 1019). Add between the ordering focus buttons and the lifecycle tabs:

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

In the item row rendering section, add a badge next to the SKU name when `item.itemType === 'bom-component'`:

```typescript
{item.itemType === 'bom-component' && (
    <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 ml-1">
        BOM
    </span>
)}
```

- [ ] **Step 5: Add "feeds" line for BOM items**

Below the SKU name/badge, render the feeds context for BOM items:

```typescript
{item.itemType === 'bom-component' && item.feedsFinishedGoods && item.feedsFinishedGoods.length > 0 && (
    <div className="text-[9px] text-zinc-500 font-mono mt-0.5 truncate">
        feeds: {item.feedsFinishedGoods.slice(0, 2).map(fg =>
            `${fg.name} (${fg.buildsWorth} builds)`
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
                                <span className="text-zinc-500 text-[9px] truncate max-w-[100px]">
                                    {item.feedsFinishedGoods[0].buildsWorth} builds
                                </span>
                            )}
                            <span className="text-zinc-600 text-[9px] truncate max-w-[80px]">
                                {item.supplierName}
                            </span>
                        </div>
                    ))}

                    <a href="/dashboard?tab=purchasing&mode=bom"
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

Then render `<ComponentDemandCard />` just before the `BuildDemandSection` (around line 447):

```typescript
<ComponentDemandCard />
```

- [ ] **Step 3: Verify in browser**

Run `npm run dev`, open the dashboard build schedule panel. Confirm:
- Component Demand card renders with purple header
- Shows top components by urgency with runway days
- Collapses/expands
- "View all in Purchasing →" link works
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

### Task 7: Tag Existing Resale Items

**Files:**
- Modify: `src/lib/finale/client.ts` (inside `getPurchasingIntelligence`)

- [ ] **Step 1: Add `itemType: 'resale'` to item construction**

In `getPurchasingIntelligence()`, find where `PurchasingItem` objects are constructed (around line 4980-5080 where all the fields are assembled into the item object). Add `itemType: 'resale' as const` to the item literal:

```typescript
itemType: 'resale' as const,
```

This ensures the API always returns a typed item regardless of whether the BOM pipeline runs.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit -p tsconfig.cli.json 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator" | head -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/finale/client.ts
git commit -m "feat(purchasing): tag existing items as itemType='resale'

Ensures consistent typing across both pipelines.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Integration Test & Verify End-to-End

**Files:**
- Create: `src/lib/finale/bom-demand.integration.test.ts` (optional, manual verification)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck:all 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator" | head -20`
Expected: Clean (no new errors).

- [ ] **Step 2: Run unit tests**

Run: `npx vitest run src/lib/finale/bom-demand.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Manual browser verification**

Start `npm run dev` and verify:
1. Purchasing panel → mode toggle visible (All / Resale / BOM Materials)
2. Click "BOM Materials" → shows only BOM components with purple badges
3. Click "Resale" → shows only resale items (no BOM badge)
4. Click "All" → both types merged, vendors with both show combined
5. BOM items show "feeds: Light Mix (X builds) · ..." line
6. Build screen → Component Demand card visible with urgency-sorted items
7. "View all in Purchasing →" navigates correctly
8. Creating a Draft PO still works (same flow)

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
