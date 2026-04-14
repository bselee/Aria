import { describe, expect, it } from "vitest";

import {
  canIncludeInDraftPO,
  canUseDirectOrdering,
  getOrderingFocusBucket,
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

describe("dashboard focus helpers", () => {
  it("treats critical items as today work", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "critical",
      runwayDays: 12,
      leadTimeDays: 14,
    })).toBe("today");
  });

  it("treats warning items as this week work", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 18,
      leadTimeDays: 14,
    })).toBe("week");
  });

  it("treats long-runway items as later work", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "ok",
      runwayDays: 45,
      leadTimeDays: 14,
    })).toBe("later");
  });

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

  it("returns 'later' for critical urgency with runway > leadTime (AND logic)", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "critical",
      runwayDays: 30,
      leadTimeDays: 14,
    })).toBe("later");
  });

  it("returns 'later' for warning urgency with runway > leadTime+7 (AND logic)", () => {
    expect(getOrderingFocusBucket({
      ...baseItem,
      urgency: "warning",
      runwayDays: 45,
      leadTimeDays: 14,
    })).toBe("later");
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
