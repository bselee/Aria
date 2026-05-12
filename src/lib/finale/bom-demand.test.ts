import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeComponentBurnRates, classifyUrgency, mergeIntoGroups, chooseBomVelocity, computeReceiptConfidence, computeMedianPOGap, classifyBomUrgency, projectNextOrderDate, applyCommonOrderRounding, computeTrendAdjustedVelocity } from './bom-demand';
import { FinaleClient, __bomComponent404CacheForTests, __skuHasNoBomCacheForTests } from './client';

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

    it('captures qtyPerUnit per FG so callers can compute buildsWorth themselves', () => {
        const fgVelocities = [
            { sku: 'LIGHT-MIX', name: 'Light Mix', dailySalesRate: 10, bom: [{ componentSku: 'PERLITE', quantity: 2 }] },
            { sku: 'CRAFT-LITE', name: 'Craft Lite', dailySalesRate: 5, bom: [{ componentSku: 'PERLITE', quantity: 3 }] },
        ];
        const result = computeComponentBurnRates(fgVelocities);
        const perlite = result.get('PERLITE')!;
        const byFg = new Map(perlite.feedsFinishedGoods.map(fg => [fg.sku, fg.qtyPerUnit]));
        expect(byFg.get('LIGHT-MIX')).toBe(2);
        expect(byFg.get('CRAFT-LITE')).toBe(3);
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

describe('chooseBomVelocity', () => {
    it('prefers receipt velocity when present', () => {
        expect(chooseBomVelocity({ receiptVelocity: 0.42, bomDerivedVelocity: 0.18 }))
            .toEqual({ value: 0.42, source: 'receipts' });
    });
    it('falls back to BOM-derived velocity when receipts are zero', () => {
        expect(chooseBomVelocity({ receiptVelocity: 0, bomDerivedVelocity: 0.18 }))
            .toEqual({ value: 0.18, source: 'demand' });
    });
    it('returns none when both signals are zero', () => {
        expect(chooseBomVelocity({ receiptVelocity: 0, bomDerivedVelocity: 0 }))
            .toEqual({ value: 0, source: 'none' });
    });
});

describe('computeReceiptConfidence', () => {
    it('high when ≥4 POs spread ≥180 days', () => {
        expect(computeReceiptConfidence({
            purchaseCount: 6,
            firstPurchaseDate: '2025-08-01',
            lastPurchaseDate: '2026-05-01',
        })).toBe('high');
    });
    it('medium when 2-3 POs spread ≥90 days', () => {
        expect(computeReceiptConfidence({
            purchaseCount: 3,
            firstPurchaseDate: '2026-01-01',
            lastPurchaseDate: '2026-05-01',
        })).toBe('medium');
    });
    it('low for a single PO', () => {
        expect(computeReceiptConfidence({
            purchaseCount: 1,
            firstPurchaseDate: '2026-03-01',
            lastPurchaseDate: '2026-03-01',
        })).toBe('low');
    });
    it('low when POs cluster within 30 days', () => {
        expect(computeReceiptConfidence({
            purchaseCount: 3,
            firstPurchaseDate: '2026-05-01',
            lastPurchaseDate: '2026-05-20',
        })).toBe('low');
    });
    it('low when dates are missing', () => {
        expect(computeReceiptConfidence({
            purchaseCount: 5,
            firstPurchaseDate: null,
            lastPurchaseDate: null,
        })).toBe('low');
    });
});

describe('computeMedianPOGap', () => {
    it('returns null when fewer than 2 dates', () => {
        expect(computeMedianPOGap([])).toBeNull();
        expect(computeMedianPOGap(['2026-04-01'])).toBeNull();
    });
    it('computes monthly cadence', () => {
        const gap = computeMedianPOGap(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
        // Calendar months have 28-31 days; median of {31, 28, 31} = 31, or of even count averaged
        expect(gap).toBeGreaterThanOrEqual(28);
        expect(gap).toBeLessThanOrEqual(31);
    });
    it('returns the median, not the mean', () => {
        // Gaps: 10, 10, 60 → sorted 10, 10, 60 → median 10
        const gap = computeMedianPOGap(['2026-01-01', '2026-01-11', '2026-01-21', '2026-03-22']);
        expect(gap).toBe(10);
    });
});

describe('classifyBomUrgency', () => {
    it('critical when adjusted runway under lead time', () => {
        expect(classifyBomUrgency({ adjustedRunwayDays: 10, leadTimeDays: 14, medianPOGapDays: 30 }))
            .toBe('critical');
    });
    it('uses cadence as warning threshold when available', () => {
        // 14d lead + 30d cadence = warning cutoff 44d
        expect(classifyBomUrgency({ adjustedRunwayDays: 40, leadTimeDays: 14, medianPOGapDays: 30 }))
            .toBe('warning');
        expect(classifyBomUrgency({ adjustedRunwayDays: 50, leadTimeDays: 14, medianPOGapDays: 30 }))
            .toBe('watch');
    });
    it('uses 2× cadence as watch threshold', () => {
        // 14d + 2×30 = 74d watch cutoff
        expect(classifyBomUrgency({ adjustedRunwayDays: 70, leadTimeDays: 14, medianPOGapDays: 30 }))
            .toBe('watch');
        expect(classifyBomUrgency({ adjustedRunwayDays: 80, leadTimeDays: 14, medianPOGapDays: 30 }))
            .toBe('ok');
    });
    it('falls back to lead+45/+90 when cadence is null', () => {
        expect(classifyBomUrgency({ adjustedRunwayDays: 50, leadTimeDays: 14, medianPOGapDays: null }))
            .toBe('warning'); // <14+45=59
        expect(classifyBomUrgency({ adjustedRunwayDays: 70, leadTimeDays: 14, medianPOGapDays: null }))
            .toBe('watch'); // <14+90=104
    });
});

describe('computeTrendAdjustedVelocity', () => {
    const now = new Date('2026-05-12');
    it('returns full-window rate when prior and recent halves are similar', () => {
        // 100 units over 90d, evenly distributed
        const r = computeTrendAdjustedVelocity({
            purchaseDates: ['2026-03-01', '2026-03-20', '2026-04-10', '2026-05-01'],
            purchaseQtys: [25, 25, 25, 25],
            daysBack: 90,
            now,
        });
        expect(r.trendingUp).toBe(false);
        expect(r.velocity).toBeCloseTo(100 / 90, 5);
    });
    it('flags trending up when recent half ≥1.25× prior half', () => {
        // Prior 45d: 20 units. Recent 45d: 50 units. Ratio 2.5×.
        const r = computeTrendAdjustedVelocity({
            purchaseDates: ['2026-03-01', '2026-04-15', '2026-05-01'],
            purchaseQtys: [20, 25, 25],
            daysBack: 90,
            now,
        });
        expect(r.trendingUp).toBe(true);
        expect(r.recentRate).toBeGreaterThan(r.priorRate);
        // Velocity should be recent rate (50 / 45 ≈ 1.11)
        expect(r.velocity).toBeGreaterThan(20 / 90);
    });
    it('does not flag trend when only recent data exists (no baseline)', () => {
        const r = computeTrendAdjustedVelocity({
            purchaseDates: ['2026-05-01', '2026-05-05'],
            purchaseQtys: [10, 10],
            daysBack: 90,
            now,
        });
        expect(r.trendingUp).toBe(false);
        // Falls back to full-window rate
        expect(r.velocity).toBeCloseTo(20 / 90, 5);
    });
    it('falls back to full rate with too little data', () => {
        const r = computeTrendAdjustedVelocity({
            purchaseDates: ['2026-05-01'],
            purchaseQtys: [42000],
            daysBack: 90,
            now,
        });
        expect(r.velocity).toBeCloseTo(42000 / 90, 5);
        expect(r.trendingUp).toBe(false);
    });
});

describe('applyCommonOrderRounding', () => {
    it('passes through when no history', () => {
        const r = applyCommonOrderRounding({ rawSuggestedQty: 3, purchaseQtys: [] });
        expect(r.suggestedQty).toBe(3);
        expect(r.commonOrderQty).toBeNull();
        expect(r.rationale).toBe('no-history');
    });
    it('snaps up to single historical qty', () => {
        // Raw 3, single past order of 12 → snap to 12
        const r = applyCommonOrderRounding({ rawSuggestedQty: 3, purchaseQtys: [12] });
        expect(r.suggestedQty).toBe(12);
        expect(r.commonOrderQty).toBe(12);
        expect(r.rationale).toBe('single');
    });
    it('snaps up to mode when ≥40% of orders match', () => {
        // Raw 3, mode = 12 (3 of 5 orders) → snap to 12
        const r = applyCommonOrderRounding({ rawSuggestedQty: 3, purchaseQtys: [12, 12, 12, 24, 6] });
        expect(r.suggestedQty).toBe(12);
        expect(r.rationale).toBe('mode');
    });
    it('multiplies the mode when raw need exceeds it', () => {
        // Raw 25, mode 12 → snap up to 36 (3x)
        const r = applyCommonOrderRounding({ rawSuggestedQty: 25, purchaseQtys: [12, 12, 12, 12] });
        expect(r.suggestedQty).toBe(36);
    });
    it('uses median when variance is low and no mode', () => {
        // Qtys: 10, 11, 12, 13 → no mode, mean=11.5, stddev≈1.12, cv≈0.097 → low variance → median 11.5
        const r = applyCommonOrderRounding({ rawSuggestedQty: 5, purchaseQtys: [10, 11, 12, 13] });
        expect(r.rationale).toBe('median');
        expect(r.commonOrderQty).toBe(11.5);
    });
    it('does not round when orders are highly variable', () => {
        // Qtys: 5, 50, 200, 1000 → very high CV → no rounding
        const r = applyCommonOrderRounding({ rawSuggestedQty: 100, purchaseQtys: [5, 50, 200, 1000] });
        expect(r.suggestedQty).toBe(100);
        expect(r.rationale).toBe('variable');
        expect(r.commonOrderQty).toBeNull();
    });
    it('worm-castings truckload: snaps to 42000 mode', () => {
        const r = applyCommonOrderRounding({
            rawSuggestedQty: 35860,
            purchaseQtys: [42000, 42000, 42000, 42000],
        });
        expect(r.suggestedQty).toBe(42000);
        expect(r.commonOrderQty).toBe(42000);
        expect(r.rationale).toBe('mode');
    });
});

describe('projectNextOrderDate', () => {
    it('returns today when runway is already below lead-time threshold', () => {
        const now = new Date('2026-05-12');
        const out = projectNextOrderDate({
            stockOnHand: 10, stockOnOrder: 0, dailyBurn: 5, leadTimeDays: 14, now,
        });
        expect(out).toBe('2026-05-12');
    });
    it('projects future date based on remaining runway after lead-time buffer', () => {
        const now = new Date('2026-05-12');
        // 100 stock @ 1/day = 100d runway, minus 14d lead = order in 86d ≈ 2026-08-06
        const out = projectNextOrderDate({
            stockOnHand: 100, stockOnOrder: 0, dailyBurn: 1, leadTimeDays: 14, now,
        });
        expect(out).toBe('2026-08-06');
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

    it('sorts merged groups worst-urgency-first then alphabetically', () => {
        const merged = mergeIntoGroups(
            [
                { vendorName: 'Zeta', vendorPartyId: 'pZ', urgency: 'critical' as const, items: [] },
                { vendorName: 'Alpha', vendorPartyId: 'pA', urgency: 'ok' as const, items: [] },
            ],
            [
                { vendorName: 'Beta', vendorPartyId: 'pB', urgency: 'critical' as const, items: [] },
            ],
        );
        expect(merged.map(g => g.vendorName)).toEqual(['Beta', 'Zeta', 'Alpha']);
    });

    it('does not mutate input groups', () => {
        const resale = [{
            vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'ok' as const,
            items: [{ productId: 'WIDGET' } as any],
        }];
        const bom = [{
            vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'critical' as const,
            items: [{ productId: 'PERLITE' } as any],
        }];
        mergeIntoGroups(resale, bom);
        expect(resale[0].items).toHaveLength(1);
        expect(resale[0].urgency).toBe('ok');
        expect(bom[0].items).toHaveLength(1);
    });

    it('merges multiple BOM groups feeding the same vendor', () => {
        const merged = mergeIntoGroups(
            [],
            [
                { vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'warning' as const, items: [{ productId: 'A' } as any] },
                { vendorName: 'Acme', vendorPartyId: 'p1', urgency: 'critical' as const, items: [{ productId: 'B' } as any] },
            ],
        );
        expect(merged).toHaveLength(1);
        expect(merged[0].items).toHaveLength(2);
        expect(merged[0].urgency).toBe('critical');
    });
});

describe('getBOMDemand perf optimisations', () => {
    const originalEnv = {
        FINALE_API_KEY: process.env.FINALE_API_KEY,
        FINALE_API_SECRET: process.env.FINALE_API_SECRET,
        FINALE_ACCOUNT_PATH: process.env.FINALE_ACCOUNT_PATH,
        FINALE_BASE_URL: process.env.FINALE_BASE_URL,
    };

    beforeEach(() => {
        process.env.FINALE_API_KEY = 'key';
        process.env.FINALE_API_SECRET = 'secret';
        process.env.FINALE_ACCOUNT_PATH = 'buildasoil';
        process.env.FINALE_BASE_URL = 'https://finale.example';
        __bomComponent404CacheForTests.clear();
        __skuHasNoBomCacheForTests.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        process.env.FINALE_API_KEY = originalEnv.FINALE_API_KEY;
        process.env.FINALE_API_SECRET = originalEnv.FINALE_API_SECRET;
        process.env.FINALE_ACCOUNT_PATH = originalEnv.FINALE_ACCOUNT_PATH;
        process.env.FINALE_BASE_URL = originalEnv.FINALE_BASE_URL;
        __bomComponent404CacheForTests.clear();
        __skuHasNoBomCacheForTests.clear();
    });

    /**
     * Win #1 proof: REST product GET and GraphQL activity for the same component
     * are dispatched in parallel — a slow REST + fast GraphQL must finish in ~max(slow, fast),
     * not slow+fast. Asserts both have started before either has finished.
     */
    it('fetches REST product and GraphQL activity in parallel per component (Win #1)', async () => {
        const client = new FinaleClient();

        // Force exactly one FG with one component via stubbed deps:
        let restCalledAt = 0;
        let activityCalledAt = 0;
        let restResolvedAt = 0;
        let activityResolvedAt = 0;

        // Patch private get() via prototype (TS-private, runtime-accessible).
        const proto = FinaleClient.prototype as any;
        vi.spyOn(proto, 'get').mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('/api/product/COMP1')) {
                restCalledAt = performance.now();
                await new Promise(r => setTimeout(r, 80)); // slow side
                restResolvedAt = performance.now();
                return {
                    productId: 'COMP1',
                    internalName: 'Component 1',
                    supplierList: [{ supplierPartyUrl: '/buildasoil/api/partygroup/V1', unitPrice: 5 }],
                    orderIncrementQuantity: 10,
                };
            }
            if (endpoint.includes('/api/product/FG1')) {
                return { productId: 'FG1', internalName: 'Finished Good' };
            }
            return {};
        });

        vi.spyOn(client, 'getProductActivity').mockImplementation(async (sku: string) => {
            if (sku === 'COMP1') {
                activityCalledAt = performance.now();
                await new Promise(r => setTimeout(r, 10)); // fast side
                activityResolvedAt = performance.now();
                return { stockOnHand: 100, openPOs: [], purchasedQty: 0, soldQty: 0 } as any;
            }
            // FG sales — must be > 0 to qualify as candidate
            return { stockOnHand: 0, openPOs: [], purchasedQty: 0, soldQty: 90 } as any;
        });

        vi.spyOn(client, 'getBillOfMaterials').mockImplementation(async (sku: string) => {
            if (sku === 'FG1') return [{ componentSku: 'COMP1', quantity: 1 } as any];
            return [];
        });

        // productViewConnection paging + partygroup vendor lookup go through global fetch.
        global.fetch = vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes('/api/graphql')) {
                return new Response(JSON.stringify({
                    data: {
                        productViewConnection: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [
                                { node: { productId: 'FG1', status: 'Active' } },
                                { node: { productId: 'COMP1', status: 'Active' } },
                            ],
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('/api/partygroup/V1')) {
                return new Response(JSON.stringify({ groupName: 'Vendor One' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as any;

        // Stub lead-time service to avoid unrelated DB calls.
        const ltModule = await import('@/lib/builds/lead-time-service');
        vi.spyOn(ltModule.leadTimeService, 'getForVendor').mockResolvedValue({
            days: 14,
            label: 'default',
            source: 'default',
        } as any);

        const groups = await client.getBOMDemand(90);

        expect(groups).toHaveLength(1);
        expect(groups[0].items[0].productId).toBe('COMP1');

        // Parallelism check: activity must have *started* before REST *resolved*.
        expect(activityCalledAt).toBeGreaterThan(0);
        expect(restCalledAt).toBeGreaterThan(0);
        expect(activityCalledAt).toBeLessThan(restResolvedAt);
        // Fast side resolves long before slow side (clear evidence of parallel).
        expect(activityResolvedAt).toBeLessThan(restResolvedAt);
    });

    it('excludes inactive and do-not-reorder BOM components from purchasing demand', async () => {
        const client = new FinaleClient();

        const proto = FinaleClient.prototype as any;
        vi.spyOn(proto, 'get').mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('/api/product/COMP-DNR')) {
                return {
                    productId: 'COMP-DNR',
                    internalName: 'Deprecated component',
                    statusId: 'PRODUCT_INACTIVE',
                    userCategory: 'Deprecating',
                    reorderGuidelineList: [
                        { reorderCalculationMethodId: '##doNotReorder' },
                    ],
                    supplierList: [{ supplierPartyUrl: '/buildasoil/api/partygroup/V1', unitPrice: 5 }],
                    orderIncrementQuantity: 1,
                };
            }
            if (endpoint.includes('/api/product/FG1')) {
                return { productId: 'FG1', internalName: 'Finished Good' };
            }
            return {};
        });

        vi.spyOn(client, 'getProductActivity').mockImplementation(async (sku: string) => {
            if (sku === 'COMP-DNR') {
                return { stockOnHand: 0, openPOs: [], purchasedQty: 0, soldQty: 0 } as any;
            }
            return { stockOnHand: 0, openPOs: [], purchasedQty: 0, soldQty: 90 } as any;
        });

        vi.spyOn(client, 'getBillOfMaterials').mockImplementation(async (sku: string) => {
            if (sku === 'FG1') return [{ componentSku: 'COMP-DNR', quantity: 1 } as any];
            return [];
        });

        global.fetch = vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes('/api/graphql')) {
                return new Response(JSON.stringify({
                    data: {
                        productViewConnection: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [{ node: { productId: 'FG1', status: 'Active' } }],
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('/api/partygroup/V1')) {
                return new Response(JSON.stringify({ groupName: 'Vendor One' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as any;

        const ltModule = await import('@/lib/builds/lead-time-service');
        vi.spyOn(ltModule.leadTimeService, 'getForVendor').mockResolvedValue({
            days: 14,
            label: 'default',
            source: 'default',
        } as any);

        const groups = await client.getBOMDemand(90);

        expect(groups).toHaveLength(0);
    });

    /**
     * Win #2 proof: a clean Finale 404 on a component is recorded in the
     * process-lifetime skip set so the next call doesn't waste a fetch.
     * Transient 5xx / network errors must NOT poison the set.
     */
    it('caches clean-404 components and skips them next call (Win #2)', async () => {
        const client = new FinaleClient();

        const proto = FinaleClient.prototype as any;
        const getSpy = vi.spyOn(proto, 'get').mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('/api/product/GHOST')) {
                throw new Error('Finale API 404: Not Found — product GHOST');
            }
            if (endpoint.includes('/api/product/FLAKY')) {
                throw new Error('Finale API 503: Service Unavailable');
            }
            return { productId: 'FG1', internalName: 'FG' };
        });

        vi.spyOn(client, 'getProductActivity').mockImplementation(async (sku: string) => {
            return { stockOnHand: 0, openPOs: [], purchasedQty: 0, soldQty: 90 } as any;
        });

        vi.spyOn(client, 'getBillOfMaterials').mockImplementation(async (sku: string) => {
            if (sku === 'FG1') return [
                { componentSku: 'GHOST', quantity: 1 } as any,
                { componentSku: 'FLAKY', quantity: 1 } as any,
            ];
            return [];
        });

        global.fetch = vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes('/api/graphql')) {
                return new Response(JSON.stringify({
                    data: {
                        productViewConnection: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [{ node: { productId: 'FG1', status: 'Active' } }],
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as any;

        const ltModule = await import('@/lib/builds/lead-time-service');
        vi.spyOn(ltModule.leadTimeService, 'getForVendor').mockResolvedValue({
            days: 14, label: 'default', source: 'default',
        } as any);

        await client.getBOMDemand(90);

        // 404 SKU is now cached; transient-5xx SKU is NOT.
        expect(__bomComponent404CacheForTests.has('GHOST')).toBe(true);
        expect(__bomComponent404CacheForTests.has('FLAKY')).toBe(false);

        // Second pass: GHOST should be skipped before any product GET fires.
        const ghostCallsBefore = getSpy.mock.calls.filter(c => String(c[0]).includes('GHOST')).length;
        await client.getBOMDemand(90);
        const ghostCallsAfter = getSpy.mock.calls.filter(c => String(c[0]).includes('GHOST')).length;
        expect(ghostCallsAfter).toBe(ghostCallsBefore); // no new fetch attempted
    });

    /**
     * Win #3: SKUs that returned no BOM the first time are skipped on second
     * scan, eliminating the bulk of the FG-discovery loop's network calls.
     */
    it('caches no-BOM SKUs and skips getBillOfMaterials next call (Win #3)', async () => {
        const client = new FinaleClient();

        // Two active SKUs. Neither has a BOM. Second scan should issue zero
        // getBillOfMaterials calls for either.
        global.fetch = vi.fn(async (url: any) => {
            const u = String(url);
            if (u.includes('/api/graphql')) {
                return new Response(JSON.stringify({
                    data: {
                        productViewConnection: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            edges: [
                                { node: { productId: 'NO-BOM-A', status: 'Active' } },
                                { node: { productId: 'NO-BOM-B', status: 'Active' } },
                            ],
                        },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as any;

        const bomSpy = vi.spyOn(client, 'getBillOfMaterials').mockResolvedValue([]);

        await client.getBOMDemand(90);
        const callsAfterFirst = bomSpy.mock.calls.length;
        expect(callsAfterFirst).toBe(2); // both SKUs queried first time
        expect(__skuHasNoBomCacheForTests.has('NO-BOM-A')).toBe(true);
        expect(__skuHasNoBomCacheForTests.has('NO-BOM-B')).toBe(true);

        await client.getBOMDemand(90);
        expect(bomSpy.mock.calls.length).toBe(callsAfterFirst); // no new BOM lookups
    });
});
