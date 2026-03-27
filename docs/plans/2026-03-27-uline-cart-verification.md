# ULINE Cart Verification And Daily Summary Truthfulness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify ULINE cart contents before claiming success, sync verified prices back to the draft PO, and make the morning summary use explicit yesterday-only Finale slices.

**Architecture:** Extract small pure helpers for cart verification and daily-summary slicing, then wire the live Playwright and ops-manager flows to those helpers. Keep checkout manual and keep changes tightly scoped to truthful state reporting and safe draft-PO updates.

**Tech Stack:** TypeScript, Vitest, Playwright, Finale client, Telegram bot notifications

---

### Task 1: Add failing tests for ULINE cart verification helpers

**Files:**
- Create: `src/cli/order-uline-cart.test.ts`
- Create: `src/cli/order-uline-cart.ts`

**Step 1: Write the failing test**

Add tests for:
- full verification when all expected models/qtys are present
- partial verification when one expected model is missing
- planning price updates only for verified rows with changed prices

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/order-uline-cart.test.ts`
Expected: FAIL because helper module does not exist or exported functions are missing.

**Step 3: Write minimal implementation**

Add pure helpers that:
- compare expected manifest items to observed cart rows
- return `verified`, `partial`, or `unverified`
- compute draft PO price updates only from verified rows

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/order-uline-cart.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/order-uline-cart.ts src/cli/order-uline-cart.test.ts
git commit -m "test: add ULINE cart verification helpers"
```

### Task 2: Add failing tests for daily-summary date slicing

**Files:**
- Create: `src/lib/intelligence/ops-summary-slices.test.ts`
- Create: `src/lib/intelligence/ops-summary-slices.ts`

**Step 1: Write the failing test**

Add tests for:
- filtering receivings to a target Denver date
- filtering committed POs to a target Denver date
- preserving week-to-date arrays separately from yesterday-only arrays

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/ops-summary-slices.test.ts`
Expected: FAIL because helper module does not exist or exported functions are missing.

**Step 3: Write minimal implementation**

Add pure date-slicing helpers that derive yesterday-only arrays from WTD Finale records.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/ops-summary-slices.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ops-summary-slices.ts src/lib/intelligence/ops-summary-slices.test.ts
git commit -m "test: add ops summary date slicing helpers"
```

### Task 3: Wire ULINE cart verification into the autonomous flow

**Files:**
- Modify: `src/cli/order-uline.ts`
- Test: `src/cli/order-uline-cart.test.ts`

**Step 1: Write the failing test**

Extend the helper test with the notification-facing message contract:
- verified cart returns verified wording
- partial cart returns review wording
- unverified cart returns manual verification wording

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/order-uline-cart.test.ts`
Expected: FAIL on missing message formatter or wrong status mapping.

**Step 3: Write minimal implementation**

In `order-uline.ts`:
- after add-to-cart, inspect the cart page
- classify cart verification
- sync verified price changes to the draft PO
- return structured verification status instead of a raw optimistic string

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/order-uline-cart.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/order-uline.ts src/cli/order-uline-cart.ts src/cli/order-uline-cart.test.ts
git commit -m "feat: verify ULINE cart before reporting success"
```

### Task 4: Wire explicit yesterday slices into ops-manager

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Test: `src/lib/intelligence/ops-summary-slices.test.ts`

**Step 1: Write the failing test**

Extend the slicing test or add a focused prompt-data test proving that a daily summary payload separates:
- `finale_receivings_wtd`
- `finale_receivings_yesterday`
- `finale_committed_wtd`
- `finale_committed_yesterday`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/ops-summary-slices.test.ts`
Expected: FAIL because the payload shape is missing the new fields.

**Step 3: Write minimal implementation**

Update `ops-manager.ts` to:
- keep WTD arrays for totals
- derive yesterday-only arrays with the helper
- update the daily prompt so it uses explicit yesterday slices

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/ops-summary-slices.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts src/lib/intelligence/ops-summary-slices.ts src/lib/intelligence/ops-summary-slices.test.ts
git commit -m "fix: ground daily summary in explicit yesterday slices"
```

### Task 5: Run focused verification and broad regression

**Files:**
- Modify: `docs/STATUS.md`

**Step 1: Run focused tests**

Run:
- `npx vitest run src/cli/order-uline-cart.test.ts src/lib/intelligence/ops-summary-slices.test.ts`

Expected: PASS

**Step 2: Run broader regression**

Run:
- `npm test`
- `git diff --exit-code -- src/lib/slack/watchdog.ts`

Expected:
- repo test suite PASS
- Slack watchdog remains untouched

**Step 3: Update status docs**

Record the ULINE cart verification and daily-summary truthfulness changes in `docs/STATUS.md`.

**Step 4: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs: record ULINE verification and summary slice fixes"
```
