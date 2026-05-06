# Ordering Priority Filter Design

**Date:** 2026-05-05

## Goal

Replace the confusing `Today / Week / All` ordering filters with planning windows that match purchasing decisions:

- `Order Now`
- `30`
- `60`
- `90`
- optional `All`

At the same time, fix the underlying priority logic so vendors and items are ordered by the real purchase need, not just by coarse urgency tier or raw on-hand runway.

## Current Problem

The current ordering panel shows filter pills like:

- `0 TODAY`
- `3 WEEK`
- `ALL 87`

This is confusing for purchasing because:

1. `Today` does not mean “place this order now” in a durable business sense. It means the item matched a narrow UI helper.
2. `Week` hides the more useful planning windows: 30, 60, and 90 days.
3. The counts are item counts for `today`/`week`, but `ALL` currently displays active vendor count, so the numbers do not describe the same thing.
4. Vendor rows are sorted mostly by urgency tier only. When many vendors are `WARN`, the list does not reliably put the most needed vendor first.
5. The label `first out 0d` is based on raw `runwayDays`, so it can show scary red `0d` even when open POs extend adjusted coverage.

## Desired Behavior

The filter bar should become:

```text
Order Now  |  30  |  60  |  90  |  All
```

Recommended labels with counts:

```text
Order Now 12
30 28
60 46
90 63
All 87
```

The numeric filters are cumulative:

- `Order Now`: items whose effective shortage is inside lead time, or already out with no adequate on-order coverage.
- `30`: all actionable items due within 30 days.
- `60`: all actionable items due within 60 days.
- `90`: all actionable items due within 90 days.
- `All`: all actionable, non-snoozed items that pass the lifecycle filter.

Default filter should be `Order Now`.

## Definitions

### Effective Shortage Days

Coders should stop using raw `runwayDays` as the primary ordering score. Use this precedence:

1. `finaleStockoutDays`, when it is finite and non-negative.
2. `adjustedRunwayDays`, when it is finite and non-negative.
3. `runwayDays`, when it is finite and non-negative.
4. `Infinity`.

Suggested helper:

```ts
export function getEffectiveShortageDays(item: FocusItem): number {
  const candidates = [
    item.finaleStockoutDays,
    item.adjustedRunwayDays,
    item.runwayDays,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return Number.POSITIVE_INFINITY;
}
```

### Order Now

An item is `order_now` when:

- assessment decision is `order` or `reduce`, and
- effective shortage days are less than or equal to lead time days, or
- urgency is `critical`.

Use lead time default `7` only when missing or invalid.

### Planning Windows

An item belongs to a numeric window when:

- it is actionable (`assessment.decision` is `order` or `reduce`), and
- `effectiveShortageDays <= windowDays`.

Do not require urgency `critical` or `warning` for numeric windows. A `watch` item that becomes short in 60 days belongs in `60`.

## Proposed Types

Change `src/lib/purchasing/dashboard-focus.ts`.

Current:

```ts
export type OrderingFocusBucket = "today" | "week" | "later";
```

Replace with:

```ts
export type OrderingFocusFilter = "order_now" | "30" | "60" | "90" | "all";
export type OrderingFocusBucket = "order_now" | "30" | "60" | "90" | "later";
```

Extend `FocusItem`:

```ts
type FocusItem = {
  urgency: "critical" | "warning" | "watch" | "ok";
  runwayDays: number;
  adjustedRunwayDays?: number;
  finaleStockoutDays?: number | null;
  leadTimeDays: number | null;
  reorderMethod?: FinaleReorderMethod;
  assessment?: {
    decision?: PurchasingDecision;
  };
};
```

Add:

