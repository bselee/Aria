# Shared Purchasing Intelligence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one shared purchasing intelligence engine that powers dashboard and bot draft-PO creation for all vendors, while limiting scheduled auto-drafts and vendor cart automation to trusted repeatable vendors like ULINE, Axiom, and Sustainable Village.

**Architecture:** Add a pure purchasing-policy layer under `src/lib/purchasing/` that converts Finale demand inputs into explainable `order` / `reduce` / `hold` / `manual_review` assessments. Then route existing purchasing entrypoints and vendor adapters through that layer, add Supabase-backed watermark/trust persistence, and finally scaffold Sustainable Village cart automation on top of the same assessed draft-PO manifest.

**Tech Stack:** TypeScript, Vitest, Next.js App Router, Finale API client, Supabase, Playwright

---

### Task 1: Define the shared assessment model

**Files:**
- Create: `src/lib/purchasing/policy-types.ts`
- Create: `src/lib/purchasing/policy-types.test.ts`

**Step 1: Write the failing test**

Create `src/lib/purchasing/policy-types.test.ts` with tests that assert the new shared types can represent:
- a direct-demand reorder
- a BOM-suppressed hold
- a manual-review result with reason codes

Use runtime shape assertions against exported factories or constants rather than only compile-time checks.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/policy-types.test.ts
```

Expected: FAIL because the file/module does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/policy-types.ts` exporting:
- `PurchasingDecision`
- `PurchasingReasonCode`
- `PurchasingAssessment`
- `PurchasingAssessmentMetrics`
- `VendorAutomationPolicy`
- small helpers/constants that tests can instantiate

Keep this file pure and dependency-free.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/policy-types.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/policy-types.ts src/lib/purchasing/policy-types.test.ts
git commit -m "feat(purchasing): add shared policy assessment types"
```

---

### Task 2: Build the pure purchasing policy engine

**Files:**
- Create: `src/lib/purchasing/policy-engine.ts`
- Create: `src/lib/purchasing/policy-engine.test.ts`
- Reference: `src/lib/finale/client.ts`

**Step 1: Write the failing test**

Create `src/lib/purchasing/policy-engine.test.ts` covering:
- direct-demand-only item returns `order`
- BOM-heavy component returns `hold` when finished-goods coverage is healthy
- mixed-demand item still returns `order` when direct demand justifies it
- open PO/on-order coverage reduces or suppresses reorder
- large pack increment forcing material overbuy returns `reduce` or `manual_review`

Prefer pure input/output tests with no mocks beyond simple literals.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/policy-engine.test.ts
```

Expected: FAIL because the engine does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/policy-engine.ts` with:
- a normalized input shape derived from Finale purchasing data
- `assessPurchasingCandidate(input): PurchasingAssessment`
- helper functions for:
  - healthy finished-goods coverage
  - BOM suppression
  - direct-demand support
  - on-order coverage suppression
  - pack-size overbuy detection

Keep the first implementation deterministic and explicit. No vendor-specific logic here.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/policy-engine.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/policy-engine.ts src/lib/purchasing/policy-engine.test.ts
git commit -m "feat(purchasing): add shared policy engine"
```

---

### Task 3: Add Finale-to-policy candidate shaping

**Files:**
- Create: `src/lib/purchasing/policy-candidates.ts`
- Create: `src/lib/purchasing/policy-candidates.test.ts`
- Reference: `src/lib/finale/client.ts`
- Reference: `src/lib/builds/build-risk.ts`

**Step 1: Write the failing test**

Create tests that prove Finale purchasing rows can be converted into policy candidates with:
- direct demand fields
- BOM/manufacturing demand fields
- on-order/open-PO context
- finished-goods coverage placeholders
- lead time / increment metadata

