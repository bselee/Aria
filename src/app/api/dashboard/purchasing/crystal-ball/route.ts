/**
 * @file    route.ts
 * @purpose Crystal Ball — SKU/vendor search with forward-looking stock projections.
 *          Reuses the existing SWR-cached purchasing data (no additional Finale calls).
 * @author  Aria
 * @created 2026-05-19
 * @updated 2026-05-19
 * @deps    purchasing/cache, purchasing/crystal-ball-projector, finale/client
 */

import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient, PurchasingGroup } from '@/lib/finale/client';
import { assessPurchasingGroups } from '@/lib/purchasing/assessment-service';
import { mergeIntoGroups } from '@/lib/finale/bom-demand';
import { resaleSlot, bomSlot, readSWR } from '@/lib/purchasing/cache';
import { buildCrystalBallProjection } from '@/lib/purchasing/crystal-ball-projector';

export async function GET(req: NextRequest) {
    const q = req.nextUrl.searchParams.get('q');
    if (!q || q.trim().length < 2) {
        return NextResponse.json(
            { error: 'Query parameter "q" is required and must be at least 2 characters long.' },
            { status: 400 }
        );
    }
    
    const query = q.trim().toLowerCase();
    const client = new FinaleClient();
    
    // We want to fetch both resale and BOM pipelines using standard SWR to stay perfectly fast.
    let resaleGroups: PurchasingGroup[] = [];
    let bomGroups: PurchasingGroup[] = [];
    let refreshing = false;
    
    try {
        // Read resale
        const r = await readSWR(resaleSlot, () => client.getPurchasingIntelligence(365), false);
        resaleGroups = r.value.map(g => ({
            ...g,
            items: g.items.map(item => ({ ...item, itemType: item.itemType || 'resale' as const })),
        }));
        refreshing = refreshing || r.refreshing;
        
        // Read BOM
        const b = await readSWR(bomSlot, () => client.getBOMDemand(90), false);
        bomGroups = b.value;
        refreshing = refreshing || b.refreshing;
    } catch (err: any) {
        console.error('[crystal-ball-route] Failed to read SWR caches:', err.message);
    }
    
    // Merge resale and BOM groups
    const allGroups = mergeIntoGroups(resaleGroups, bomGroups);
    
    // Let's run assessment-service on the groups so we get correct assessment decision, explanation, reasons, etc.
    const assessed = assessPurchasingGroups(allGroups);
    
    // Fetch historical POs from the past 180 days (6 months) to detect duplicate drafts
    let recentPOs: any[] = [];
    try {
        recentPOs = await client.getRecentPurchaseOrders(180, 500);
    } catch (err: any) {
        console.error('[crystal-ball-route] Failed to fetch recent purchase orders:', err.message);
    }

    const isDraftPO = (po: any): boolean => {
        const status = (po.status || '').toLowerCase();
        return status.includes('draft') || status.includes('created') || status === 'order_created';
    };

    // Flatten all items across all groups to perform a fast search
    const matchedItems: any[] = [];
    
    for (const group of assessed.groups) {
        for (const assessedLine of group.items) {
            const item = assessedLine.item;
            const itemVendorName = group.vendorName || '';
            
            const productId = (item.productId || '').toLowerCase();
            const productName = (item.productName || '').toLowerCase();
            const vendorName = itemVendorName.toLowerCase();
            const supplierPartyId = (group.vendorPartyId || '').toLowerCase();
            
            // Match against product ID, product name, or vendor/supplier name
            if (
                productId.includes(query) ||
                productName.includes(query) ||
                vendorName.includes(query) ||
                supplierPartyId.includes(query)
            ) {
                const matchingDraftPO = recentPOs.find(po => 
                    isDraftPO(po) && 
                    po.items?.some((i: any) => i.productId === item.productId)
                );
                let draftPOInfo = null;
                if (matchingDraftPO) {
                    const poLine = matchingDraftPO.items.find((i: any) => i.productId === item.productId);
                    draftPOInfo = {
                        orderId: matchingDraftPO.orderId,
                        orderDate: matchingDraftPO.orderDate,
                        quantity: poLine ? poLine.quantity : 0,
                        supplierName: matchingDraftPO.vendorName || group.vendorName,
                        finaleUrl: matchingDraftPO.finaleUrl,
                    };
                }

                // Enrich items with their context from the assessment and the group.
                // DECISION(2026-05-20): Include vendorOnTimeRate so buildCrystalBallProjection
                // can discount open-PO credit the same way the main purchasing engine does.
                const enrichedItem = {
                    ...item,
                    supplierName: group.vendorName,
                    supplierPartyId: group.vendorPartyId,
                    candidate: assessedLine.candidate,
                    assessment: assessedLine.assessment,
                    urgency: item.urgency || assessedLine.candidate?.urgency || 'ok',
                    draftPO: draftPOInfo,
                    vendorOnTimeRate: client.getVendorOnTimeRate(group.vendorName),
                };
                matchedItems.push(enrichedItem);
            }
        }
    }
    
    // Convert all matched items into CrystalBallProjection objects
    const results = matchedItems.map(item => {
        // Filter historical POs containing this item and map to target shape
        const matchedHistory = recentPOs
            .filter(po => po.items?.some((i: any) => i.productId === item.productId))
            .map(po => {
                const lineItem = po.items.find((i: any) => i.productId === item.productId);
                return {
                    orderId: po.orderId,
                    orderDate: po.orderDate,
                    receiveDate: po.receiveDate || null,
                    quantity: lineItem ? lineItem.quantity : 0,
                    status: po.status
                };
            });
            
        return buildCrystalBallProjection(item, matchedHistory);
    });
    
    // Sort results by runwayDays ascending (most urgent first)
    results.sort((a, b) => {
        const aRunway = a.runwayDays ?? 9999;
        const bRunway = b.runwayDays ?? 9999;
        return aRunway - bRunway;
    });
    
    // Limit to 25 items to prevent blowing up the UI
    const truncatedResults = results.slice(0, 25);
    
    return NextResponse.json({
        query: q,
        results: truncatedResults,
        cachedAt: new Date(resaleSlot.at || bomSlot.at || Date.now()).toISOString(),
        refreshing,
        resultCount: results.length
    }, {
        headers: { 'Cache-Control': 'no-store' }
    });
}