```ts
function isActionable(item: FocusItem): boolean {
  const decision = item.assessment?.decision;
  return decision === "order" || decision === "reduce";
}

export function getEffectiveShortageDays(item: FocusItem): number {
  const candidates = [
    item.finaleStockoutDays,
    item.adjustedRunwayDays,
    item.runwayDays,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function getOrderingFocusBucket(item: FocusItem): OrderingFocusBucket {
  if (!isActionable(item)) return "later";

  const shortageDays = getEffectiveShortageDays(item);
  const leadTimeDays = item.leadTimeDays && item.leadTimeDays > 0 ? item.leadTimeDays : 7;

  if (item.urgency === "critical" || shortageDays <= leadTimeDays) return "order_now";
  if (shortageDays <= 30) return "30";
  if (shortageDays <= 60) return "60";
  if (shortageDays <= 90) return "90";
  return "later";
}

export function itemMatchesOrderingFocus(item: FocusItem, filter: OrderingFocusFilter): boolean {
  if (!isActionable(item)) return false;
  if (filter === "all") return true;
  const shortageDays = getEffectiveShortageDays(item);
  const leadTimeDays = item.leadTimeDays && item.leadTimeDays > 0 ? item.leadTimeDays : 7;
  if (filter === "order_now") return item.urgency === "critical" || shortageDays <= leadTimeDays;
  return shortageDays <= Number(filter);
}
```

## UI Changes

Modify `src/components/dashboard/PurchasingPanel.tsx`.

### Filter Type

Current:

```ts
type FocusFilter = "today" | "week" | "all";
```

Replace:

```ts
type FocusFilter = "order_now" | "30" | "60" | "90" | "all";
```

### Local Storage Migration

Current local storage may contain `today` or `week`.

Migration rules:

- `today` -> `order_now`
- `week` -> `30`
- `all` -> `all`
- anything else -> `order_now`

### Counts

Counts should all use the same unit: actionable item count after snooze filtering, before lifecycle filtering unless the panel already treats lifecycle as a global filter. Prefer applying lifecycle too if users expect the count to match visible rows.

Suggested implementation:

```ts
const focusCount = (filter: FocusFilter) =>
  activeGroups
    .flatMap(g => g.items)
    .filter(item => itemMatchesOrderingFocus(item, filter))
    .filter(item => itemMatchesLifecycle(item))
    .length;

const orderNowCount = focusCount("order_now");
const thirtyCount = focusCount("30");
const sixtyCount = focusCount("60");
const ninetyCount = focusCount("90");
const allCount = focusCount("all");
```

Do not use vendor count for `All`; use item count.

### Filter Buttons

Render:

```tsx
[
  ["order_now", "Order Now", orderNowCount],
  ["30", "30", thirtyCount],
  ["60", "60", sixtyCount],
  ["90", "90", ninetyCount],
  ["all", "All", allCount],
].map(...)
```

Use `Order Now`, not `Today`.

Use numeric labels without `D` to keep the toolbar compact. Add a tooltip:

- `30`: `Show items projected short within 30 days`
- `60`: `Show items projected short within 60 days`
- `90`: `Show items projected short within 90 days`

### Section Header

Current header likely renders:

```tsx
{focusFilter === "today" ? "Today" : focusFilter === "week" ? "This Week" : "All"}
```

Replace with:

```ts
const focusLabel = {
  order_now: "Order Now",
  "30": "Next 30 Days",
  "60": "Next 60 Days",
  "90": "Next 90 Days",
  all: "All",
}[focusFilter];
```

## Vendor Sorting Fix

In `PurchasingPanel.tsx`, current vendor sorting is:

```ts
const sortedGroups = [...allGroups].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
```

Replace with a real need score based on visible/actionable items.

Suggested helper:

