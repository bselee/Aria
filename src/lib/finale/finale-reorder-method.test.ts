import { describe, expect, it } from "vitest";

import { chooseVelocitySignal, normalizeFinaleReorderMethod } from "./client";

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
});
