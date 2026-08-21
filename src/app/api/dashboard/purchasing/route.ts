import { createClient } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';
import { resaleSlot, bomSlot, readSWR, invalidatePurchasingCaches } from '@/lib/purchasing/cache';
import { readForwardDemand } from '@/lib/purchasing/forward-demand';
import { assessPOCommitGuard } from '@/lib/purchasing/po-commit-guard';
import { evaluateOpenPoDuplicateGuard } from '@/lib/purchasing/po-duplicate-guard';
import { classifyVendorOrderCycle, mapRecentPOsToVendorCyclePOs } from '@/lib/purchasing/vendor-order-cycle';
import {
    buildRecentOpenCoverageByProduct,
    mergeOpenPOsWithRecentCoverage,
} from '@/lib/purchasing/ordering-po-coverage';
import { DEFAULT_LEAD_TIME_DAYS } from '@/lib/constants';
import { readReconBadges } from '@/lib/purchasing/basauto-recon-lookup';

// Throttle the Supabase invalidation check to protect nano-tier DB (was running on every poll)
let lastInvalidationCheck = 0;
let consecutiveFailures = 0;
const CIRCUIT_BREAKER_THRESHOLD = 2;
const CIRCUIT_BREAKER_RESET_MS = 15 * 60 * 1000; // 15 minutes
let circuitBreakerUntil = 0;
const INVALIDATION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
    // Auto-detect cross-process database PO / receipt changes and invalidate SWR cache
    // Throttled to reduce load on Unhealthy nano Supabase instance
    if (Date.now() - lastInvalidationCheck > INVALIDATION_CHECK_INTERVAL) {
        try {
            const db = createClient();
            if (db && resaleSlot.at > 0) {
                const cacheAt = resaleSlot.at;
                const { data } = await db
                    .from('purchase_orders')
                    .select('updated_at')
                    .order('updated_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                
                if (data?.updated_at) {
                    const lastChange = new Date(data.updated_at).getTime();
                    if (lastChange > cacheAt) {
                        console.log(`[purchasing/route] Database PO change detected (${new Date(lastChange).toISOString()} > cache at ${new Date(cacheAt).toISOString()}). Invalidating SWR cache.`);
                        invalidatePurchasingCaches();
                    }
                }

                // Receipts logged by po-receiving-watcher (bot process) must also bust
                // Ordering need math — open PO qty drops when goods hit Finale stock.
                const { data: receiptRow } = await db
                    .from('ap_activity_log')
                    .select('created_at')
                    .eq('intent', 'PO_RECEIVED')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (receiptRow?.created_at) {
                    const lastReceipt = new Date(receiptRow.created_at).getTime();
                    if (lastReceipt > cacheAt) {
                        console.log(`[purchasing/route] PO_RECEIVED activity after cache (${new Date(lastReceipt).toISOString()}). Invalidating SWR cache.`);
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

    // Fresh recent POs every GET — used to overlay coverage onto stale SWR scans
    // so draft/commit drops SKUs from Ordering immediately (not after 12–15 min rescan).
    let recentPOs: any[] = [];
    try {
        recentPOs = await client.getRecentPurchaseOrders(180, 500);
        (globalThis as any).__aria_recent_pos = { at: Date.now(), pos: recentPOs };
    } catch (err: any) {
        console.error('[purchasing/route] Failed to fetch recent purchase orders:', err.message);
    }

    const recentCoverageByProduct = buildRecentOpenCoverageByProduct(recentPOs);
    const vendorCyclePOs = mapRecentPOsToVendorCyclePOs(recentPOs);
    // Third-opinion join: basauto's own reorder recommendation, read once per
    // request from data/basauto-recon.json. Empty map when the report is
    // missing — rows then degrade to the previous Finale→Aria display.
    const reconBadges = readReconBadges();
    const responseGroups = assessment.groups.map(group => {
        const vendorCycle = classifyVendorOrderCycle({
            vendorPartyId: group.vendorPartyId,
            vendorName: group.vendorName,
            recentPOs: vendorCyclePOs,
        });

        const modifiedItems = group.items.map(line => {
            const productId = line.item.productId;
            const recentCov = recentCoverageByProduct.get(productId);
            const draftHit = recentCov?.draft ?? null;
            const draftPOInfo = draftHit
                ? {
                    orderId: draftHit.orderId,
                    orderDate: draftHit.orderDate,
                    quantity: draftHit.quantity,
                    supplierName: draftHit.vendorName || group.vendorName,
                    finaleUrl: draftHit.finaleUrl,
                }
                : null;

            // Merge GraphQL openPOs with fresh recent-PO hits (committed/locked/sent).
            // After commit, draft overlay alone disappears; without this merge the stale
            // SWR scan still shows "need" until the full 12–15 min rescan lands.
            const mergedOpenPOs = mergeOpenPOsWithRecentCoverage(line.item.openPOs, recentCov);

            const needQty = Math.max(1, line.item.suggestedQty ?? 1);

            // HERMIA(2026-07-08): Draft PO in Finale counts as coverage even though
            // getProductActivity() only returns Committed/Locked as "open".
            const hasDraftCoverage = draftPOInfo != null
                && draftPOInfo.quantity >= needQty;

            // HERMIA(2026-07-10 + 2026-08-06): Open (committed/locked/sent) POs suppress
            // re-order when qty covers suggested need OR policy already held. Recent-PO
            // overlay covers the gap between commit and slow SWR rescan.
            const openPoQty = mergedOpenPOs.reduce(
                (sum: number, po: { quantity?: number }) => sum + Math.max(0, po.quantity || 0),
                0,
            );
            const recentOpenQty = recentCov?.totalQty ?? 0;
            const effectiveOpenQty = Math.max(openPoQty, recentOpenQty);
            const openPoCoversSuggested = effectiveOpenQty >= needQty;
            const policyHeldForOnOrder = (line.assessment?.reasonCodes ?? []).includes('on_order_already_covers_need');
            const hasOpenPoCoverage = !hasDraftCoverage
                && (openPoCoversSuggested || policyHeldForOnOrder)
                && (mergedOpenPOs.length > 0 || recentOpenQty > 0);

            let assessment = line.assessment;
            let urgency = line.item.urgency;
            if (hasDraftCoverage) {
                assessment = {
                    ...line.assessment,
                    decision: 'hold' as const,
                    recommendedQty: 0,
                    reasonCodes: ['recent_draft_exists'] as Array<'recent_draft_exists'>,
                    explanation: `Draft PO #${draftPOInfo!.orderId} already covers this item with ${draftPOInfo!.quantity} units. Review/commit that PO instead of ordering again.`,
                };
                urgency = 'ok' as const;
            } else if (hasOpenPoCoverage) {
                const primaryPo = mergedOpenPOs[0]
                    ?? recentCov?.openHits[0]
                    ?? recentCov?.allHits[0];
                const primaryId = primaryPo?.orderId ?? '?';
                const primaryQty = primaryPo && 'quantity' in primaryPo
                    ? primaryPo.quantity
                    : effectiveOpenQty;
                assessment = {
                    ...line.assessment,
                    decision: 'hold' as const,
                    recommendedQty: 0,
                    reasonCodes: ['on_order_already_covers_need'] as Array<'on_order_already_covers_need'>,
                    explanation: `Already on PO #${primaryId} (qty ${primaryQty}). Not recommending another order unless coverage slips.`,
                };
                urgency = 'ok' as const;
            }

            // When covered by open/draft PO, surface open qty as stockOnOrder.
            // Any hold decision zeros suggested qty so cards never show "order 1000" while holding.
            const covered = hasDraftCoverage || hasOpenPoCoverage;
            const displayOnOrder = covered
                ? Math.max(line.item.stockOnOrder ?? 0, effectiveOpenQty, draftPOInfo?.quantity ?? 0)
                : line.item.stockOnOrder;
            const isHold = assessment.decision === 'hold' || assessment.decision === 'manual_review';
            const displaySuggested = isHold
                ? 0
                : (assessment.recommendedQty > 0 ? assessment.recommendedQty : line.item.suggestedQty);
            // Recompute urgency from runway so CRIT = adj < lead (actionable, not historical floor noise).
            // Use effectiveLeadTimeDays (P90/vendor-override) when available — it's the value
            // the qty recommender actually used to decide whether to order. leadTimeDays alone
            // can understate urgency (Finale says 14d, but P90 says 55d → item should be CRIT).
            const adj = Number.isFinite(line.item.adjustedRunwayDays) ? line.item.adjustedRunwayDays as number : null;
            const rawLead = (line.item as any).effectiveLeadTimeDays ?? line.item.leadTimeDays;
            const lead = Number.isFinite(rawLead) ? (rawLead as number) : DEFAULT_LEAD_TIME_DAYS;
            let displayUrgency: 'critical' | 'warning' | 'watch' | 'ok' = urgency;
            if (isHold) {
                if ((assessment.reasonCodes ?? []).includes('runway_healthy')
                    || (assessment.reasonCodes ?? []).includes('on_order_already_covers_need')
                    || (assessment.reasonCodes ?? []).includes('recent_draft_exists')) {
                    displayUrgency = 'ok';
                } else if ((assessment.reasonCodes ?? []).includes('micro_velocity_noise')) {
                    displayUrgency = 'watch';
                } else {
                    displayUrgency = 'ok';
                }
            } else if (adj !== null) {
                if (adj < lead) displayUrgency = 'critical';
                else if (adj < lead + 30) displayUrgency = 'warning';
                else if (adj < lead + 60) displayUrgency = 'watch';
                else displayUrgency = 'ok';
            }
            return {
                ...line.item,
                openPOs: mergedOpenPOs,
                stockOnOrder: displayOnOrder,
                suggestedQty: displaySuggested,
                candidate: line.candidate,
                assessment,
                commitGuard: assessPOCommitGuard(line),
                draftPO: draftPOInfo,
                urgency: displayUrgency,
                basautoRecon: reconBadges.get(productId.toUpperCase()),
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
        const { vendorPartyId, items, memo, purchaseDestination, ignoreCommitGuards, forceTopUp, skipPreflight } = await req.json();

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
            const cached = (globalThis as any).__aria_recent_pos as { at: number; pos: any[] } | undefined;
            if (cached && Date.now() - cached.at < 10 * 60 * 1000 && Array.isArray(cached.pos) && cached.pos.length > 0) {
                recentPOs = cached.pos;
            } else {
                recentPOs = await client.getRecentPurchaseOrders(45, 500);
            }
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

        // ── Failsafe: open/draft PO already covers SKU ─────────────────────
        // HERMIA(2026-07-10): Independent of ignoreCommitGuards (lead+30/cycle).
        // forceTopUp is the ONLY override for intentional extra quantity.
        // HERMIA(2026-08-06): Include committed/locked/sent from fresh recentPOs,
        // not just drafts — same overlay as GET so post-commit re-order is blocked
        // even while SWR scan is still stale.
        const recentCoverageByProduct = buildRecentOpenCoverageByProduct(recentPOs);
        const guardItems = items.map((item: any) => {
            const productId = String(item.productId);
            const assessed = assessedLines.find(l => l.item.productId === productId);
            const recentCov = recentCoverageByProduct.get(productId);
            const openPOs = mergeOpenPOsWithRecentCoverage(assessed?.item.openPOs ?? [], recentCov);
            const draftHit = recentCov?.draft ?? null;
            const draftPO = draftHit
                ? { orderId: draftHit.orderId, quantity: draftHit.quantity }
                : null;
            return {
                productId,
                quantity: Number(item.quantity) || 0,
                openPOs,
                draftPO,
            };
        });
        const dupGuard = evaluateOpenPoDuplicateGuard(guardItems, { forceTopUp: !!forceTopUp });
        if (!dupGuard.ok) {
            console.warn(`[purchasing/route] POST blocked by open/draft PO guard: ${dupGuard.summary}`);
            return NextResponse.json(
                {
                    error: dupGuard.summary,
                    code: 'OPEN_PO_COVERS_NEED',
                    blocks: dupGuard.blocks,
                    hint: 'Open Purchases for that PO, or pass forceTopUp:true for intentional extra quantity.',
                },
                { status: 409 },
            );
        }
        if (forceTopUp && dupGuard.blocks.length > 0) {
            console.warn(`[purchasing/route] forceTopUp: ${dupGuard.summary}`);
        }

        const result = await client.createDraftPurchaseOrder(vendorPartyId, items, memo, purchaseDestination, { skipPreflight: !!skipPreflight });

        // Coverage overlay on the next GET is enough — do not bust the 12–15 min SWR scan.

        return NextResponse.json({
            ...result,
            duplicateGuard: {
                forceTopUp: !!forceTopUp,
                blocks: dupGuard.blocks,
                summary: dupGuard.summary,
            },
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
