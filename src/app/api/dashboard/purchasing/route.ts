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
