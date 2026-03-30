# Shared Purchasing Intelligence Design

**Date:** 2026-03-30  
**Status:** Approved design  
**Scope:** Shared purchasing intelligence policy for dashboard, bot-driven draft POs, and vendor ordering flows (`ULINE`, `Axiom`, `Sustainable Village`)

---

## Goal

Build one cohesive purchasing intelligence policy that:

- gives the best possible reorder recommendations for BuildASoil products
- works across direct-sell, BOM-driven, and mixed-demand SKUs
- allows draft PO creation from the dashboard and bot for any vendor
- limits scheduled auto-draft creation to trusted repeatable vendors
- powers vendor cart automation without re-inventing reorder logic per vendor
- avoids wasting resources by re-scanning stale vendor history

---

## Problem

Current vendor ordering flows are useful, but the hardest part is not carting. The hardest part is deciding what should be on the draft PO in the first place.

This is especially important for vendors like `Axiom`, `ULINE`, and `Sustainable Village`, where many items are:

- repetitive small parts
- direct retail products
- BOM components for manufactured items
- or both at the same time

If we rely too heavily on component activity alone, we can over-order materials that feed finished goods we already have plenty of. If we ignore BOM demand, we risk starving manufacturing. The system needs a shared policy that understands both sides and produces explainable outcomes.

---

## Design Principles

1. One purchasing brain, many vendor adapters.
2. Demand policy must be shared across all flows.
3. Vendor code should decide how to place orders, not whether to buy.
4. BOM/component demand must support real downstream product demand.
5. Direct-sell demand must still count in full.
6. Draft PO creation should be available manually for all vendors.
7. Scheduled auto-draft creation should be limited to trusted repeatable vendors.
8. Normal runs must be incremental and recency-bounded, not full-history rescans.
9. Every recommendation should be explainable enough to trust or override quickly.

---

## Recommended Approach

### Approach 1: Shared purchasing intelligence engine

Create one shared policy engine that evaluates every candidate SKU and returns a normalized recommendation:

- `order`
- `reduce`
- `hold`
- `manual_review`

This engine is the source of truth for:

- dashboard reorder suggestions
- bot answers and draft PO creation
- trusted-vendor scheduled auto-drafts
- vendor-specific online ordering flows

This is the recommended approach.

### Approach 2: Vendor-specific reorder policies

Each vendor flow would keep its own demand logic while reusing some helpers.

This is faster short-term but almost guarantees drift. The same SKU could get different answers depending on whether it is viewed in the dashboard, ordered by bot, or sent through a vendor carting flow.

### Approach 3: Finale-only purchasing intelligence

This would trust Finale’s purchasing signals almost entirely.

This is too weak for BuildASoil’s real-world crossover between direct retail demand and BOM/manufacturing demand.

---

## Shared Policy Architecture

Add a shared purchasing policy layer under `src/lib/purchasing/` that consumes Finale intelligence and returns a structured recommendation per SKU.

### Core inputs

- Finale purchasing intelligence
- stock on hand
- stock on order
- direct retail demand
- BOM/manufacturing demand
- finished-goods coverage/runway
- lead time
- order increment and pack constraints
- recent PO and receiving context
- trusted vendor order history, when recent and relevant

### Core outputs

Each candidate line should return:

- `decision`: `order` | `reduce` | `hold` | `manual_review`
- `recommendedQty`
- `confidence`
- `reasonCodes`
- `explanation`
- `supportingMetrics`

Example reason codes:

- `direct_demand_support`
- `bom_support_for_low_fg_runway`
- `fg_coverage_sufficient`
- `on_order_already_covers_need`
- `pack_size_forced_overbuy`
- `mapping_missing`
- `recent_draft_exists`

### Essential intelligence extensions

The first implementation should also include three high-value extensions because they are operationally essential, not optional polish:

- `receiving/AP feedback loop`
- `vendor/order constraints`
- `override memory`

---

## Demand Model

The engine should not ask “does this SKU have demand?” It should ask “what kind of demand is this, and is that demand already sufficiently covered?”

Each SKU should be evaluated across:

