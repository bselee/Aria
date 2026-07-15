/**
 * @file    crystal-ball-projector.ts
 * @purpose Pure forward-projection calculator for the Crystal Ball feature.
 *          Given current stock, velocity, lead time, and open POs, projects
 *          stock levels at multiple future windows (10/30/60/90/120/180/365d).
 *          Zero I/O — all inputs come from the caller.
 * @author  Aria
 * @created 2026-05-19
 * @updated 2026-05-19
 * @deps    (none — pure arithmetic)
 */

export const PROJECTION_WINDOWS = [10, 30, 60, 90, 120, 180, 365] as const;

export interface ProjectionWindow {
    daysOut: number;
    projectedStock: number;     // stockOnHand + incoming - consumed
    consumed: number;           // dailyRate × daysOut
    incoming: number;           // from open POs expected by this date
    surplus: number;            // projectedStock (negative = deficit)
    needsOrder: boolean;        // surplus < 0
    orderByDate: string | null; // when to place order to cover this window (stockout date - leadTime)
    coveragePct: number;        // how much of demand is covered (0-100+)
}

export interface CrystalBallProjection {
    // Identity
    productId: string;
    productName: string;
    vendorName: string;
    vendorPartyId: string;
    itemType: 'resale' | 'bom-component';
    
    // Current state
    stockOnHand: number;
    stockOnOrder: number;
    dailyRate: number;
    dailyRateSource: string;
    dailyRateLabel: string;
    unitPrice: number;
    salesVelocity: number;
    demandVelocity: number;
    
    // Runway
    runwayDays: number;
    adjustedRunwayDays: number;
    projectedStockoutDate: string | null;
    
    // Lead time
    leadTimeDays: number;
    leadTimeProvenance: string;
    
    // Forward projections
    projections: ProjectionWindow[];
    
    // Open POs
    openPOs: Array<{
        orderId: string;
        quantity: number;
        orderDate: string;
        expectedDate?: string;
        lifecycleStage?: string;
    }>;
    
    // Recommendation context
    recommendation: {
        suggestedQty: number;
        urgency: string;
        coverDays: number;
        provenance: Array<{ step: string; detail: string; value?: number | string }>;
        formulaVersion: string;
    };
    
    // BOM context
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    
    // Historical cadence
    medianPOGapDays?: number;
    projectedNextOrderDate?: string;
    
    // Historical POs from past 3-6 months
    historicalPOs?: Array<{
        orderId: string;
        orderDate: string;
        receiveDate: string | null;
        quantity: number;
        status: string;
    }>;
    
    // Existing active draft PO info to avoid duplicates
    draftPO?: {
        orderId: string;
        orderDate: string;
        quantity: number;
        supplierName: string;
        finaleUrl: string;
    } | null;
    
    // Channel allocation and forward planned demands
    stockAvailable?: number;
    forwardDemandEntry?: {
        requiredQty: number;
        earliestBuildDate: string;
        feedsBuilds: string[];
    };
    // Vendor reliability signal — on-time delivery rate from historical POs (0..1).
    // When < 1.0 the projector discounts stockOnOrder accordingly (same logic as
    // the main purchasing engine) so Crystal Ball projections are not over-optimistic
    // for vendors that frequently deliver late.
    vendorOnTimeRate: number;
}

export interface ProjectionInput {
    stockOnHand: number;
    stockOnOrder: number;
    dailyRate: number;
    leadTimeDays: number;
    openPOs: Array<{
        orderId: string;
        quantity: number;
        orderDate: string;
        expectedDate?: string;
    }>;
}

/**
 * Calculates stock level projections for each milestone window.
 */
export function computeProjections(input: ProjectionInput): ProjectionWindow[] {
    const { stockOnHand, dailyRate, leadTimeDays, openPOs } = input;
    const today = new Date();
    
    return PROJECTION_WINDOWS.map(daysOut => {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + daysOut);
        
        const consumed = dailyRate * daysOut;
        
        // Sum up incoming POs that are expected to arrive before or on this milestone day.
        let incoming = 0;
        for (const po of openPOs) {
            let etaDate: Date;
            if (po.expectedDate) {
                etaDate = new Date(po.expectedDate);
            } else {
                // Fallback: orderDate + leadTime
                etaDate = new Date(po.orderDate);
                etaDate.setDate(etaDate.getDate() + leadTimeDays);
            }
            
            const diffTime = etaDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays <= daysOut) {
                incoming += po.quantity;
            }
        }
        
        const projectedStock = stockOnHand + incoming - consumed;
        const surplus = projectedStock;
        const needsOrder = surplus < 0;
        
        // Find projected stockout date based on burn rate of current stock + any POs arriving before the stockout.
        // We compute this by looking at when stock level goes negative.
        let orderByDate: string | null = null;
        if (needsOrder && dailyRate > 0) {
            // How many days of runway do we have before we run out?
            // Simple model: stockOnHand + incoming arriving before stockout.
            // Let's solve: stockOnHand + incoming(t) - dailyRate * t = 0
            // Since incoming(t) is a step function, we can find t by walking forward.
            let currentStock = stockOnHand;
            let daysUntilStockout = 0;
            
            // Sort POs by their expected arrival days
            const sortedPOs = openPOs.map(po => {
                let etaDate: Date;
                if (po.expectedDate) {
                    etaDate = new Date(po.expectedDate);
                } else {
                    etaDate = new Date(po.orderDate);
                    etaDate.setDate(etaDate.getDate() + leadTimeDays);
                }
                const diffDays = Math.ceil((etaDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                return { qty: po.quantity, days: Math.max(0, diffDays) };
            }).sort((a, b) => a.days - b.days);
            
            let lastDayChecked = 0;
            let ranOut = false;
            
            for (const po of sortedPOs) {
                const daysSegment = po.days - lastDayChecked;
                if (daysSegment > 0) {
                    const burn = dailyRate * daysSegment;
                    if (currentStock >= burn) {
                        currentStock -= burn;
                        lastDayChecked = po.days;
                    } else {
                        // Runs out during this segment
                        daysUntilStockout = lastDayChecked + (currentStock / dailyRate);
                        ranOut = true;
                        break;
                    }
                }
                // Add the PO quantity when its day is reached
                currentStock += po.qty;
            }
            
            if (!ranOut) {
                // If it didn't run out during the open PO segments, it burns down from the final stock level.
                daysUntilStockout = lastDayChecked + (currentStock / dailyRate);
            }
            
            // Order-by date = stockout date minus lead time
            const orderLeadDays = daysUntilStockout - leadTimeDays;
            const orderDateObj = new Date(today);
            orderDateObj.setDate(orderDateObj.getDate() + Math.round(orderLeadDays));
            orderByDate = orderDateObj.toISOString().split('T')[0];
        }
        
        // Coverage percentage is of the milestone demand
        const totalStock = stockOnHand + incoming;
        const coveragePct = consumed > 0 
            ? Math.min(100, Math.round((totalStock / consumed) * 100))
            : 100;
            
        return {
            daysOut,
            projectedStock: Math.round(projectedStock),
            consumed: Math.round(consumed),
            incoming: Math.round(incoming),
            surplus: Math.round(surplus),
            needsOrder,
            orderByDate,
            coveragePct
        };
    });
}