```ts
function vendorNeedScore(group: PurchasingGroup): {
  urgencyRank: number;
  earliestShortage: number;
  actionableCount: number;
  selectedValue: number;
} {
  const actionable = group.items.filter(item =>
    item.assessment?.decision === "order" || item.assessment?.decision === "reduce",
  );
  const candidates = actionable.length > 0 ? actionable : group.items;
  const earliestShortage = Math.min(...candidates.map(getEffectiveShortageDays));
  const urgencyRank = Math.min(...candidates.map(item => URGENCY_RANK[item.urgency]));
  const selectedValue = actionable.reduce((sum, item) => sum + item.suggestedQty * item.unitPrice, 0);
  return {
    urgencyRank,
    earliestShortage,
    actionableCount: actionable.length,
    selectedValue,
  };
}
```

Sort:

```ts
const sortedGroups = [...allGroups].sort((a, b) => {
  const left = vendorNeedScore(a);
  const right = vendorNeedScore(b);
  return (
    left.earliestShortage - right.earliestShortage ||
    left.urgencyRank - right.urgencyRank ||
    right.actionableCount - left.actionableCount ||
    right.selectedValue - left.selectedValue ||
    a.vendorName.localeCompare(b.vendorName)
  );
});
```

This puts the earliest shortage first, then breaks ties by severity and business impact.

## Row Label Fix

Replace `first out Xd` with a clearer label:

- `shortage Xd` for effective shortage days.
- If raw runway is `0d` but adjusted runway is greater due to open POs, show:
  - `on hand out now · covered Xd`
- If effective shortage is inside lead time, use red.
- If within 30 days, use yellow.
- If 31-90 days, use green or muted.

Suggested helper:

```ts
function shortageLabel(item: PurchasingItem): { text: string; days: number } {
  const effective = getEffectiveShortageDays(item);
  if (item.runwayDays === 0 && item.adjustedRunwayDays > 0) {
    return { text: `on hand out now · covered ${Math.round(item.adjustedRunwayDays)}d`, days: effective };
  }
  return { text: `shortage ${Math.round(effective)}d`, days: effective };
}
```

For vendor row summary, calculate the best label from the highest priority actionable item, not from any dormant/noise item.

## Tests

### `src/lib/purchasing/dashboard-focus.test.ts`

Update old tests:

- `today` becomes `order_now`.
- `week` becomes `30`.
- Add `60` and `90` cases.

Add cases:

```ts
it("uses adjusted runway ahead of raw runway for planning windows", () => {
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

it("matches numeric windows cumulatively", () => {
  const item = {
    ...baseItem,
    urgency: "watch" as const,
    runwayDays: 45,
    adjustedRunwayDays: 45,
    leadTimeDays: 14,
  };
  expect(itemMatchesOrderingFocus(item, "30")).toBe(false);
  expect(itemMatchesOrderingFocus(item, "60")).toBe(true);
  expect(itemMatchesOrderingFocus(item, "90")).toBe(true);
});
```

### `src/components/dashboard/PurchasingPanel.test.tsx`

Add or update UI tests to assert:

- toolbar shows `Order Now`, `30`, `60`, `90`, `All`
- old `TODAY` and `WEEK` labels are gone
- `All` count is item count, not vendor count
- localStorage `today` migrates to `order_now`
- localStorage `week` migrates to `30`

## Acceptance Criteria

1. Toolbar shows `Order Now`, `30`, `60`, `90`, `All`.
2. Counts use item counts consistently.
3. Default filter is `Order Now`.
4. `30`, `60`, and `90` are cumulative.
5. Vendor rows are sorted by real earliest actionable shortage, not only urgency tier.
6. Raw `Out in 0d` no longer appears as the primary summary when adjusted coverage exists.
7. Existing draft PO behavior is unchanged.
8. Tests pass:

```bash
npx vitest run src/lib/purchasing/dashboard-focus.test.ts src/components/dashboard/PurchasingPanel.test.tsx
```

## Non-Goals

- Do not change the recommendation formula in this task.
- Do not change vendor order policy or Colorful 6-month logic here; that is covered by `docs/plans/2026-05-05-vendor-reorder-policy-overrides.md`.
- Do not add a full settings editor.
- Do not change draft PO creation or send/commit behavior.

