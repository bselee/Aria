# Dashboard Ops Panels Adjustments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the AP/Invoices, Ordering, and Receivings dashboard panels behave like reliable operational work surfaces instead of partial status displays.

**Architecture:** Tighten each panel around a single operational purpose. AP/Invoices becomes a true actionable queue driven by latest review state, Ordering stays action-focused but gets verification and clearer state refresh, and Receivings becomes a warehouse-status panel with full/partial receipt detail and reception timing.

**Tech Stack:** Next.js App Router, React client components, Supabase, Finale client APIs, Vitest

---

### Task 1: Lock the intended purpose of each panel into tests

**Files:**
- Modify: `src/app/api/dashboard/invoice-queue/route.test.ts`
- Create: `src/components/dashboard/ReceivedItemsPanel.test.tsx`
- Modify: `src/app/api/dashboard/purchasing/route.test.ts`

**Step 1: Write the failing tests**

- Add AP queue tests that prove dismissed stale items do not remain in the actionable queue.
- Add Receivings tests that expect a full/partial badge and visible reception time when the API returns those fields.
- Add Ordering route/component tests that prove post-action refresh keeps vendor state accurate after draft/review/send flows.

**Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/ReceivedItemsPanel.test.tsx src/app/api/dashboard/purchasing/route.test.ts
```

Expected:
- AP queue test fails because dismissed items still appear.
- Receivings test fails because the panel/API does not yet expose the new fields.
- Ordering verification test fails if action state is not refreshed or surfaced cleanly.

**Step 3: Commit**

```bash
git add src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/ReceivedItemsPanel.test.tsx src/app/api/dashboard/purchasing/route.test.ts
git commit -m "test(dashboard): define ops panel behavior expectations"
```

### Task 2: Make AP/Invoices a real actionable queue

**Files:**
- Modify: `src/app/api/dashboard/invoice-queue/route.ts`
- Modify: `src/components/dashboard/InvoiceQueuePanel.tsx`
- Optional review: `src/app/api/dashboard/reconciliation-action/route.ts`

**Step 1: Write the failing test**

- Extend the AP queue route test to cover:
  - latest `reviewed_action = dismissed` hides the invoice from the queue
  - latest `reviewed_action = approved` hides the invoice from the queue
  - unresolved/manual-review items still appear

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts
```

Expected:
- FAIL showing queue still includes items with finalized review actions.

**Step 3: Write minimal implementation**

- In `invoice-queue/route.ts`, derive queue state from invoice rows plus the latest relevant AP activity log entry.
- Exclude rows whose latest linked action is finalized (`dismissed`, `approved`, `rejected`) from the actionable queue.
- Keep `needsEyes` counts as a separate signal, not mixed into actionable invoices.
- In `InvoiceQueuePanel.tsx`, rename or restyle stale handling so it clearly means “remove from queue”.
- Refresh queue immediately after individual and bulk dismiss actions.

**Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx
```

Expected:
- PASS with dismissed stale items no longer rendered as queue work.

**Step 5: Commit**

```bash
git add src/app/api/dashboard/invoice-queue/route.ts src/components/dashboard/InvoiceQueuePanel.tsx src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx
git commit -m "fix(ap): make invoice queue reflect resolved review state"
```

### Task 3: Clarify AP panel copy and counts

**Files:**
- Modify: `src/components/dashboard/InvoiceQueuePanel.tsx`

**Step 1: Write the failing test**

- Add a component test that expects:
  - actionable count label language
  - stale section only for unresolved old items
  - “all clear” only when no actionable invoices remain

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx
```

Expected:
- FAIL because current copy/count logic is still tied to mixed queue/rest data.

**Step 3: Write minimal implementation**

- Update header copy so the panel reads like a work queue, not a mixed archive.
- Keep “Needs Eyes” visible, but separate from invoice-action counts.
- Ensure stale count is based only on unresolved pending items.

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add src/components/dashboard/InvoiceQueuePanel.tsx src/components/dashboard/InvoiceQueuePanel.test.tsx
git commit -m "refactor(ap): clarify invoice queue messaging"
```

### Task 4: Verify Ordering panel actions are functionally honest

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Modify: `src/app/api/dashboard/purchasing/route.test.ts`
- Modify: `src/app/api/dashboard/purchasing/uline-order/route.test.ts`
- Modify: `src/app/api/dashboard/purchasing/commit/route.ts`
- Modify: `src/app/api/dashboard/purchasing/commit/route.test.ts`

**Step 1: Write the failing tests**

- Add route tests for:
  - draft PO success/failure response shape
  - review endpoint returns review payload and does not silently succeed on missing PO
  - send endpoint returns explicit success/failure
  - ULINE order route returns explicit machine-usable status with error details when partial or failed

**Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts
```

