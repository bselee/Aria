# Finale-Native Ordering Method Design

## Summary

Ordering behavior should come from Finale at the SKU level, not from Aria-local dashboard settings. Aria should read Finale's per-SKU reorder method choices, but it should only treat some of them as strong signals. In practice, `manual` and `default` are often inherited or left in place automatically, so computed movement intelligence needs to do the real filtering work.

This keeps Finale as the system of record for:

- whether a SKU should be reordered
- whether it should stay manual
- which velocity basis should drive the reorder decision
- any method hints like on-site ordering

Aria's role is to:

- surface those Finale choices clearly in the dashboard
- combine them with computed consumption/movement signals
- suppress noise from non-moving items
- keep action paths honest and pleasant to use

## Source Of Truth

### Finale per-SKU controls

Each SKU in Finale is assumed to already carry one of these reorder method choices:

- `do not reorder`
- `manual`
- `sales velocity`
- `demand velocity`
- possibly a method hint like `on site order`

These should be treated as authoritative SKU-level metadata, but not all values should have equal weight.

### What Aria should not do

Aria should not maintain a second durable dashboard-only rule store for these same concepts. Local UI state like panel height, focus tab, and collapse state can stay local, but reorder method behavior should come from Finale.

## Decision Model

### Reorder method interpretation

`Do Not Reorder`
- Exclude SKU from actionable ordering entirely.
- This remains a hard control and should be trusted strongly.

`Manual`
- Do not treat this as a strong suppression rule by itself.
- Many SKUs inherit or retain this automatically.
- If computed movement says the SKU is active and at risk, keep it visible.
- Present it as manual handling only when it does surface.

`Sales Velocity`
- Use the sales-based movement signal as the primary daily rate.

`Demand Velocity`
- Use Finale's broader demand signal as the primary daily rate.
- This remains the preferred method when demand is richer than direct sales.

`On Site Order`
- Treat this as a fulfillment/action-path hint, not a suppression rule.
- SKU still appears if it needs action, but the dashboard should route it toward the appropriate purchase method.

`Default`
- Treat this as a weak hint, similar to `manual`.
- Do not assume it means the SKU should be suppressed or deprioritized.
- Fall back to computed movement and runway logic.

## Velocity Strategy

### Combined view

Sales and demand are similar enough that the dashboard should present them together rather than as competing concepts. Finale's own definitions use the same formula, with demand extending sales to include BOM-component demand. A sales-only SKU can therefore still benefit from demand-based visibility when Finale has useful broader activity data.

### Practical rule

Aria should continue to respect Finale's configured per-SKU method where it is meaningful:

- if Finale says `sales velocity`, use sales as primary
- if Finale says `demand velocity`, use demand as primary

If Finale says `manual` or `default`, Aria should fall back to computed movement logic instead of blindly suppressing or elevating the SKU.

### Fine-tuning from base data

Aria may still improve the recommendation quality using computed signals from raw activity:

- recent purchase receipts
- shipment/sales history
- consumption history
- days since last movement
- on-order coverage

This should be used for:

- filtering out non-moving items
- confidence scoring
- better runway explanations
- reducing noise from historic bulk buys or stale demand

It should not override Finale's method selection blindly.

## Non-Moving SKU Filtering

### Goal

Exclude SKUs that technically qualify under static Finale reorder fields but are not actually moving in a meaningful window.

### Aria refinement

Add a computed movement filter using recent base data:

- no meaningful sales, demand, consumption, or receipt activity in the lookback window
- no active on-order coverage requiring attention
- no explicit Finale reorder flag that should force visibility

This filter should downgrade or exclude dead/noise SKUs from the dashboard while preserving visibility for truly active items.

This becomes especially important for SKUs whose Finale method is `manual` or `default`, since those settings are not consistently curated.

### Result

Operators see fewer stale recommendations and more relevant action lists.

## Dashboard Behavior

### Ordering panel

The Ordering panel should read Finale-native method labels and show them directly on SKUs:

- `MANUAL`
- `DNR`
- `SALES`
- `DEMAND`
- `ON SITE`

The panel should remain focused around time horizon:

- `Today`
- `This Week`
- `All`

And it should only show actionable SKUs that survive:

- Finale method filtering
- movement/noise filtering
- on-order coverage suppression

The practical trust model is:

- Strong trust: `Do Not Reorder`
- Medium trust: explicit `sales velocity` / `demand velocity`
- Weak trust: `manual` / `default`
- Final gate: computed movement and runway pressure

### Receivings and AP

These changes do not alter Receivings or AP source of truth, but they help overall dashboard trust by making Ordering recommendations more grounded and less noisy.

## Implementation Direction

1. Extend Finale client parsing to read per-SKU reorder method explicitly.
2. Attach that method to purchasing candidate and assessed output.
3. Update policy shaping so daily-rate selection honors Finale's chosen method where meaningful.
4. Treat `manual` and `default` as weak hints, not hard suppressors.
5. Add movement-based suppression for non-moving SKUs.
6. Update the Ordering panel to display Finale-native method badges and block/shape actions accordingly.

## Success Criteria

- Aria no longer relies on dashboard-local reorder method settings.
- Finale per-SKU settings inform how each SKU is evaluated, but `manual/default` do not create false suppression.
- Non-moving items drop out unless there is a strong reason to show them.
- Manual SKUs remain visible when active but are never auto-selected or direct-ordered.
- Ordering feels calmer, more trustworthy, and more actionable.
