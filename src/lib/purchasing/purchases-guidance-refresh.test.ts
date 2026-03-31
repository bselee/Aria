import { describe, expect, it, vi } from "vitest";

import { refreshPurchasesGuidanceSnapshot } from "./purchases-guidance-refresh";

describe("refreshPurchasesGuidanceSnapshot", () => {
  it("classifies guidance items, summarizes them, and persists the latest snapshot", async () => {
    const upsertState = vi.fn().mockResolvedValue("basauto-purchases");

    const result = await refreshPurchasesGuidanceSnapshot({
      scrapeGuidance: vi.fn().mockResolvedValue({
        "Sustainable Village": [
          { sku: "BLM201", description: "3mm to Blusoak Tee", urgency: "URGENT" },
          { sku: "MISS1", description: "Missing SKU", urgency: "OVERDUE" },
        ],
      }),
      finaleClient: {
        getPurchasingIntelligenceForSkus: vi.fn().mockResolvedValue([
          {
            vendorName: "Sustainable Village",
            vendorPartyId: "sv",
            urgency: "warning",
            items: [
              {
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
                explanation: "Current demand supports ordering now.",
                suggestedQty: 50,
                orderIncrementQty: null,
                isBulkDelivery: false,
                finaleReorderQty: 50,
                finaleStockoutDays: 20,
                finaleConsumptionQty: 45,
                finaleDemandQty: 45,
              },
            ],
          },
        ]),
        lookupProduct: vi.fn().mockImplementation(async (sku: string) =>
          sku === "MISS1" ? null : ({ productId: sku })),
      } as any,
      upsertState,
    });

    expect(result.status).toBe("success");
    expect(result.summary).toMatchObject({
      totalItems: 2,
      agreesWithPolicy: 1,
      missingInFinale: 1,
    });
    expect(upsertState).toHaveBeenCalledWith(expect.objectContaining({
      status: "success",
      summary: expect.objectContaining({
        totalItems: 2,
        agreesWithPolicy: 1,
        missingInFinale: 1,
      }),
      comparisons: expect.arrayContaining([
        expect.objectContaining({ sku: "BLM201", classification: "agrees_with_policy" }),
        expect.objectContaining({ sku: "MISS1", classification: "missing_in_finale" }),
      ]),
    }));
  });

  it("persists failures so the dashboard can show refresh problems cleanly", async () => {
    const upsertState = vi.fn().mockResolvedValue("basauto-purchases");

    const result = await refreshPurchasesGuidanceSnapshot({
      scrapeGuidance: vi.fn().mockRejectedValue(new Error("CDP endpoint unavailable")),
      finaleClient: {} as any,
      upsertState,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "CDP endpoint unavailable",
    });
    expect(upsertState).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "CDP endpoint unavailable",
    }));
  });
});
