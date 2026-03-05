import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, ExternalReorderGroup } from '@/lib/finale/client';

// Module-level cache — reused across requests within the same server process.
// The full scan takes ~30–60s and makes hundreds of API calls; caching is essential.
let cache: ExternalReorderGroup[] | null = null;
let cacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');

    if (bust || !cache || Date.now() - cacheAt > CACHE_TTL) {
        try {
            const client = new FinaleClient();
            cache = await client.getExternalReorderItems();
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

        // Invalidate cache so the next GET reflects the new PO in the assessment
        cache = null;

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
