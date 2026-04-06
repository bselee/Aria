import { describe, expect, it } from "vitest";

import {
  chooseVelocitySignal,
  normalizeFinaleReorderMethod,
  sanitizeFinaleDemandSignals,
  shouldSuppressPurchasingAnomaly,
} from "./client";

describe("normalizeFinaleReorderMethod", () => {
  it("detects do-not-reorder from guideline ids", () => {
    expect(normalizeFinaleReorderMethod({
      reorderGuidelineList: [{ reorderCalculationMethodId: "##doNotReorder" }],
    })).toBe("do_not_reorder");
  });

  it("detects manual method from Finale policy text", () => {
    expect(normalizeFinaleReorderMethod({
      reorderPointPolicy: "manual",
    })).toBe("manual");
  });

  it("detects demand velocity from user-defined text", () => {
    expect(normalizeFinaleReorderMethod({
      userFieldDataList: [{ value: "Demand Velocity" }],
    })).toBe("demand_velocity");
  });

  it("detects sales velocity from guideline ids", () => {
    expect(normalizeFinaleReorderMethod({
      reorderGuidelineList: [{ reorderCalculationMethodId: "##salesVelocity" }],
    })).toBe("sales_velocity");
  });

  it("falls back to default when no explicit method is found", () => {
    expect(normalizeFinaleReorderMethod({})).toBe("default");
  });

  it("treats default with consumption as demand-driven", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 4,
      salesVelocity: 1,
      consumptionQty: 20,
    })).toEqual({ dailyRate: 4, signal: "demand" });
  });

  it("treats manual as sales-first when no explicit demand-driven method is chosen", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "manual",
      demandVelocity: 4,
      salesVelocity: 1,
      consumptionQty: 20,
    })).toEqual({ dailyRate: 1, signal: "sales" });
  });

  it("sanitizes packaged-item demand velocity when Finale demand units conflict with runway", () => {
    expect(sanitizeFinaleDemandSignals({
      stockOnHand: 56,
      stockoutDays: 170,
      demandPerDay: 55.92,
      demandQuantity: 5033,
      consumptionQuantity: 29,
      reorderQuantityToOrder: 4256,
      fallbackReorderQuantity: 4,
    })).toEqual({
      demandVelocity: 29 / 90,
      demandQuantity: 29,
      reorderQuantity: 4,
      usedFallback: true,
    });
  });

  it("preserves normal Finale demand signals when they agree with runway", () => {
    expect(sanitizeFinaleDemandSignals({
      stockOnHand: 120,
      stockoutDays: 30,
      demandPerDay: 4,
      demandQuantity: 360,
      consumptionQuantity: 350,
      reorderQuantityToOrder: 300,
      fallbackReorderQuantity: 12,
    })).toEqual({
      demandVelocity: 4,
      demandQuantity: 360,
      reorderQuantity: 300,
      usedFallback: false,
    });
  });

  it("suppresses dashboard items when the final displayed rate still contradicts Finale runway", () => {
    expect(shouldSuppressPurchasingAnomaly({
      stockOnHand: 56,
      stockoutDays: 170,
      dailyRate: 55.92,
    })).toBe(true);
  });

  it("keeps dashboard items when the displayed rate is aligned with Finale runway", () => {
    expect(shouldSuppressPurchasingAnomaly({
      stockOnHand: 56,
      stockoutDays: 170,
      dailyRate: 29 / 90,
    })).toBe(false);
  });
});
