import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';
import { resaleSlot, bomSlot, readSWR, invalidatePurchasingCaches } from '@/lib/purchasing/cache';

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
    let refreshing = false;

    // ── Resale pipeline ──
    let resaleGroups: PurchasingGroup[] = [];
    if (mode === 'all' || mode === 'resale') {
        try {
            const r = await readSWR(resaleSlot, () => client.getPurchasingIntelligence(daysBack), bust);
            resaleGroups = r.value.map(g => ({
                ...g,
                items: g.items.map(item => ({ ...item, itemType: item.itemType || 'resale' as const })),
            }));
            refreshing = refreshing || r.refreshing;
        } catch (err: any) {
            return NextResponse.json(
                { error: err.message },
                { status: 500, headers: { 'Cache-Control': 'no-store' } }
            );
        }
    }

    // ── BOM pipeline (non-fatal — errors return empty so resale still works) ──
    let bomGroups: PurchasingGroup[] = [];
    if (mode === 'all' || mode === 'bom' || summary === 'bom') {
        try {
            const r = await readSWR(bomSlot, () => client.getBOMDemand(bomDaysBack), bust);
            bomGroups = r.value;
            refreshing = refreshing || r.refreshing;
        } catch (err: any) {
            console.error('[purchasing/route] BOM demand error:', err.message);
            bomGroups = [];
        }
    }

    // ── Summary mode (for build screen card) ──
    if (summary === 'bom') {
        const allBomItems = bomGroups.flatMap(g => g.items)
            .sort((a, b) => a.runwayDays - b.runwayDays)
            .slice(0, summaryLimit);
        return NextResponse.json(
            { items: allBomItems, cachedAt: new Date(bomSlot.at || Date.now()).toISOString(), refreshing },
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
            cachedAt: new Date(resaleSlot.at || bomSlot.at || Date.now()).toISOString(),
            vendorSummaries: assessment.vendorSummaries,
            mode,
            refreshing,
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

        // Invalidate caches so the next GET shows the new PO. The next read
        // will SWR-refresh in the background — user still gets a fast response.
        invalidatePurchasingCaches();

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
