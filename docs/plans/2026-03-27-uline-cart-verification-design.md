# ULINE Cart Verification And Daily Summary Truthfulness Design

**Date:** 2026-03-27

## Goal

Make ULINE Friday ordering trustworthy without automating checkout, and make the morning summary stop claiming "yesterday's" receivings unless the data is actually from yesterday.

## Scope

- Keep ULINE automation scoped to:
  - build or reuse a single draft PO
  - add items to the ULINE cart
  - verify the cart contents from the rendered cart page
  - sync verified unit prices back to the draft PO when they differ
  - stop before checkout
- Keep AAA Cooper vendor-specific invoice filtering in place.
- Make the daily morning summary use explicit yesterday-only slices for receivings and committed POs.

## ULINE Design

The current path clicks `Add to Cart` and treats that click as success. That is not sufficient. The revised flow is:

1. Generate the reorder manifest.
2. Create one draft Finale PO if needed.
3. Use Playwright to add items to the ULINE cart.
4. Inspect the resulting cart page and extract:
   - ULINE model number
   - quantity
   - visible unit price when available
   - visible line total when available
5. Compare expected manifest items against observed cart rows.
6. Classify the result:
   - `verified`: every expected item is present with matching quantity
   - `partial`: some items verified but some missing or mismatched
   - `unverified`: cart state could not be proven
7. If a draft Finale PO exists and verified cart prices differ from draft PO prices, update the draft PO line prices before notifying the user.
8. Telegram/dashboard language must reflect the verification state exactly. No optimistic "added to cart" claims from a button click alone.

### ULINE Messaging Contract

- `verified`: "Cart verified" and include count of verified items.
- `partial`: "Cart needs review" and list missing or mismatched models.
- `unverified`: "Cart fill attempted; manual verification needed."

The bot should explicitly say checkout is still a human step for now.

## Finale PO Rules

- Prefer one draft PO per ULINE run.
- Do not create extra draft POs if one already exists for the current run.
- Update draft line prices only when a verified cart price differs materially.
- Do not auto-commit or auto-cancel as part of this ULINE flow.
- Treat draft PO clutter as operational debt because the current client exposes cancel, not delete.

## Morning Summary Design

The current daily summary fetches week-to-date Finale data and asks the LLM to name "yesterday's" specific receivings. That is ungrounded. The revised data contract for daily summaries is:

- `finale_receivings_wtd`
- `finale_receivings_yesterday`
- `finale_committed_wtd`
- `finale_committed_yesterday`

The LLM prompt should reference the explicit yesterday-only arrays, not infer them from week-to-date data.

## Testing

- Unit tests for cart verification classification:
  - verified cart
  - partial cart with missing items
  - unverified cart with no observed rows
- Unit tests for PO price sync planning:
  - only changed verified prices produce updates
  - missing/unverified rows do not mutate prices
- Unit tests for daily summary slicing:
  - week-to-date totals preserved
  - yesterday-only arrays contain only the target date
- Focused integration tests for ops-manager notification wording:
  - verified cart wording
  - partial/unverified wording

## Non-Goals

- No automated ULINE checkout yet.
- No confirmation-number scraping in this batch.
- No redesign of AP reconciliation beyond the existing AAA Cooper invoice-page filter.
