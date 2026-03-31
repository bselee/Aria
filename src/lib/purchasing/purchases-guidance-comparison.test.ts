import { describe, expect, it } from "vitest";
import { comparePurchasesGuidanceItem } from "@/lib/purchasing/purchases-guidance-comparison";
import type { AssessedPurchasingLine } from "@/lib/purchasing/assessment-service";

function buildAssessedLine(
  overrides: Partial<AssessedPurchasingLine["assessment"]> = {},
): AssessedPurchasingLine {
  return {
    item: {
      productId: "BLM201",
      productName: "3mm to Blusoak Tee",
      supplierName: "Sustainable Village",
      supplierPartyId: "sv",
      unitPrice: 2.43,
      stockOnHand: 10,
      stockOnOrder: 0,
      purchaseVelocity: 0.5,
      salesVelocity: 0.5,
      demandVelocity: 0.5,
      dailyRate: 0.5,
      runwayDays: 20,
      adjustedRunwayDays: 20,
      leadTimeDays: 14,
      leadTimeProvenance: "14d (Finale)",
      openPOs: [],
      urgency: "warning",
      explanation: "Shared policy example",
      suggestedQty: 50,
      orderIncrementQty: null,
      isBulkDelivery: false,
      finaleReorderQty: 50,
      finaleStockoutDays: 20,
      finaleConsumptionQty: 45,
      finaleDemandQty: 45,
    },
    candidate: {
      vendorName: "Sustainable Village",
      vendorPartyId: "sv",
      productId: "BLM201",
      productName: "3mm to Blusoak Tee",
      directDemand: 0.5,
      bomDemand: 0,
      stockOnHand: 10,
      stockOnOrder: overrides.reasonCodes?.includes("on_order_already_covers_need") ? 50 : 0,
      adjustedRunwayDays: 20,
      finishedGoodsCoverageDays: null,
      leadTimeDays: 14,
      suggestedQty: 50,
      orderIncrementQty: null,
      minimumOrderQty: null,
      minimumOrderValue: null,
      unitPrice: 2.43,
      explanation: "Shared policy example",
      sourceUrgency: "warning",
      openPOs: overrides.reasonCodes?.includes("on_order_already_covers_need")
        ? [{ orderId: "PO1", quantity: 50, orderDate: "2026-03-30" }]
        : [],
      leadTimeProvenance: "14d (Finale)",
      finaleDemandQty: 45,
      finaleConsumptionQty: 45,
      isBulkDelivery: false,
    },
    assessment: {
      vendorName: "Sustainable Village",
      productId: "BLM201",
      decision: "order",
      recommendedQty: 50,
      confidence: "high",
      reasonCodes: ["direct_demand_support"],
      explanation: "Current demand supports ordering now.",
      metrics: {
        directDemand: 0.5,
        bomDemand: 0,
        sharedDemand: 0.5,
        stockOnHand: 10,
        stockOnOrder: 0,
        adjustedRunwayDays: 20,
        finishedGoodsCoverageDays: null,
        leadTimeDays: 14,
      },
      ...overrides,
    },
  };
}

describe("comparePurchasesGuidanceItem", () => {
  const guidanceItem = {
    sku: "BLM201",
    description: "3mm to Blusoak Tee",
    urgency: "URGENT",
  };

  it("classifies missing Finale items", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem,
      assessedLine: null,
      finaleProduct: null,
    });

    expect(result.classification).toBe("missing_in_finale");
  });

  it("classifies already-on-order items", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem,
      assessedLine: buildAssessedLine({
        decision: "hold",
        reasonCodes: ["on_order_already_covers_need"],
        explanation: "Existing open PO covers the need.",
      }),
      finaleProduct: { productId: "BLM201" } as any,
    });

    expect(result.classification).toBe("already_on_order");
  });

  it("classifies guidance overstating need", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem,
      assessedLine: buildAssessedLine({
        decision: "hold",
        reasonCodes: ["fg_coverage_sufficient"],
        explanation: "Finished goods already have healthy coverage.",
      }),
      finaleProduct: { productId: "BLM201" } as any,
    });

    expect(result.classification).toBe("guidance_overstates_need");
  });

  it("classifies guidance understating need", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem: { ...guidanceItem, urgency: "OK" },
      assessedLine: buildAssessedLine(),
      finaleProduct: { productId: "BLM201" } as any,
    });

    expect(result.classification).toBe("guidance_understates_need");
  });

  it("classifies ambiguous policy results as manual review", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem,
      assessedLine: buildAssessedLine({
        decision: "manual_review",
        confidence: "medium",
        reasonCodes: ["pack_size_forced_overbuy"],
        explanation: "Pack size forces material overbuy.",
      }),
      finaleProduct: { productId: "BLM201" } as any,
    });

    expect(result.classification).toBe("needs_manual_review");
  });

  it("classifies aligned guidance and policy", () => {
    const result = comparePurchasesGuidanceItem({
      vendorName: "Sustainable Village",
      guidanceItem,
      assessedLine: buildAssessedLine(),
      finaleProduct: { productId: "BLM201" } as any,
    });

    expect(result.classification).toBe("agrees_with_policy");
  });
});
