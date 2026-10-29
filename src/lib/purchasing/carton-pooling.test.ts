/**
 * @file carton-pooling.test.ts
 * @purpose Prove the same carton size is judged on pooled stock, not per SKU.
 * @author Hermia
 * @created 2026-10-22
 * @deps vitest, ./carton-pooling
 */

import { describe, expect, it } from "vitest";
import type { PurchasingGroup, PurchasingItem } from "../finale/client";
import { boxDimKey, poolCartonGroups } from "./carton-pooling";

/** Minimal item shaped for the pooling math. */
function item(over: Partial<PurchasingItem> & { productId: string }): PurchasingItem {
  return {
    productName: "",
    supplierName: "",
    supplierPartyId: "",
    unitPrice: 1,
    stockOnHand: 0,
    stockOnOrder: 0,
    purchaseVelocity: 0,
    salesVelocity: 0,
    demandVelocity: 0,
    dailyRate: 0,
    runwayDays: 0,
    adjustedRunwayDays: 0,
    leadTimeDays: 5,
    leadTimeProvenance: "test",
    openPOs: [],
    urgency: "critical",
    explanation: "",
    suggestedQty: 0,
    orderIncrementQty: null,
    isBulkDelivery: false,
    finaleReorderQty: null,
    finaleStockoutDays: null,
    finaleConsumptionQty: null,
    finaleDemandQty: null,
    ...over,
  } as PurchasingItem;
}

function group(items: PurchasingItem[]): PurchasingGroup {
  return { vendorName: "ULINE", vendorPartyId: "10083", urgency: "critical", items } as PurchasingGroup;
}

describe("poolCartonGroups", () => {
  it("normalizes orientation so the same carton groups together", () => {
    expect(boxDimKey('Corrugated Boxes - (30"x15"x15") /15')).toBe("15x15x30");
    expect(boxDimKey('Corrugated Boxes - (15"x15"x30") /15')).toBe("15x15x30");
    expect(boxDimKey("Coconut Water Powder - (20kilo Box - 44lb) Raw")).toBeNull();
  });

  it("does not order a carton another vendor SKU already covers", async () => {
    // Live case: ULS455 read 0 on hand and drove a 1,500 order while S-4412
    // (310) and BOX118 (45) held the same 30x15x15 carton.
    const groups = [
      group([
        item({
          productId: "ULS455",
          productName: 'Corrugated Boxes - (30"x15"x15") /15',
          stockOnHand: 0,
          dailyRate: 4.5,
          adjustedRunwayDays: 0,
          suggestedQty: 1500,
          leadTimeDays: 5,
        }),
      ]),
    ];

    const stock: Record<string, number> = { "S-4412": 310, BOX118: 45, BOX117: 0 };
    const out = await poolCartonGroups(groups, {
      cartonNames: [
        { sku: "ULS455", name: 'Corrugated Boxes - (30"x15"x15") /15' },
        { sku: "S-4412", name: 'Corrugated Boxes - (15"x15"x30") /15' },
        { sku: "BOX118", name: '30"x15"x15" Box Build - 15/Unit' },
        { sku: "BOX117", name: '15"x15"x30" Box Build - 15/Unit' },
      ],
      stockFor: async (sku) => stock[sku] ?? null,
    });

    const pooled = out.groups[0].items[0];
    expect(pooled.stockOnHand).toBe(0);
    expect(pooled.adjustedRunwayDays).toBeCloseTo(355 / 4.5, 5);
    expect(pooled.suggestedQty).toBe(0);
    expect(pooled.urgency).toBe("ok");
    expect(pooled.explanation).toContain("Pooled");
    expect(out.pooled[0].onHand).toBe(355);
    expect(out.pooled[0].covered).toBe(true);
  });

  it("keeps the quantity when the pooled size is still short", async () => {
    const groups = [
      group([
        item({
          productId: "S-4796",
          productName: 'Corrugated Boxes - (22"x14"x6") /20',
          stockOnHand: 100,
          dailyRate: 50,
          adjustedRunwayDays: 2,
          suggestedQty: 900,
          leadTimeDays: 21,
        }),
      ]),
    ];

    const out = await poolCartonGroups(groups, {
      cartonNames: [{ sku: "S-4796", name: 'Corrugated Boxes - (22"x14"x6") /20' }],
      stockFor: async () => 0,
    });

    const pooled = out.groups[0].items[0];
    expect(pooled.adjustedRunwayDays).toBeCloseTo(2, 5);
    expect(pooled.suggestedQty).toBe(900);
    expect(pooled.urgency).toBe("critical");
    expect(out.pooled[0].covered).toBe(false);
  });

  it("leaves non-carton items alone", async () => {
    const groups = [
      group([
        item({
          productId: "AG108",
          productName: "Agsil16H Potassium Silicate 50lb",
          stockOnHand: 0,
          dailyRate: 1,
          suggestedQty: 10,
        }),
      ]),
    ];

    const out = await poolCartonGroups(groups, {
      cartonNames: [{ sku: "AG108", name: "Agsil16H Potassium Silicate 50lb" }],
      stockFor: async () => 500,
    });

    expect(out.groups[0].items[0].suggestedQty).toBe(10);
    expect(out.pooled).toEqual([]);
  });
});