Include a test for a mixed-use SKU.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/policy-candidates.test.ts
```

Expected: FAIL because the candidate-shaping layer does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/policy-candidates.ts` with:
- a normalized candidate shape
- `buildPurchasingCandidate(...)`
- helper adapters from `PurchasingItem`
- explicit placeholder hooks for finished-goods coverage and BOM context so those can be enriched later without changing the policy engine contract

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/policy-candidates.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/policy-candidates.ts src/lib/purchasing/policy-candidates.test.ts
git commit -m "feat(purchasing): shape finale rows into policy candidates"
```

---

### Task 4: Build the shared purchasing assessment service

**Files:**
- Create: `src/lib/purchasing/assessment-service.ts`
- Create: `src/lib/purchasing/assessment-service.test.ts`
- Reference: `src/lib/finale/client.ts`
- Reference: `src/lib/purchasing/policy-engine.ts`
- Reference: `src/lib/purchasing/policy-candidates.ts`

**Step 1: Write the failing test**

Create service tests that verify:
- a vendor group can be assessed into assessed lines
- only actionable lines are surfaced for draft PO creation
- `hold` and `manual_review` lines are preserved with explanations
- the service works across multiple vendors without vendor-specific branching

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/assessment-service.test.ts
```

Expected: FAIL because the service does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/assessment-service.ts` with:
- `assessPurchasingGroups(groups, options?)`
- return type containing:
  - assessed vendor groups
  - actionable lines
  - blocked lines
  - vendor-level confidence summary

Keep this layer pure apart from data shaping.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/assessment-service.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/assessment-service.ts src/lib/purchasing/assessment-service.test.ts
git commit -m "feat(purchasing): add shared assessment service"
```

---

### Task 5: Route dashboard purchasing suggestions through the shared engine

**Files:**
- Modify: `src/app/api/dashboard/purchasing/route.ts`
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Create: `src/app/api/dashboard/purchasing/route.test.ts`
- Reference: `src/lib/purchasing/assessment-service.ts`

**Step 1: Write the failing test**

Add route tests that prove the dashboard purchasing API:
- returns assessed lines, not just raw Finale suggestions
- includes decision/explanation metadata
- does not lose existing vendor grouping behavior

Add a panel test only if there is already a stable pattern in the repo; otherwise keep this API-level first.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts
```

Expected: FAIL because the route currently returns raw groups.

**Step 3: Write minimal implementation**

Update the route to:
- fetch Finale purchasing intelligence
- pass groups through the new assessment service
- return both original/raw metrics and assessment fields needed by the dashboard

Update the panel to:
- display decision and explanation cleanly
- build draft POs from actionable assessed lines
- keep `hold` and `manual_review` visible

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/app/api/dashboard/purchasing/route.ts src/components/dashboard/PurchasingPanel.tsx src/app/api/dashboard/purchasing/route.test.ts
git commit -m "feat(purchasing): route dashboard suggestions through shared policy"
```

---

### Task 6: Route bot/copilot draft PO creation through the shared engine

**Files:**
- Modify: `src/cli/aria-tools.ts`
- Modify: `src/lib/copilot/actions.test.ts`
- Modify: `src/lib/slack/watchdog.ts`
- Create: `src/lib/purchasing/draft-po-policy.test.ts`
- Create: `src/lib/purchasing/draft-po-policy.ts`

**Step 1: Write the failing test**

Create tests that verify:
- bot-requested draft PO creation uses shared assessment results
- non-actionable lines are not blindly drafted
- explanations survive into the response
- existing vendor manual-draft behavior remains available

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/draft-po-policy.test.ts src/lib/copilot/actions.test.ts
```

Expected: FAIL because draft PO creation currently bypasses the shared assessment layer.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/draft-po-policy.ts` with:
- helpers that turn assessed lines into draft-PO items
- gating for `order` and `reduce` lines only
- explanation aggregation for bot/dashboard responses

