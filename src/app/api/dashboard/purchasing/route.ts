import { createClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';
import { resaleSlot, bomSlot, readSWR, invalidatePurchasingCaches } from '@/lib/purchasing/cache';
import { readForwardDemand } from '@/lib/purchasing/forward-demand';
import { assessPOCommitGuard } from '@/lib/purchasing/po-commit-guard';
import { classifyVendorOrderCycle, mapRecentPOsToVendorCyclePOs } from '@/lib/purchasing/vendor-order-cycle';

// Throttle the Supabase invalidation check to protect nano-tier DB (was running on every poll)
let lastInvalidationCheck = 0;
let consecutiveFailures = 0;
const CIRCUIT_BREAKER_THRESHOLD = 2;
const CIRCUIT_BREAKER_RESET_MS = 15 * 60 * 1000; // 15 minutes
let circuitBreakerUntil = 0;
const INVALIDATION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
    // Auto-detect cross-process database PO changes and invalidate SWR cache dynamically
    // Throttled to reduce load on Unhealthy nano Supabase instance
    if (Date.now() - lastInvalidationCheck > INVALIDATION_CHECK_INTERVAL) {
        try {
            const supabase = createClient();
            if (supabase && resaleSlot.at > 0) {
                const { data } = await supabase
                    .from('purchase_orders')
                    .select('updated_at')
                    .order('updated_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                
                if (data?.updated_at) {
                    const lastChange = new Date(data.updated_at).getTime();
                    if (lastChange > resaleSlot.at) {
                        console.log(`[purchasing/route] Database PO change detected (${new Date(lastChange).toISOString()} > cache at ${new Date(resaleSlot.at).toISOString()}). Invalidating SWR cache.`);
                        invalidatePurchasingCaches();
                    }
                }
            }
            lastInvalidationCheck = Date.now();
        } catch (err: any) {
            consecutiveFailures++; if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) { circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS; console.warn('[purchasing/route] Circuit breaker tripped after consecutive failures.'); } console.warn('[purchasing/route] SWR cross-process invalidation check failed:', err.message);
            lastInvalidationCheck = Date.now(); // still advance to avoid hammering on errors
        }
    }


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
            // Resilience fix: fall back to last persisted disk snapshot so the dashboard still loads
            // even when Supabase nano is under heavy load / unhealthy. No user action required.
            consecutiveFailures++; if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) { circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS; console.warn('[purchasing/route] Circuit breaker tripped after consecutive failures.'); } console.warn('[purchasing/route] getPurchasingIntelligence failed, using persisted cache fallback:', err.message);
            try {
                const fs = await import('fs');
                const pathMod = await import('path');
                const cacheDir = process.env.ARIA_PURCHASING_CACHE_DIR || pathMod.join(process.cwd(), '.aria-cache', 'purchasing');
                const file = pathMod.join(cacheDir, 'purchasing-resale.json');
                const raw = fs.readFileSync(file, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed.value)) {
                    resaleGroups = parsed.value.map((g: any) => ({
                        ...g,
                        items: g.items.map((item: any) => ({ ...item, itemType: item.itemType || 'resale' as const })),
                    }));
                    refreshing = true;
                } else {
                    throw new Error('no valid persisted value');
                }
            } catch (fallbackErr: any) {
                console.warn('[purchasing/route] Resale disk fallback also failed:', fallbackErr?.message || fallbackErr);
                return NextResponse.json(
                    { error: err.message },
                    { status: 500, headers: { 'Cache-Control': 'no-store' } }
                );
            }
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
            // Fall back to persisted disk snapshot so BOM data still loads
            // even when Supabase nano is unhealthy. Non-fatal — resale still works.
            try {
                const fs = await import('fs');
                const pathMod = await import('path');
                const cacheDir = process.env.ARIA_PURCHASING_CACHE_DIR || pathMod.join(process.cwd(), '.aria-cache', 'purchasing');
                const file = pathMod.join(cacheDir, 'purchasing-bom.json');
                if (fs.existsSync(file)) {
                    const raw = fs.readFileSync(file, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed.value)) {
                        bomGroups = parsed.value;
                        refreshing = true;
                    }
                }
            } catch {
                // silent — BOM is non-fatal, resale pipeline continues without it
            }
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

    if (groups.length === 0) {
        return NextResponse.json(
            {
                groups: [],
                cachedAt: new Date(resaleSlot.at || bomSlot.at || Date.now()).toISOString(),
                vendorSummaries: { totalSuggestedValue: 0, criticalCount: 0, warningCount: 0, watchCount: 0, okCount: 0 },
                mode,
                refreshing,
                upcomingBuilds: [],
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
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
        });

        const modifiedItems = group.items.map(line => {
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

            // HERMIA(2026-07-08): A Draft PO already in Finale counts as coverage
            // even though getProductActivity() filters it out (only Committed/Locked
            // are "open" POs). Override urgency + assessment so the item doesn't
            // appear as "needs ordering" when a draft with sufficient qty exists.
            const hasDraftCoverage = draftPOInfo != null
                && draftPOInfo.quantity >= Math.max(1, line.item.suggestedQty ?? 1);

            return {
                ...line.item,
                candidate: line.candidate,
                assessment: hasDraftCoverage ? {
                    ...line.assessment,
                    decision: 'hold' as const,
                    recommendedQty: 0,
                    reasonCodes: ['recent_draft_exists'] as Array<'recent_draft_exists'>,
                    explanation: `Draft PO #${draftPOInfo!.orderId} already covers this item with ${draftPOInfo!.quantity} units.`,
                } : line.assessment,
                commitGuard: assessPOCommitGuard(line),
                draftPO: draftPOInfo,
                urgency: hasDraftCoverage ? ('ok' as const) : line.item.urgency,
            };
        });

        // Recalculate group urgency from modified items so a group whose items
        // are all covered by draft POs doesn't keep showing a stale critical badge.
        const worstUrgency = (): 'critical' | 'warning' | 'watch' | 'ok' => {
            const rank: Record<string, number> = { critical: 4, warning: 3, watch: 2, ok: 1 };
            let worst: 'critical' | 'warning' | 'watch' | 'ok' = 'ok';
            for (const item of modifiedItems) {
                if ((rank[item.urgency] ?? 0) > (rank[worst] ?? 0)) worst = item.urgency;
            }
            return worst;
        };

        return {
            vendorName: group.vendorName,
            vendorPartyId: group.vendorPartyId,
            urgency: worstUrgency(),
            vendorCycle,
            items: modifiedItems,
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
        const { vendorPartyId, items, memo, purchaseDestination, ignoreCommitGuards } = await req.json();

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
        if (!ignoreCommitGuards) {
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
        // HERMIA(2026-05-28): Honor ignoreCommitGuards for vendor cycle too.
        // Without this the dashboard can show a "Force Draft" prompt but the
        // API still rejects the call when vendor is already in a routine PO.
        if (vendorCycle.decision === 'routine_locked' && !ignoreCommitGuards) {
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
