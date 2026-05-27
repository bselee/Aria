import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';
import { resaleSlot, bomSlot, readSWR, invalidatePurchasingCaches } from '@/lib/purchasing/cache';
import { readForwardDemand } from '@/lib/purchasing/forward-demand';
import { assessPOCommitGuard } from '@/lib/purchasing/po-commit-guard';
import { classifyVendorOrderCycle, mapRecentPOsToVendorCyclePOs } from '@/lib/purchasing/vendor-order-cycle';

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

    // Fetch recent POs from the past 180 days (6 months) to detect duplicate drafts
    let recentPOs: any[] = [];
    try {
        recentPOs = await client.getRecentPurchaseOrders(180, 500);
    } catch (err: any) {
        console.error('[purchasing/route] Failed to fetch recent purchase orders:', err.message);
    }

    const isDraftPO = (po: any): boolean => {
        const status = (po.status || '').toLowerCase();
        return status.includes('draft') || status.includes('created') || status === 'order_created';
    };

    const vendorCyclePOs = mapRecentPOsToVendorCyclePOs(recentPOs);
    const responseGroups = assessment.groups.map(group => {
        const vendorCycle = classifyVendorOrderCycle({
            vendorPartyId: group.vendorPartyId,
            vendorName: group.vendorName,
            recentPOs: vendorCyclePOs,
            requestedLines: group.items,
        });

        return {
            vendorName: group.vendorName,
            vendorPartyId: group.vendorPartyId,
            urgency: group.urgency,
            vendorCycle,
            items: group.items.map(line => {
            const matchingDraftPO = recentPOs.find(po => 
                isDraftPO(po) && 
                po.items?.some((i: any) => i.productId === line.item.productId)
            );
            let draftPOInfo = null;
            if (matchingDraftPO) {
                const poLine = matchingDraftPO.items.find((i: any) => i.productId === line.item.productId);
                draftPOInfo = {
                    orderId: matchingDraftPO.orderId,
                    orderDate: matchingDraftPO.orderDate,
                    quantity: poLine ? poLine.quantity : 0,
                    supplierName: matchingDraftPO.vendorName || group.vendorName,
                    finaleUrl: matchingDraftPO.finaleUrl,
                };
            }

            return {
                ...line.item,
                candidate: line.candidate,
                assessment: line.assessment,
                commitGuard: assessPOCommitGuard(line),
                draftPO: draftPOInfo,
            };
        }),
        };
    });

    // ── Upcoming-builds digest (next 30 days from calendar forward-demand) ──
    // Compact list for the header panel. Same data the morning Telegram pulls.
    const forwardMap = readForwardDemand(30);
    const buildSet = new Map<string, { earliestDate: string; componentCount: number }>();
    for (const entry of forwardMap.values()) {
        for (const fg of entry.feedsBuilds) {
            const existing = buildSet.get(fg);
            if (existing) {
                existing.componentCount += 1;
                if (entry.earliestBuildDate < existing.earliestDate) existing.earliestDate = entry.earliestBuildDate;
            } else {
                buildSet.set(fg, { earliestDate: entry.earliestBuildDate, componentCount: 1 });
            }
        }
    }
    const upcomingBuilds = Array.from(buildSet.entries())
        .map(([sku, info]) => ({ sku, earliestDate: info.earliestDate, componentCount: info.componentCount }))
        .sort((a, b) => a.earliestDate.localeCompare(b.earliestDate))
        .slice(0, 12);

    return NextResponse.json(
        {
            groups: responseGroups,
            cachedAt: new Date(resaleSlot.at || bomSlot.at || Date.now()).toISOString(),
            vendorSummaries: assessment.vendorSummaries,
            mode,
            refreshing,
            upcomingBuilds,
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
        const cachedGroups = (resaleSlot.value || bomSlot.value)
            ? mergeIntoGroups(resaleSlot.value ?? [], bomSlot.value ?? [])
            : null;
        let groups = cachedGroups ?? await client.getPurchasingIntelligence(365);
        let vendorGroup = groups.find(group => group.vendorPartyId === vendorPartyId);
        if (!vendorGroup && cachedGroups) {
            groups = await client.getPurchasingIntelligence(365);
            vendorGroup = groups.find(group => group.vendorPartyId === vendorPartyId);
        }
        if (!vendorGroup) {
            return NextResponse.json(
                { error: `No current purchasing intelligence found for vendor ${vendorPartyId}` },
                { status: 409 },
            );
        }

        const assessment = assessPurchasingGroups([vendorGroup]);
        const assessedLines = assessment.groups[0]?.items ?? [];
        const requestedBySku = new Map<string, any>(
            items.map((item: any) => [String(item.productId), item]),
        );
        const requestedLines = assessedLines
            .filter(line => requestedBySku.has(line.item.productId))
            .map(line => {
                const requested = requestedBySku.get(line.item.productId);
                return {
                    ...line,
                    item: {
                        ...line.item,
                        suggestedQty: requested.quantity,
                    },
                    candidate: {
                        ...line.candidate,
                        suggestedQty: requested.quantity,
                    },
                    assessment: {
                        ...line.assessment,
                        recommendedQty: requested.quantity,
                    },
                };
            });
        const guards = requestedLines.map(line => assessPOCommitGuard(line));
        const missingSkus = items
            .map((item: any) => String(item.productId))
            .filter((sku: string) => !guards.some(guard => guard.productId === sku));
        const nonCommitGuards = guards.filter(guard => guard.decision !== 'commit');
        if (missingSkus.length > 0 || nonCommitGuards.length > 0) {
            return NextResponse.json(
                {
                    error: 'Draft blocked: requested lines must satisfy lead time plus 30 days before autonomous PO creation.',
                    missingSkus,
                    guards,
                },
                { status: 409 },
            );
        }

        let recentPOs: any[] = [];
        try {
            recentPOs = await client.getRecentPurchaseOrders(45, 500);
        } catch (err: any) {
            console.error('[purchasing/route] Failed to fetch recent purchase orders for vendor cycle:', err.message);
        }
        const vendorCycle = classifyVendorOrderCycle({
            vendorPartyId,
            vendorName: vendorGroup.vendorName,
            recentPOs: mapRecentPOsToVendorCyclePOs(recentPOs),
            requestedLines,
        });
        if (vendorCycle.decision === 'routine_locked') {
            return NextResponse.json(
                {
                    error: vendorCycle.summary,
                    vendorCycle,
                    guards,
                },
                { status: 409 },
            );
        }

        const result = await client.createDraftPurchaseOrder(vendorPartyId, items, memo, purchaseDestination);

        // Invalidate caches so the next GET shows the new PO. The next read
        // will SWR-refresh in the background — user still gets a fast response.
        invalidatePurchasingCaches();

        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
