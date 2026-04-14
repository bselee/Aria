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
}

export function buildPurchasingCandidate(
    item: PurchasingItem,
    context: PurchasingCandidateContext = {},
): PurchasingCandidate {
    // FIX(2026-04-14): When Finale tracks demandVelocity (direct sales + BOM consumption),
    // use it as the primary direct demand signal. Only fall back to salesVelocity when
    // demandVelocity is untracked (0). Previously always used salesVelocity, which missed
    // demand that Finale captured in demandVelocity (e.g., direct customer orders).
    const knownDemand = Math.max(item.demandVelocity, 0);
    const directDemand = context.directDemand ?? (knownDemand > 0 ? knownDemand : Math.max(item.salesVelocity, 0));
    const bomDemand = context.bomDemand ?? Math.max(knownDemand - directDemand, 0);

    return {
        vendorName: item.supplierName,
        vendorPartyId: item.supplierPartyId,
        productId: item.productId,
        productName: item.productName,
        directDemand,
        bomDemand,
        stockOnHand: item.stockOnHand,
        stockOnOrder: item.stockOnOrder,
        adjustedRunwayDays: Number.isFinite(item.adjustedRunwayDays) ? item.adjustedRunwayDays : null,
        finishedGoodsCoverageDays: context.finishedGoodsCoverageDays ?? null,
        leadTimeDays: Number.isFinite(item.leadTimeDays) ? item.leadTimeDays : null,
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
    };
}
