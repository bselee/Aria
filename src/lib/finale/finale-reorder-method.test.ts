import { describe, expect, it } from "vitest";

import { normalizeFinaleReorderMethod } from "./client";

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
});
