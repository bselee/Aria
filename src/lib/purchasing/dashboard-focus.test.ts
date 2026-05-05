import { describe, expect, it } from "vitest";

import {
  canIncludeInDraftPO,
  canUseDirectOrdering,
  getEffectiveShortageDays,
  getOrderingFocusBucket,
  itemMatchesOrderingFocus,
  shouldAutoSelectItem,
  type OrderingMethodPolicy,
} from "./dashboard-focus";

const baseItem = {
  urgency: "ok" as const,
  runwayDays: 21,
  leadTimeDays: 14,
  assessment: {
    decision: "order" as const,
  },
};

describe("getEffectiveShortageDays", () => {
  it("prefers finaleStockoutDays when finite and non-negative", () => {
    expect(getEffectiveShortageDays({
      ...baseItem,
      finaleStockoutDays: 7,
      adjustedRunwayDays: 80,
      runwayDays: 0,
    })).toBe(7);
  });

  it("falls back to adjustedRunwayDays when finaleStockoutDays is null", () => {
    expect(getEffectiveShortageDays({
      ...baseItem,
      finaleStockoutDays: null,
      adjustedRunwayDays: 42,
      runwayDays: 0,
    })).toBe(42);
  });

  it("falls back to runwayDays when both upper signals are missing", () => {
    expect(getEffectiveShortageDays({
      ...baseItem,
      runwayDays: 12,
    })).toBe(12);
  });

  it("returns Infinity when no signal is finite", () => {
    expect(getEffectiveShortageDays({
      ...baseItem,
      runwayDays: Number.POSITIVE_INFINITY,
    })).toBe(Number.POSITIVE_INFINITY);
  });

  it("ignores negative values (treats them as missing)", () => {
    expect(getEffectiveShortageDays({
      ...baseItem,
      finaleStockoutDays: -1,
      adjustedRunwayDays: 50,
      runwayDays: 0,
    })).toBe(50);
  });
});

describe("getOrderingFocusBucket — buckets by effective shortage", () => {
  it("treats critical items as order_now regardless of shortage", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "critical",
      runwayDays: 12,
      leadTimeDays: 14,
    })).toBe("order_now");
  });

  it("returns order_now when shortage <= leadTime", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 14,
      leadTimeDays: 14,
    })).toBe("order_now");
  });

  it("returns 30 when shortage in (leadTime, 30]", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 25,
      leadTimeDays: 14,
    })).toBe("30");
  });

  it("returns 60 when shortage in (30, 60]", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "watch",
      runwayDays: 55,
      leadTimeDays: 14,
    })).toBe("60");
  });

  it("returns 90 when shortage in (60, 90]", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "watch",
      runwayDays: 80,
      leadTimeDays: 14,
    })).toBe("90");
  });

  it("returns later when shortage > 90", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "ok",
      runwayDays: 120,
      leadTimeDays: 14,
    })).toBe("later");
  });

  it("uses adjusted runway ahead of raw runway for planning windows", () => {
    // raw runway 0 (would be order_now alone) but PO covers extending to 42d → 60 bucket
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 0,
      adjustedRunwayDays: 42,
      leadTimeDays: 14,
    })).toBe("60");
  });

  it("uses finale stockout days ahead of adjusted runway", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 0,
      adjustedRunwayDays: 80,
      finaleStockoutDays: 21,
      leadTimeDays: 14,
    })).toBe("30");
  });

  it("returns later for non-actionable items even when shortage is critical", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "critical",
      runwayDays: 0,
      assessment: { decision: "hold" },
    })).toBe("later");
  });
});

