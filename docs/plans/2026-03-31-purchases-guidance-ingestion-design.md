# Purchases Guidance Ingestion Design

**Problem**

The internal `/purchases` site provides useful vendor and SKU urgency guidance from a coworker, but it can contain inaccuracies and currently takes time to verify manually. The first scraping attempt proved the site is reachable and structured, but the extraction is brittle and the downstream analysis overlaps with the shared purchasing intelligence engine.

**Goal**

Turn the internal purchases guidance page into a clean, validated advisory input that can eventually influence purchasing automatically after it proves trustworthy.

## Recommended Approach

Treat the site as a `guidance source`, not a source of truth.

Build a small ingestion pipeline:
1. scrape the purchases page reliably
2. normalize `vendor`, `sku`, `urgency`, and displayed metrics
3. validate each item against Finale and the shared purchasing policy
4. classify each item by agreement or disagreement
5. only let validated guidance influence draft purchasing later

This avoids creating a second purchasing brain while still preserving the coworker insight already embedded in the site.

## Intended Classifications

Each scraped item should land in one of these buckets:
- `agrees_with_policy`
- `guidance_overstates_need`
- `guidance_understates_need`
- `already_on_order`
- `missing_in_finale`
- `needs_manual_review`

This makes the site useful immediately, even before it becomes part of the automated purchasing flow.

## Scraper Design

The scraper should be easy and boring to run.

### Session model
- Prefer an authenticated Playwright flow that can reuse a saved logged-in profile or explicit credentials.
- Do not depend on a manually prepared CDP browser as the only run mode.

### Navigation model
- Wait for stable page markers instead of fixed sleeps.
- Re-query vendor chip buttons after each click rather than storing element handles through rerenders.
- Treat the page as a sequence of vendor tabs plus a single item detail surface.

### Extraction model
- Extract vendor chip labels and counts directly.
- Extract each visible SKU card structurally from the item panel, not by loose “uppercase label then leaf text” heuristics.
- Normalize the result into a stable JSON shape with typed fields for:
  - vendor
  - sku
  - description
  - urgency
  - purchaseAgainBy
  - recommendedReorderQty
  - supplierLeadTime
  - remaining
  - sales/consumption/build metrics
  - financial metrics

## Validation Gate

The guidance site can influence purchasing only after validation.

Validation should check:
- SKU exists in Finale
- item is not already sufficiently covered by open POs
- shared purchasing policy agrees, or the disagreement is explainable
- demand velocity / runway / lead time support the recommendation
- BOM-driven needs are not overstated when downstream finished goods are already healthy

Until that validation is complete, the site remains advisory-only.

## Relationship To Shared Purchasing Intelligence

The site should not keep its own long-term scoring engine.

The current `assess-purchases.ts` prototype contains useful cross-check logic, but the scoring itself should be folded into the shared purchasing intelligence pipeline as a comparison stage.

Long-term model:
- scraper gathers coworker guidance
- shared purchasing engine evaluates actual need
- comparison layer classifies agreement/disagreement
- validated agreement can become an extra positive signal for purchasing automation

## Cleanup Decision

### Keep
- `src/cli/scrape-purchases.ts`
- `src/cli/assess-purchases.ts`
- `purchases-data.json` as a sample/debug artifact

### Archive or discard
- most `purchases-*.png` screenshots

Keep only a small representative set if needed:
- login screen
- purchases loaded overview
- one populated vendor card
- one long multi-item vendor page
- one timeout/failure example

All other screenshots should move to an archive/debug folder or be discarded.

## Success Criteria

The next version is successful when:
- scraping is repeatable without babysitting
- extracted metrics are mostly populated and trustworthy
- every scraped item is classified against Finale/shared policy
- the output helps resolve coworker guidance quickly instead of creating more tail-chasing
- the path to future pipeline integration is explicit and safe
