# ULINE Order Unit Conversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep Finale quantities in eaches, convert them to ULINE vendor order units only at cart-fill time, add pack-size and cost guardrails, and unify the ULINE Playwright logic used by the CLI and dashboard.

**Architecture:** Build a pure ULINE rules/conversion layer first, then refactor the browser automation into a shared session module consumed by both the CLI and dashboard. Finalize by wiring guardrails and dual-view output so every order shows Finale eaches and ULINE order units side by side.

**Tech Stack:** TypeScript, Vitest, Playwright, Finale client, Next.js route handlers

---

### Task 1: Add failing tests for ULINE conversion rules

**Files:**
- Create: `src/lib/purchasing/uline-rules.test.ts`
- Create: `src/lib/purchasing/uline-rules.ts`

**Step 1: Write the failing test**

Add tests for:
- `S-3902` using `packSize=1000`
- `S-4092` using `packSize=25`
- `S-4128` using `packSize=25`
- default rule lookup failure for unknown bundle SKU

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/uline-rules.test.ts`
Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Add a rules table with:
- `packSize`
- `roundingMode`
- `maxOrderEaches`
- optional `maxOrderUnits`
- optional `costDeviationPct`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/uline-rules.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/uline-rules.ts src/lib/purchasing/uline-rules.test.ts
git commit -m "test: add ULINE order unit rules"
```

### Task 2: Add failing tests for Finale→ULINE conversion and guardrails

**Files:**
- Create: `src/lib/purchasing/uline-conversion.test.ts`
- Create: `src/lib/purchasing/uline-conversion.ts`

**Step 1: Write the failing test**

Add tests for:
- converting Finale eaches into ULINE order units
- rounding up boxes to the nearest valid bundle
- flagging cap violations
- flagging excessive implied cost deviation

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/uline-conversion.test.ts`
Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Add pure helpers that return a dual-view result:
- Finale eaches
- ULINE order units
- implied ordered eaches
- overage
- guardrail violations

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/uline-conversion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/uline-conversion.ts src/lib/purchasing/uline-conversion.test.ts
git commit -m "test: add ULINE conversion and guardrails"
```

### Task 3: Add failing tests for dry-run formatting

**Files:**
- Create: `src/cli/order-uline-format.test.ts`
- Create: `src/cli/order-uline-format.ts`

**Step 1: Write the failing test**

Add tests showing dry-run output includes both:
- Finale qty in eaches
- ULINE qty in vendor order units
- rounding overage when applicable

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/order-uline-format.test.ts`
Expected: FAIL because formatter module does not exist.

**Step 3: Write minimal implementation**

Add a formatter that produces stable dry-run lines from converted order items.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/order-uline-format.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/order-uline-format.ts src/cli/order-uline-format.test.ts
git commit -m "test: add ULINE dry-run dual-view formatting"
```

### Task 4: Add failing tests for shared Playwright session contract

**Files:**
- Create: `src/lib/purchasing/uline-session.test.ts`
- Create: `src/lib/purchasing/uline-session.ts`

**Step 1: Write the failing test**

Add tests for:
- successful session result shape
- login-needed path
- add-to-cart not found path
- cart scraping result handoff

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/uline-session.test.ts`
Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Extract shared session helpers for:
- context launch
- login detection
- Quick Order navigation
- add-to-cart action
- cart scraping handoff

Do not rewrite every selector yet; only centralize the behavior.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/uline-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/uline-session.ts src/lib/purchasing/uline-session.test.ts
git commit -m "test: add shared ULINE Playwright session contract"
```

### Task 5: Wire conversion into the CLI flow

**Files:**
- Modify: `src/cli/order-uline.ts`
- Modify: `src/cli/order-uline-cart.ts`
- Test: `src/lib/purchasing/uline-conversion.test.ts`
- Test: `src/cli/order-uline-format.test.ts`

**Step 1: Write the failing test**

Extend conversion or formatter tests to prove:
- CLI uses converted vendor units for cart fill
- CLI preserves Finale eaches in reporting
- cap violations block send

**Step 2: Run test to verify it fails**

Run:
- `npx vitest run src/lib/purchasing/uline-conversion.test.ts src/cli/order-uline-format.test.ts`

Expected: FAIL because CLI still uses raw Finale quantities.

**Step 3: Write minimal implementation**

Update `order-uline.ts` so:
- PO/manifests remain in Finale eaches
- cart fill receives converted ULINE units
- dry-run shows both views
- cart verification compares against converted vendor units
- guardrails stop unsafe sends

**Step 4: Run test to verify it passes**

Run:
- `npx vitest run src/lib/purchasing/uline-conversion.test.ts src/cli/order-uline-format.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/order-uline.ts src/cli/order-uline-cart.ts src/lib/purchasing/uline-conversion.ts src/cli/order-uline-format.ts
git commit -m "feat: convert Finale eaches to ULINE vendor order units"
```

### Task 6: Fix ULINE draft PO listing and integrate the shared browser session

**Files:**
- Modify: `src/cli/order-uline.ts`
- Modify: `src/app/api/dashboard/purchasing/uline-order/route.ts`
- Modify: `src/lib/purchasing/uline-session.ts`
- Test: `src/lib/purchasing/uline-session.test.ts`

**Step 1: Write the failing test**

Add tests for:
- GraphQL draft listing using Finale `status`
- dashboard route using shared session contract instead of bespoke browser logic

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/uline-session.test.ts`
Expected: FAIL because the dashboard route and CLI are still split or the query still uses the old field.

**Step 3: Write minimal implementation**

Change:
- CLI draft listing query from `statusId` to `status`
- dashboard ULINE route to consume shared conversion + session helpers
- remove duplicated add-to-cart flow where replacement is live

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/uline-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/order-uline.ts src/app/api/dashboard/purchasing/uline-order/route.ts src/lib/purchasing/uline-session.ts
git commit -m "refactor: unify ULINE browser flow across CLI and dashboard"
```

### Task 7: Run focused verification and broad regression

**Files:**
- Modify: `docs/STATUS.md`

**Step 1: Run focused tests**

Run:
- `npx vitest run src/lib/purchasing/uline-rules.test.ts src/lib/purchasing/uline-conversion.test.ts src/cli/order-uline-format.test.ts src/lib/purchasing/uline-session.test.ts`

Expected: PASS

**Step 2: Run broader regression**

Run:
- `npm test`
- `git diff --exit-code -- src/lib/slack/watchdog.ts`

Expected:
- repo suite PASS
- Slack watchdog unchanged

**Step 3: Sanity-check the ULINE dry-run**

Run:
- `node --import tsx src/cli/order-uline.ts --po 124554 --dry-run`

Expected:
- output shows both Finale eaches and ULINE order units
- rounded box quantities are explicit
- no live browser launch

**Step 4: Update status docs**

Record the ULINE unit-conversion and shared browser-flow changes in `docs/STATUS.md`.

**Step 5: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs: record ULINE unit conversion rollout"
```
