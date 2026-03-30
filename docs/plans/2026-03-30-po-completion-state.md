# PO Completion State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create one shared PO completion state that only marks a PO complete when receipt, AP reconciliation, and freight/invoice resolution all agree.

**Architecture:** Add a shared purchasing-state helper that derives completion from Finale PO data plus recent AP reconciliation activity. Reuse it from the purchasing calendar, dashboard active-purchases flow, and PO-received watcher so all surfaces agree about what still needs work. Do not trust Finale `Completed` alone.

**Tech Stack:** TypeScript, Vitest, Supabase, Finale client, existing AP reconciliation metadata

---

### Task 1: Add failing tests for PO completion derivation

**Files:**
- Create: `src/lib/purchasing/po-completion-state.test.ts`
- Modify: `src/lib/purchasing/calendar-lifecycle.test.ts`

**Step 1: Write the failing test**

Add tests for:
- Finale received but no AP reconciliation -> `received_pending_invoice`
- AP reconciliation exists with `needs_approval` -> `received_pending_reconciliation`
- tracking delivered but not received -> `delivered_awaiting_receipt`
- received + reconciled + freight resolved + no blockers -> `complete`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/po-completion-state.test.ts`

Expected: FAIL because the completion-state helper does not exist yet.

**Step 3: Write minimal implementation**

Create the smallest shared helper that accepts PO/AP signals and returns the derived state.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/po-completion-state.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/po-completion-state.ts src/lib/purchasing/po-completion-state.test.ts src/lib/purchasing/calendar-lifecycle.test.ts
git commit -m "feat(purchasing): derive shared PO completion state"
```

### Task 2: Add a shared AP signal loader

**Files:**
- Create: `src/lib/purchasing/po-completion-loader.ts`
- Test: `src/lib/purchasing/po-completion-loader.test.ts`
- Reference: `src/lib/finale/reconciler.ts`, `src/lib/intelligence/ap-agent.ts`

**Step 1: Write the failing test**

Add tests that verify the loader can summarize recent AP activity into completion inputs:
- latest reconciliation verdict by `orderId`
- whether invoice matched
- whether freight/fee changes were applied or still pending
- whether there are unresolved blockers

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/po-completion-loader.test.ts`

Expected: FAIL because the loader does not exist yet.

**Step 3: Write minimal implementation**

Build a small helper that reads `ap_activity_log` rows and extracts a normalized completion signal shape from existing metadata.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/po-completion-loader.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/po-completion-loader.ts src/lib/purchasing/po-completion-loader.test.ts
git commit -m "feat(purchasing): load AP completion signals from audit log"
```

### Task 3: Reuse the shared state in calendar sync and PO watcher

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Modify: `src/lib/purchasing/calendar-lifecycle.ts`
- Test: `src/lib/purchasing/calendar-lifecycle.test.ts`

**Step 1: Write the failing test**

Add tests around the lifecycle formatting/state mapping for:
- `received_pending_invoice`
- `received_pending_reconciliation`
- `complete`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/calendar-lifecycle.test.ts`

Expected: FAIL until the new states are wired in.

**Step 3: Write minimal implementation**

Wire the shared completion state into:
- purchasing calendar title/color/description
- immediate PO-received updater
- calendar retention rules

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/calendar-lifecycle.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts src/lib/purchasing/calendar-lifecycle.ts src/lib/purchasing/calendar-lifecycle.test.ts
git commit -m "feat(calendar): reflect shared PO completion state"
```

### Task 4: Reuse the shared state in the active-purchases API and dashboard

**Files:**
- Modify: `src/app/api/dashboard/active-purchases/route.ts`
- Modify: `src/components/dashboard/PurchasingCalendarPanel.tsx`

**Step 1: Write the failing test**

Add or update tests so the API/dashboard distinguishes:
- pending receipt
- pending invoice
- pending reconciliation
- fully complete

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/purchasing/po-completion-state.test.ts src/lib/purchasing/calendar-lifecycle.test.ts`

Expected: FAIL until the API/dashboard start using the shared state.

**Step 3: Write minimal implementation**

Stop duplicating local heuristics and use the shared state from the helper instead.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/purchasing/po-completion-state.test.ts src/lib/purchasing/calendar-lifecycle.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/app/api/dashboard/active-purchases/route.ts src/components/dashboard/PurchasingCalendarPanel.tsx
git commit -m "refactor(dashboard): reuse shared PO completion state"
```

### Task 5: Final verification and cleanup

**Files:**
- Review: `src/lib/purchasing/po-completion-state.ts`
- Review: `src/lib/purchasing/po-completion-loader.ts`
- Review: `src/lib/intelligence/ops-manager.ts`
- Review: `src/app/api/dashboard/active-purchases/route.ts`

**Step 1: Run focused verification**

Run:

```bash
npx vitest run src/lib/purchasing/po-completion-state.test.ts src/lib/purchasing/po-completion-loader.test.ts src/lib/purchasing/calendar-lifecycle.test.ts src/lib/scheduler/cron-registry.test.ts
```

Expected: PASS

**Step 2: Run diff sanity check**

Run:

```bash
git diff --check
```

Expected: no whitespace or conflict-marker errors

**Step 3: Commit**

```bash
git add docs/plans/2026-03-30-po-completion-state-design.md docs/plans/2026-03-30-po-completion-state.md
git commit -m "docs(purchasing): document shared PO completion state"
```
