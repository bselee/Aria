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
      salesVelocity: 2,
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

  it("returns receipts signal + purchaseVelocity when demand=0, sales=0, consumption > 0, purchaseVelocity > 0", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0,
      salesVelocity: 0,
      purchaseVelocity: 5,
      consumptionQty: 20,
    })).toEqual({ dailyRate: 5, signal: "receipts" });
  });

  it("does not fall back to receipts when purchaseVelocity is not provided", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0,
      salesVelocity: 0,
      consumptionQty: 20,
    })).toEqual({ dailyRate: 0, signal: "none" });
  });

  it("prefers demand signal over receipts even with consumption + purchaseVelocity", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 3,
      salesVelocity: 0,
      purchaseVelocity: 5,
      consumptionQty: 20,
    })).toEqual({ dailyRate: 3, signal: "demand" });
  });
});

describe("chooseVelocitySignal — stock ledger precedence (2026-09-30)", () => {
  it("uses the ledger when every product-level signal is zero", () => {
    // The job-supply / unconfigured-SKU shape.
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0,
      salesVelocity: 0,
      purchaseVelocity: 0,
      consumptionQty: 0,
      ledgerVelocity: 27.09,
    })).toEqual({ dailyRate: 27.09, signal: "ledger" });
  });

  it("prefers the ledger over the receipts fallback", () => {
    // Receipts measure what we bought; the ledger measures what we consumed.
    const result = chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0,
      salesVelocity: 0,
      purchaseVelocity: 5,
      consumptionQty: 20,
      ledgerVelocity: 22.27,
    });
    expect(result.dailyRate).toBe(22.27);
    expect(result.signal).toBe("ledger");
    expect(result.replacedRate).toBe(5);
    expect(result.replacedSignal).toBe("receipts");
  });

  it("overrides a demand signal that understates the ledger by more than 2.5x", () => {
    // STICKER12 live: Aria demand 0.13/d vs ledger 16.63/d.
    const result = chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0.13,
      salesVelocity: 0,
      consumptionQty: 0,
      ledgerVelocity: 16.63,
    });
    expect(result.dailyRate).toBe(16.63);
    expect(result.signal).toBe("ledger");
    expect(result.replacedRate).toBe(0.13);
    expect(result.replacedSignal).toBe("demand");
  });

  it("overrides a receipt signal that overstates the ledger by more than 2.5x", () => {
    // RAWWORMCASTINGS live: Aria receipts 2800/d vs ledger 1654/d.
    const result = chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 0,
      salesVelocity: 0,
      purchaseVelocity: 2800,
      consumptionQty: 50,
      ledgerVelocity: 1654,
    });
    expect(result.dailyRate).toBe(1654);
    expect(result.signal).toBe("ledger");
    expect(result.replacedSignal).toBe("receipts");
  });

  it("keeps the product signal when it is within 2.5x of the ledger", () => {
    // THC103 live: demand 1.04/d vs ledger 1.06/d — genuine agreement.
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 1.04,
      salesVelocity: 0,
      consumptionQty: 94,
      ledgerVelocity: 1.056,
    })).toEqual({ dailyRate: 1.04, signal: "demand" });
  });

  it("ignores a zero or negative ledger rate", () => {
    expect(chooseVelocitySignal({
      reorderMethod: "default",
      demandVelocity: 3,
      salesVelocity: 0,
      consumptionQty: 20,
      ledgerVelocity: 0,
    })).toEqual({ dailyRate: 3, signal: "demand" });
  });
});
