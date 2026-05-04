import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';

// Module-level cache — full scan takes several minutes and makes hundreds of API calls.
let cache: PurchasingGroup[] | null = null;
let cacheAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Scan-in-progress lock: concurrent requests de-duplicate to the same promise.
let cachePromise: Promise<PurchasingGroup[]> | null = null;

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');
    const urgency = req.nextUrl.searchParams.get('urgency');
    // ?daysBack=730 for 24-month deep-dive history search; default 365
    const daysBack = Math.min(730, Math.max(30, parseInt(req.nextUrl.searchParams.get('daysBack') ?? '365') || 365));

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
                    // Clear invalid cache so next request retries
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

    let groups = cache || [];

    // Filter down to requested urgency tier(s). Supports single value or comma-separated.
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
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}

export async function POST(req: NextRequest) {
    // Dashboard click is Will's explicit, manual action — direct create.
    // The approval gate exists for autonomous callers (bot tool, AP worker)
    // via lib/command-board/po-approval-task → requestDraftPOApproval.
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

        // Invalidate cache so next GET reflects the new PO
        cache = null;

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