Update bot and watchdog entrypoints to use it.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/draft-po-policy.test.ts src/lib/copilot/actions.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/draft-po-policy.ts src/lib/purchasing/draft-po-policy.test.ts src/cli/aria-tools.ts src/lib/copilot/actions.test.ts src/lib/slack/watchdog.ts
git commit -m "feat(purchasing): share draft PO policy across bot and dashboard"
```

---

### Task 7: Add trusted-vendor automation policy and cooldown gating

**Files:**
- Create: `src/lib/purchasing/vendor-automation-policy.ts`
- Create: `src/lib/purchasing/vendor-automation-policy.test.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`
- Reference: `src/lib/purchasing/assessment-service.ts`

**Step 1: Write the failing test**

Create tests that verify:
- `ULINE`, `Axiom`, and `Sustainable Village` are auto-draft eligible
- non-trusted vendors are manual-only
- low-confidence or mostly-held manifests do not auto-create drafts
- cooldown suppresses duplicate auto-drafts

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-automation-policy.test.ts
```

Expected: FAIL because the trusted-vendor policy module does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/vendor-automation-policy.ts` with:
- trusted-vendor allowlist logic
- confidence/actionability gating
- cooldown decision helpers

Update any scheduled ordering entrypoint in `ops-manager.ts` to consult this layer before creating drafts.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-automation-policy.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/vendor-automation-policy.ts src/lib/purchasing/vendor-automation-policy.test.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(purchasing): add trusted vendor automation policy"
```

---

### Task 8: Persist vendor watermarks and recent learned mappings

**Files:**
- Create: `src/lib/storage/purchasing-automation-state.ts`
- Create: `src/lib/storage/purchasing-automation-state.test.ts`
- Create: `migrations/003_purchasing_automation_state.sql`
- Reference: existing Supabase storage helpers in `src/lib/storage/`

**Step 1: Write the failing test**

Create tests that verify persistence helpers can:
- read/write last processed order watermark per vendor
- store last successful mapping sync
- store cooldown state for recent draft creation
- return bounded recent state without scanning all history

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/storage/purchasing-automation-state.test.ts
```

Expected: FAIL because the storage helper does not exist yet.

**Step 3: Write minimal implementation**

Add:
- migration for a compact per-vendor automation state table
- storage helper module with CRUD methods for:
  - watermarks
  - cooldown timestamps
  - optional last verified cart/order identifiers

Keep schema focused and incremental.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/storage/purchasing-automation-state.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add migrations/003_purchasing_automation_state.sql src/lib/storage/purchasing-automation-state.ts src/lib/storage/purchasing-automation-state.test.ts
git commit -m "feat(purchasing): persist vendor automation state"
```

---

### Task 9: Refactor ULINE and Axiom flows to consume assessed manifests

**Files:**
- Modify: `src/cli/order-uline.ts`
- Modify: `src/app/api/dashboard/purchasing/uline-order/route.ts`
- Modify: `src/lib/purchasing/axiom-scanner.ts`
- Modify: `src/lib/axiom/client.ts`
- Create: `src/lib/purchasing/vendor-manifest.test.ts`
- Create: `src/lib/purchasing/vendor-manifest.ts`

**Step 1: Write the failing test**

Create tests that verify:
- assessed lines convert into vendor manifests cleanly
- `hold` / `manual_review` lines are excluded from online ordering
- vendor-specific quantity conversion only happens after shared assessment

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-manifest.test.ts
```

Expected: FAIL because the shared manifest layer does not exist yet.

**Step 3: Write minimal implementation**

Create `src/lib/purchasing/vendor-manifest.ts` to transform assessed lines into vendor-ready manifests.

Refactor ULINE and Axiom flows so:
- they consume assessed manifests
- they stop relying on raw `suggestedQty` alone
- they preserve existing cart verification / invoice sync behavior

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-manifest.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts src/lib/purchasing/axiom-scanner.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/vendor-manifest.ts src/lib/purchasing/vendor-manifest.test.ts src/cli/order-uline.ts src/app/api/dashboard/purchasing/uline-order/route.ts src/lib/purchasing/axiom-scanner.ts src/lib/axiom/client.ts
git commit -m "refactor(purchasing): make vendor flows consume assessed manifests"
```

---

### Task 10: Scaffold Sustainable Village login-first cart automation