Expected:
- FAIL if success/failure semantics are incomplete or inconsistent.

**Step 3: Write minimal implementation**

- Normalize action responses so the panel always gets:
  - `success`
  - `message`
  - action-specific identifiers (`orderId`, `sendId`, etc.)
  - error detail when action fails
- In `PurchasingPanel.tsx`, ensure action completion refreshes data and clears stale actionable states.
- Surface action results inline so operators can tell whether a draft/order/send really happened.

**Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add src/components/dashboard/PurchasingPanel.tsx src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.ts src/app/api/dashboard/purchasing/commit/route.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts
git commit -m "fix(ordering): harden purchasing action feedback"
```

### Task 5: Add Receivings operational detail

**Files:**
- Modify: `src/app/api/dashboard/receivings/route.ts`
- Modify: `src/components/dashboard/ReceivedItemsPanel.tsx`
- Create or modify tests: `src/components/dashboard/ReceivedItemsPanel.test.tsx`

**Step 1: Write the failing test**

- Add tests expecting each received PO row to support:
  - exact reception time when available
  - `FULL` or `PARTIAL` status
  - received quantity detail for partials

**Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/components/dashboard/ReceivedItemsPanel.test.tsx
```

Expected:
- FAIL because current route/panel do not compute or display these fields.

**Step 3: Write minimal implementation**

- Extend `receivings/route.ts` to normalize richer receiving fields from Finale if available:
  - `receiveDateTime`
  - `receiptStatus`
  - `receivedQuantity`
  - `orderedQuantity`
- In `ReceivedItemsPanel.tsx`, promote receipt status and time into the first row.
- For partials, show readable detail like `received 40 / 100`.
- Keep AP reconciliation status as a secondary badge.

**Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/components/dashboard/ReceivedItemsPanel.test.tsx
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add src/app/api/dashboard/receivings/route.ts src/components/dashboard/ReceivedItemsPanel.tsx src/components/dashboard/ReceivedItemsPanel.test.tsx
git commit -m "feat(receivings): show receipt status and reception time"
```

### Task 6: Tighten overall dashboard layout and panel ordering

**Files:**
- Modify: `src/app/dashboard/page.tsx`

**Step 1: Write the failing test**

- If there is no current layout test, add a focused test or snapshot covering default placement for:
  - Receivings in Ops column
  - AP/Invoices and Statement Reconciliation in AP column
  - Ordering in Purchasing column

**Step 2: Run test to verify it fails or expose missing coverage**

Run:
```bash
npx vitest run src/app/dashboard/page.test.tsx
```

Expected:
- Either FAIL or reveal that layout coverage does not exist yet.

**Step 3: Write minimal implementation**

- Keep panel grouping aligned to operational mental model:
  - Ops: Build risk, Receivings
  - AP: Invoice queue, Statement reconciliation, Active purchases
  - Purchasing: Ordering, Purchasing calendar
  - Right rail: Activity, Build schedule
- Add any missing migration logic for legacy localStorage layouts so new panel order is not lost.

**Step 4: Run tests to verify it passes**

Run:
```bash
npx vitest run src/app/dashboard/page.test.tsx
```

Expected:
- PASS or newly added coverage passes.

**Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/dashboard/page.test.tsx
git commit -m "refactor(dashboard): align ops panel layout with workflow"
```

### Task 7: Final verification pass

**Files:**
- No new files required

**Step 1: Run targeted verification**

Run:
```bash
npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts src/app/api/dashboard/purchasing/uline-order/route.test.ts src/components/dashboard/ReceivedItemsPanel.test.tsx src/app/api/dashboard/receivings/route.test.ts
```

Expected:
- All targeted dashboard tests pass.

**Step 2: Run smoke import/build-level verification**

Run:
```bash
npx tsx -e "import './src/app/dashboard/page.tsx'; import './src/components/dashboard/InvoiceQueuePanel.tsx'; import './src/components/dashboard/PurchasingPanel.tsx'; import './src/components/dashboard/ReceivedItemsPanel.tsx'; console.log('dashboard-panels-smoke-ok')"
```

Expected:
- `dashboard-panels-smoke-ok`

**Step 3: Commit**

```bash
git add -A
git commit -m "test(dashboard): verify ops panel adjustments"
```
