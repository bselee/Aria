# ULINE Order Unit Conversion And Shared Playwright Design

**Date:** 2026-03-27

## Goal

Keep Finale as the source of truth in eaches, convert to ULINE vendor order units only at ordering time, add guardrails for bad pack-size math and cost drift, and consolidate the fragile ULINE Playwright logic into one shared flow.

## Problem

The current ULINE path is mixing two different unit systems:

- Finale demand and draft POs are expressed in eaches.
- ULINE often sells the same SKU by fixed vendor order units such as `/25` bundles or `1 = 1000`.

That causes bad ordering behavior. Example: PO `124554` currently holds `S-3902` at `1000` eaches. If ULINE sells `S-3902` as `1 = 1000`, the cart should receive quantity `1`, not `1000`.

The current browser flow is also split:

- CLI has one Playwright implementation.
- Dashboard route has a separate Playwright implementation.
- Only the CLI has newer cart verification logic.

This makes the browser behavior inconsistent and harder to trust.

## Core Rule

- Finale stays in eaches.
- ULINE ordering converts eaches to vendor order units at send time.
- Cart verification compares against converted ULINE units, not raw Finale eaches.
- Draft PO quantities in Finale are never rewritten into vendor units.

## ULINE Rule Model

Add a shared rule table keyed by Finale SKU or ULINE model:

- `packSize`
  - Number of eaches represented by one ULINE order unit.
- `roundingMode`
  - Default `ceil`.
  - Allows future explicit behavior such as `nearest` or `floor` if needed.
- `roundingStep`
  - Optional extra vendor constraint if the order unit itself must be ordered in multiples.
- `maxOrderEaches`
  - Cap on converted Finale eaches for sanity control.
- `maxOrderUnits`
  - Optional cap in vendor order units.
- `costDeviationPct`
  - Maximum allowed variance between expected cost and implied cost after conversion.
- `notes`
  - Human explanation for why the rule exists.

Example intent:

- `S-3902`
  - `packSize = 1000`
- `S-4092`
  - `packSize = 25`
- `S-4128`
  - `packSize = 25`

## Conversion Model

Given a Finale line:

- `finaleEaches`
- `finaleUnitPrice`
- `ulineModel`
- `rule.packSize`

The ordering layer computes:

- `ulineOrderUnits = ceil(finaleEaches / packSize)` unless another rule overrides
- `impliedOrderedEaches = ulineOrderUnits * packSize`
- `impliedLineTotal = ulineOrderUnits * vendorOrderUnitPrice` when known
- `impliedEachCost = vendorOrderUnitPrice / packSize` when known

This produces a dual-view line item:

- Finale view
  - eaches
  - expected each-cost
- ULINE view
  - vendor order units
  - pack size
  - implied eaches

## Rounding Rules

Rounding is expected for box/count items because ULINE order quantities are fixed by bundle.

Recommended default:

- use `ceil` so we do not under-order
- show the implied overage explicitly in dry-run and bot output
- stop when rounding pushes the item over a configured cap

Example:

- Finale wants `980` eaches
- ULINE pack size is `25`
- converted order is `40` vendor units
- implied ordered eaches = `1000`

That rounding is acceptable and should be explained, not hidden.

## Guardrails

The ordering flow should stop or downgrade to review if any of these occur:

- no conversion rule exists for a known bundle-style SKU
- converted vendor units exceed `maxOrderUnits`
- implied eaches exceed `maxOrderEaches`
- implied each-cost deviates beyond the SKU or vendor threshold
- total converted cost deviates materially from the Finale-side estimate

Recommended behavior:

- `hard_stop`
  - block cart fill entirely
- `review_required`
  - show the line and reason, do not send automatically

Heavy-hitter handling:

- default box/count caps can stay conservative, such as `10000` eaches
- specific SKUs can opt into higher caps only when justified

## Shared Playwright Session

Replace duplicated browser logic with one shared ULINE session module:

- launch browser context
- login detection
- Quick Order navigation
- paste/grid entry
- add-to-cart click
- cart scraping
- error extraction

Consumers:

- CLI ULINE flow
- dashboard ULINE ordering route

This module should return structured state, not optimistic strings:

- `pageState`
- `addClicked`
- `observedCartRows`
- `errors`
- `verificationStatus`

## Integration Flow

1. Read Finale PO or auto-reorder manifest in eaches.
2. Convert lines to ULINE order units via shared rules.
3. Apply guardrails before browser launch.
4. Show dry-run with both Finale and ULINE views.
5. Run shared Playwright cart fill.
6. Verify cart against converted ULINE units.
7. If verified cart prices are visible and safe, sync price changes back to the Finale draft PO.
8. Stop before checkout.

## Known Fixes Included In This Scope

- Fix the ULINE draft-PO GraphQL listing path to use Finale's actual `status` field instead of `statusId`.
- Ensure dry-run and Telegram wording distinguish:
  - Finale eaches
  - ULINE order units
  - rounded overage when applicable

## Testing

- unit tests for conversion rules
- unit tests for rounding behavior
- unit tests for cap and cost guardrails
- unit tests for dry-run dual-view formatting
- integration tests for shared Playwright state handling with mocked cart rows
- regression tests proving CLI and dashboard both use the same conversion/session helpers

## Non-Goals

- no automated checkout
- no ULINE confirmation-number scraping in this batch
- no change to Finale base-unit accounting