**Files:**
- Create: `src/lib/purchasing/sustainable-village-session.ts`
- Create: `src/lib/purchasing/sustainable-village-ordering.ts`
- Create: `src/lib/purchasing/sustainable-village-cart-live.ts`
- Create: `src/lib/purchasing/sustainable-village-ordering.test.ts`
- Create: `src/cli/order-sustainable-village.ts`
- Create: `src/app/api/dashboard/purchasing/sustainable-village-order/route.ts`

**Step 1: Write the failing test**

Create tests for:
- vendor mapping / manifest formatting
- cart verification shape
- route-level refusal when mapping is incomplete
- guarantee that checkout submission is never called in v1

Keep browser interactions mocked at this stage; do not make the first tests depend on live login.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/sustainable-village-ordering.test.ts
```

Expected: FAIL because the modules do not exist yet.

**Step 3: Write minimal implementation**

Add:
- login/session bootstrap using Playwright
- vendor manifest converter reusing the shared assessed manifest input
- cart scraper/verifier shape parallel to ULINE
- CLI and dashboard route that stop at verified cart creation

Do not implement checkout submission.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/sustainable-village-ordering.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/sustainable-village-session.ts src/lib/purchasing/sustainable-village-ordering.ts src/lib/purchasing/sustainable-village-cart-live.ts src/lib/purchasing/sustainable-village-ordering.test.ts src/cli/order-sustainable-village.ts src/app/api/dashboard/purchasing/sustainable-village-order/route.ts
git commit -m "feat(purchasing): add sustainable village cart automation scaffold"
```

---

### Task 11: Add recency-bounded vendor history ingestion helpers

**Files:**
- Create: `src/lib/purchasing/vendor-history-window.ts`
- Create: `src/lib/purchasing/vendor-history-window.test.ts`
- Modify: `src/lib/axiom/client.ts`
- Modify: `src/cli/order-uline.ts`

**Step 1: Write the failing test**

Create tests that verify:
- normal runs use a bounded lookback window
- deep history requires an explicit override
- watermark + lookback combine correctly
- stale vendor history is not reprocessed by default

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-history-window.test.ts
```

Expected: FAIL because the bounded-history helper does not exist yet.

**Step 3: Write minimal implementation**

Create helper utilities that compute effective vendor history windows from:
- watermark
- default lookback
- manual override

Refactor vendor clients/CLI entrypoints to use the helper instead of open-ended history scans.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run src/lib/purchasing/vendor-history-window.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/vendor-history-window.ts src/lib/purchasing/vendor-history-window.test.ts src/lib/axiom/client.ts src/cli/order-uline.ts
git commit -m "perf(purchasing): bound vendor history scans by watermark"
```

---

### Task 12: Run focused verification and document operational behavior

**Files:**
- Modify: `docs/SYSTEM.md`
- Modify: `docs/STATUS.md`

**Step 1: Run focused test suite**

Run:

```bash
npx vitest run src/lib/purchasing/policy-types.test.ts src/lib/purchasing/policy-engine.test.ts src/lib/purchasing/policy-candidates.test.ts src/lib/purchasing/assessment-service.test.ts src/lib/purchasing/draft-po-policy.test.ts src/lib/purchasing/vendor-automation-policy.test.ts src/lib/storage/purchasing-automation-state.test.ts src/lib/purchasing/vendor-manifest.test.ts src/lib/purchasing/sustainable-village-ordering.test.ts src/lib/purchasing/vendor-history-window.test.ts src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts
```

Expected: PASS

**Step 2: Run import/type smoke where practical**

Run:

```bash
npx tsc --noEmit
```

If full repo typecheck times out again, run a scoped smoke pass over the changed purchasing modules and record that honestly.

**Step 3: Document the new system**

Update docs to explain:
- shared policy usage
- trusted vendor auto-draft boundary
- manual draft creation availability for all vendors
- recency/watermark behavior
- Sustainable Village cart-review scope

**Step 4: Commit**

```bash
git add docs/SYSTEM.md docs/STATUS.md
git commit -m "docs(purchasing): document shared intelligence workflow"
```

---

Plan complete and saved to `docs/plans/2026-03-30-shared-purchasing-intelligence.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