- `directDemand`
- `bomDemand`
- `sharedDemand`
- `dominantUse`

### Key BOM rule

Components should only be bought in support of real downstream demand.

If the finished goods that consume a component already have healthy coverage, BOM-driven reorder pressure for that component should be reduced or suppressed.

### Key direct-demand rule

If the component is also sold directly, that direct-sell demand still counts normally and can still justify reordering.

### Healthy coverage default

Use `30 days` of finished-goods coverage as the default healthy-supply guardrail for BOM-driven suppression, while allowing higher effective targets for clearly high-velocity items.

The system should never keep buying component-heavy items simply because they recur in many BOMs when the actual downstream product demand is already well covered.

---

## Vendor Flow Policy

### Manual draft creation

Draft POs should still be creatable through:

- dashboard actions
- bot/copilot requests

This should work for any vendor.

### Scheduled auto-draft creation

Auto-created draft POs should be limited to:

- `ULINE`
- `Axiom`
- `Sustainable Village`
- vendors explicitly promoted into a trusted paid-invoice set

Trusted means the vendor is repeatable enough operationally that automated drafts are useful and safe.

### Why this split

This keeps purchasing intelligence available everywhere without spamming the system with premature or low-confidence drafts for every vendor in the catalog.

---

## Vendor and Order Constraints

The shared engine should understand ordering realities beyond raw unit demand.

Examples:

- minimum order values
- case-pack or carton constraints
- order increments
- freight breakpoints
- “do not place tiny orders” economics
- vendor-specific minimum practical order thresholds

These constraints should not live inside vendor cart adapters. They should be part of the common purchasing policy so draft PO quality stays consistent everywhere.

If a recommendation is theoretically correct on demand but operationally bad because it creates a tiny or uneconomic order, the engine should return `reduce`, `hold`, or `manual_review` with clear reason codes.

---

## Feedback and Learning Loop

Purchasing intelligence should improve based on what actually happened after ordering.

The engine should ingest downstream truth signals from:

- receiving in Finale
- AP invoice matching and reconciliation
- observed vendor cart pricing
- whether a draft PO was committed, edited, or ignored

This feedback should influence future confidence and recommendations.

Examples:

- repeated overbuy on a SKU lowers reorder aggressiveness
- repeated underbuy or stockout pressure increases urgency
- invoices that consistently add meaningful freight can influence order economics
- recommendations that are repeatedly overridden should be treated as low-confidence until the engine learns the pattern

This is not the same as substitute intelligence or seasonality modeling. It is a practical closed-loop quality system for the first version.

---

## Override Memory

When a human repeatedly changes the same recommendation, the system should remember that as operational knowledge.

Examples:

- Will consistently trims a suggested quantity for a SKU
- Will consistently suppresses certain component-driven recommendations when finished goods are already healthy
- Will consistently increases order size for a fast mover to hit a practical freight or reorder cadence

The engine should store these patterns and expose them as:

- confidence adjustments
- recommended quantity bias
- explanation text showing that the system is following established operating behavior

Override memory should be vendor/SKU-scoped and recency-bounded. It should not become an unbounded pile of old habits.

---

## Vendor Adapter Responsibilities

Vendor-specific modules should only handle:

- SKU-to-vendor mapping
- pack-size conversion
- site search / product resolution
- browser or API-based carting
- live cart scraping and verification
- syncing verified prices back to draft POs

Vendor modules should not implement their own reorder policy.

This applies to:

- `ULINE`
- `Axiom`
- `Sustainable Village`
- future vendor automation flows

---

## Sustainable Village Flow

Sustainable Village should follow the same decision flow as `ULINE`:

1. shared purchasing intelligence assesses candidate lines
2. a finely tuned draft PO is created or updated in Finale
3. only approved lines move into the vendor ordering flow
4. Playwright opens a logged-in browser session
5. items are added to cart
6. live cart rows and prices are verified
7. verified price observations can sync back to the draft PO
8. flow stops at cart review, not checkout

Because access is currently login-based, the first implementation should be Playwright-first. If clean API access becomes available later, it can be layered in behind the same adapter contract.

---