describe("itemMatchesOrderingFocus — cumulative windows", () => {
  it("excludes non-actionable items from every window", () => {
    const held = {
      ...baseItem,
      urgency: "critical" as const,
      runwayDays: 0,
      assessment: { decision: "hold" as const },
    };
    expect(itemMatchesOrderingFocus(held, "order_now")).toBe(false);
    expect(itemMatchesOrderingFocus(held, "30")).toBe(false);
    expect(itemMatchesOrderingFocus(held, "all")).toBe(false);
  });

  it("matches numeric windows cumulatively (45d shortage matches 60 and 90 but not 30)", () => {
    const item = {
      ...baseItem,
      urgency: "watch" as const,
      runwayDays: 45,
      adjustedRunwayDays: 45,
      leadTimeDays: 14,
    };
    expect(itemMatchesOrderingFocus(item, "order_now")).toBe(false);
    expect(itemMatchesOrderingFocus(item, "30")).toBe(false);
    expect(itemMatchesOrderingFocus(item, "60")).toBe(true);
    expect(itemMatchesOrderingFocus(item, "90")).toBe(true);
    expect(itemMatchesOrderingFocus(item, "all")).toBe(true);
  });

  it("order_now matches when urgency=critical regardless of shortage", () => {
    const item = {
      ...baseItem,
      urgency: "critical" as const,
      runwayDays: 60,  // shortage > leadTime
      leadTimeDays: 14,
    };
    expect(itemMatchesOrderingFocus(item, "order_now")).toBe(true);
  });

  it("order_now matches when shortage <= leadTime even if urgency != critical", () => {
    const item = {
      ...baseItem,
      urgency: "warning" as const,
      runwayDays: 10,
      leadTimeDays: 14,
    };
    expect(itemMatchesOrderingFocus(item, "order_now")).toBe(true);
  });

  it("uses default leadTime=7 when leadTimeDays is missing or invalid", () => {
    const item = {
      ...baseItem,
      urgency: "warning" as const,
      runwayDays: 6,
      leadTimeDays: null,
    };
    expect(itemMatchesOrderingFocus(item, "order_now")).toBe(true);
    const tooFar = { ...item, runwayDays: 8 };
    expect(itemMatchesOrderingFocus(tooFar, "order_now")).toBe(false);
  });
});

describe("auto-select policy (unchanged from v1)", () => {
  it("respects never-auto-select policy", () => {
    const policy: OrderingMethodPolicy = { neverAutoSelect: true };
    expect(shouldAutoSelectItem(baseItem, policy)).toBe(false);
  });

  it("respects manual-only policy", () => {
    const policy: OrderingMethodPolicy = { manualOnly: true };
    expect(shouldAutoSelectItem(baseItem, policy)).toBe(false);
  });

  it("still auto-selects Finale manual items when demand supports action", () => {
    expect(shouldAutoSelectItem({
      ...baseItem,
      reorderMethod: "manual",
    })).toBe(true);
  });

  it("never includes do-not-reorder items in draft POs", () => {
    expect(canIncludeInDraftPO("do_not_reorder")).toBe(false);
    expect(canIncludeInDraftPO("manual")).toBe(true);
  });

  it("blocks direct ordering when direct ordering is disabled", () => {
    const policy: OrderingMethodPolicy = { disableDirectOrder: true };
    expect(canUseDirectOrdering("ULINE", undefined, policy)).toBe(false);
  });

  it("blocks direct ordering for on-site-order Finale methods", () => {
    expect(canUseDirectOrdering("ULINE", "on_site_order")).toBe(false);
  });

  it("does NOT auto-select when decision is 'hold' even if urgency is critical", () => {
    expect(shouldAutoSelectItem({
      ...baseItem,
      urgency: "critical",
      assessment: { decision: "hold" },
    })).toBe(false);
  });

  it("does NOT auto-select when assessment is absent", () => {
    expect(shouldAutoSelectItem({
      ...baseItem,
      assessment: {},
    })).toBe(false);
  });

  it("auto-selects when decision is 'reduce'", () => {
    expect(shouldAutoSelectItem({
      ...baseItem,
      assessment: { decision: "reduce" },
    })).toBe(true);
  });
});
