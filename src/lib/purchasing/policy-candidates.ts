import type { PurchasingItem } from "../finale/client";
import type { PurchasingCandidateInput } from "./policy-engine";

export interface PurchasingCandidate extends PurchasingCandidateInput {
    vendorPartyId: string;
    productName: string;
    explanation: string;
    sourceUrgency: PurchasingItem["urgency"];
    openPOs: PurchasingItem["openPOs"];
    leadTimeProvenance: string;
    finaleDemandQty: number | null;
    finaleConsumptionQty: number | null;
    isBulkDelivery: boolean;
    reorderMethod?: PurchasingItem["reorderMethod"];
}

export interface PurchasingCandidateContext {
    directDemand?: number;
    bomDemand?: number;
    finishedGoodsCoverageDays?: number | null;
    minimumOrderQty?: number | null;
    minimumOrderValue?: number | null;
    /** True when vendor is cycle-locked — suppress all orders. */
    vendorCycleLocked?: boolean;
}

export function buildPurchasingCandidate(
    item: PurchasingItem,
    context: PurchasingCandidateContext = {},
): PurchasingCandidate {
    const knownDemand = Math.max(item.demandVelocity, 0);
    const directDemand = context.directDemand ?? (knownDemand > 0 ? knownDemand : Math.max(item.salesVelocity, 0));
    const bomDemand = context.bomDemand ?? Math.max(knownDemand - directDemand, 0);

    // KAIZEN(2026-08-04): Trust the recommender's corrected stockOnOrder.
    // Previously Math.max() with openPoQty overrode the correction, so
    // delivered POs still inflated stockOnOrder in the policy engine.
    // The recommender already credits all open (non-delivered) PO quantities
    // via coverageStockOnOrder — double-counting here causes false HOLDs.
    const openPoQty = (item.openPOs ?? []).reduce((sum, po) => sum + Math.max(0, po.quantity || 0), 0);
    const stockOnOrder = Math.max(item.stockOnOrder ?? 0, 0);
    const dailyForRunway = Math.max(item.dailyRate ?? 0, directDemand + bomDemand, 0.0001);
    const stockOnHand = item.stockOnHand ?? 0;
    let adjustedRunwayDays: number | null = Number.isFinite(item.adjustedRunwayDays)
        ? item.adjustedRunwayDays
        : null;
    if (openPoQty > (item.stockOnOrder ?? 0)) {
        // Recompute runway from the higher on-order signal so coverage holds work.
        adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyForRunway;
    } else if (adjustedRunwayDays === null && stockOnOrder > 0) {
        adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyForRunway;
    }

    return {
        vendorName: item.supplierName,
        vendorPartyId: item.supplierPartyId,
        productId: item.productId,
        productName: item.productName,
        directDemand,
        bomDemand,
        stockOnHand,
        stockOnOrder,
        adjustedRunwayDays,
        finishedGoodsCoverageDays: context.finishedGoodsCoverageDays ?? null,
        leadTimeDays: Number.isFinite(item.effectiveLeadTimeDays ?? item.leadTimeDays)
            ? (item.effectiveLeadTimeDays ?? item.leadTimeDays)
            : null,
        suggestedQty: item.suggestedQty,
        orderIncrementQty: item.orderIncrementQty,
        minimumOrderQty: context.minimumOrderQty ?? item.orderIncrementQty ?? null,
        minimumOrderValue: context.minimumOrderValue ?? null,
        unitPrice: item.unitPrice,
        explanation: item.explanation,
        sourceUrgency: item.urgency,
        openPOs: item.openPOs,
        leadTimeProvenance: item.leadTimeProvenance,
        finaleDemandQty: item.finaleDemandQty,
        finaleConsumptionQty: item.finaleConsumptionQty,
        isBulkDelivery: item.isBulkDelivery,
        reorderMethod: item.reorderMethod ?? "default",
        vendorCycleLocked: context.vendorCycleLocked ?? false,
    };
}