/**
 * Enriches a standard PurchasingItem from the dashboard intelligence payload
 * into a full CrystalBallProjection object.
 */
export function buildCrystalBallProjection(item: any, historicalPOs?: Array<{
    orderId: string;
    orderDate: string;
    receiveDate: string | null;
    quantity: number;
    status: string;
}>): CrystalBallProjection {
    const stockOnHand = item.stockOnHand ?? 0;
    const rawStockOnOrder = item.stockOnOrder ?? 0;
    const dailyRate = item.dailyRate ?? 0;
    const leadTimeDays = item.leadTimeDays ?? 21;
    const openPOs = item.openPOs ?? [];
    // DECISION(2026-05-20): Apply vendor on-time rate discount to stockOnOrder.
    // A 100% on-time vendor passes through at full credit; a vendor that delivers
    // on time 70% of the time only gets 70% credit for open PO supply. Default 1.0
    // (no discount) when the on-time rate has not been computed yet.
    const onTimeRate: number = typeof item.vendorOnTimeRate === 'number' ? Math.min(1, Math.max(0, item.vendorOnTimeRate)) : 1;
    const stockOnOrder = Math.round(rawStockOnOrder * onTimeRate);
    
    // HERMIA(2026-06-12): Use stockAvailable as a ceiling for projection starting stock.
    // When Finale reports stockAvailable (allocatable inventory), use min(stockOnHand, stockAvailable)
    // so 7/14/30/60/90d projections don't overstate supply from inventory that's already
    // committed or reserved for other purposes. Falls back to raw stockOnHand when stockAvailable
    // is not reported (e.g. non-inventory SKUs or legacy products).
    const startingStock = item.stockAvailable !== undefined
        ? Math.min(stockOnHand, item.stockAvailable)
        : stockOnHand;
    
    const projections = computeProjections({
        stockOnHand: startingStock,
        stockOnOrder,
        dailyRate,
        leadTimeDays,
        openPOs
    });
    
    // Estimate a stockout date based on adjusted runway
    let projectedStockoutDate: string | null = null;
    if (dailyRate > 0) {
        const runway = item.adjustedRunwayDays ?? item.runwayDays ?? (stockOnHand / dailyRate);
        if (Number.isFinite(runway)) {
            const stockoutDate = new Date();
            stockoutDate.setDate(stockoutDate.getDate() + Math.round(runway));
            projectedStockoutDate = stockoutDate.toISOString().split('T')[0];
        }
    }
    
    return {
        productId: item.productId,
        productName: item.productName || item.productId,
        vendorName: item.supplierName || 'Unknown Vendor',
        vendorPartyId: item.supplierPartyId || '',
        itemType: item.itemType || 'resale',
        
        stockOnHand,
        stockOnOrder,
        dailyRate,
        dailyRateSource: item.dailyRateSource || 'sales',
        dailyRateLabel: item.dailyRateSource === 'demand' ? 'demand burn' : item.dailyRateSource === 'receipts' ? 'receipt velocity' : 'sales rate',
        unitPrice: item.unitPrice ?? 0,
        salesVelocity: item.salesVelocity ?? 0,
        demandVelocity: item.demandVelocity ?? 0,
        
        runwayDays: item.runwayDays ?? 9999,
        adjustedRunwayDays: item.adjustedRunwayDays ?? 9999,
        projectedStockoutDate,
        
        leadTimeDays,
        leadTimeProvenance: item.leadTimeProvenance || 'default',
        
        projections,
        openPOs,
        
        recommendation: {
            suggestedQty: item.suggestedQty ?? 0,
            urgency: item.urgency ?? 'ok',
            coverDays: item.recommendation?.coverDays ?? 90,
            provenance: item.recommendation?.provenance ?? [],
            formulaVersion: item.recommendation?.formulaVersion || 'v2.3'
        },
        
        feedsFinishedGoods: item.feedsFinishedGoods,
        medianPOGapDays: item.medianPOGapDays,
        projectedNextOrderDate: item.projectedNextOrderDate,
        historicalPOs,
        draftPO: item.draftPO ?? null,
        stockAvailable: item.stockAvailable,
        forwardDemandEntry: item.forwardDemandEntry,
        vendorOnTimeRate: onTimeRate,
    };
}
