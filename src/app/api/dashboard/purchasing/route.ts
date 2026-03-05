import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';

// Module-level cache — full scan takes several minutes and makes hundreds of API calls.
let cache: PurchasingGroup[] | null = null;
let cacheAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');
    // ?daysBack=730 for 24-month deep-dive history search; default 365
    const daysBack = Math.min(730, Math.max(30, parseInt(req.nextUrl.searchParams.get('daysBack') ?? '365') || 365));

    if (bust || !cache || Date.now() - cacheAt > CACHE_TTL) {
        try {
            const client = new FinaleClient();
            cache = await client.getPurchasingIntelligence(daysBack);
            cacheAt = Date.now();
        } catch (err: any) {
            return NextResponse.json(
                { error: err.message },
                { status: 500, headers: { 'Cache-Control': 'no-store' } }
            );
        }
    }

    return NextResponse.json(
        { groups: cache, cachedAt: new Date(cacheAt).toISOString() },
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

        // Invalidate cache so next GET reflects the new PO
        cache = null;

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