## Recency and Watermark Policy

Normal runs should not keep scanning all old vendor orders or old reconciled data.

Use a per-vendor recency-bounded process with watermarks:

- last processed vendor order id/date
- last successful mapping sync
- last successful cart verification
- last trusted history ingest

### Normal run scope

Normal runs should only inspect:

- current/open draft POs
- unresolved exceptions
- newly changed Finale demand state
- recent vendor activity inside a bounded lookback window

### Deep history

Backfills or broad historical rescans should be manual-only.

This avoids wasted resources and prevents regressions where the bot keeps churning through stale Axiom or ULINE history that no longer matters.

---

## Anti-Spam Draft Controls

Even trusted vendors should not get automatic draft POs unless the output is truly actionable.

Guardrails:

- do not auto-create a draft if most lines are `hold` or `manual_review`
- do not auto-create a draft if confidence is weak
- do not create repeated drafts for the same vendor/items inside a cooldown window
- do not create a draft if an equivalent recent draft already exists and is still unresolved

This is especially important while purchasing intelligence is still being tightened.

---

## Shared Outcome Model

Every assessed line should produce a structured result suitable for UI, bot, automation, and logs.

Example shape:

```ts
type PurchasingDecision = "order" | "reduce" | "hold" | "manual_review";

interface PurchasingAssessment {
  vendorName: string;
  productId: string;
  decision: PurchasingDecision;
  recommendedQty: number;
  confidence: "high" | "medium" | "low";
  reasonCodes: string[];
  explanation: string;
  metrics: {
    directDemand: number;
    bomDemand: number;
    stockOnHand: number;
    stockOnOrder: number;
    adjustedRunwayDays: number | null;
    finishedGoodsCoverageDays: number | null;
    leadTimeDays: number | null;
  };
}
```

This allows every surface to speak the same language and makes the system explainable in real use.

---

## Persistence and Memory

Use Supabase to persist:

- vendor product mappings
- recent successful cart items
- recent trusted order history
- per-vendor watermarks
- recent purchasing assessments
- draft PO cooldown and duplication checks
- vendor/order constraints
- downstream recommendation outcomes
- override memory

Historical vendor information should be ingested once, summarized, and reused from storage instead of re-scraped repeatedly.

---

## Testing Strategy

Testing should focus on the policy layer first, not browser automation first.

### Policy tests

- direct-demand-only SKU orders correctly
- BOM-only component is suppressed when finished goods are healthy
- mixed-demand SKU still orders when direct demand justifies it
- on-order inventory suppresses duplicate reorder pressure
- large pack-size forced overbuy returns `reduce` or `manual_review`
- recent duplicate draft prevents another auto-created draft
- tiny uneconomic order triggers `hold` or `manual_review`
- known override memory biases a recommendation in the expected direction
- downstream overbuy feedback reduces confidence or quantity
- receiving/AP truth can mark a recommendation as successful or poor

### Integration tests

- dashboard draft-PO request uses shared policy
- bot draft-PO request uses shared policy
- trusted-vendor scheduled draft generation uses shared policy
- vendor cart adapters receive only assessed draft lines

### Browser tests

- Sustainable Village login/session bootstrap
- add known mapped item to cart
- scrape observed cart rows
- verify expected vs observed rows
- never auto-submit checkout in v1

---

## Recommended Implementation Order

1. Create the shared assessment model and pure policy evaluator.
2. Feed dashboard and bot draft PO creation through it.
3. Add vendor trust boundaries and auto-draft gating.
4. Add recency/watermark persistence.
5. Add vendor constraints, feedback logging, and override memory persistence.
6. Refactor `ULINE` and `Axiom` flows to consume the shared policy.
7. Add Sustainable Village Playwright carting on top of the same policy output.

---

## Expected Outcome

This design gives BuildASoil:

- better purchasing intelligence for products and components
- one common policy across vendors and surfaces
- fewer unnecessary draft POs
- fewer stale rescans of old vendor history
- safer autonomous ordering support
- a repeatable path to adding new vendors later

Most importantly, it keeps the system grounded in real downstream demand instead of raw component noise.
