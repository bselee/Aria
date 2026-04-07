# AP Reconciliation Surgical Updates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow AP reconciliation to auto-apply tiny, exact committed-PO corrections under strict guardrails, while simplifying the AP / Invoices dashboard into an action-first work queue.

**Architecture:** Extend the existing reconciliation engine rather than adding a second workflow. A new AP-reconciliation write permission will authorize only exact committed-PO adjustments, the reconciler will classify quantity/price/freight edits against explicit thresholds, and the invoice queue API/UI will render concise action cards from the server-shaped result.

**Tech Stack:** Next.js, TypeScript, React, Supabase, Vitest

---

### Task 1: Document and test the new AP reconciliation write permission

**Files:**
- Modify: `src/lib/finale/write-access.ts`
- Modify: `src/lib/finale/write-access.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- `ap_reconciliation:update_committed_po` is allowed
- `ap_reconciliation:create_draft_po` is denied
- existing dashboard write permissions still pass

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/write-access.test.ts`
Expected: FAIL because the new AP reconciliation action is not yet allowed.

**Step 3: Write minimal implementation**

Extend the allowlist with the single approved AP reconciliation write action and keep all unrelated write actions denied.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/write-access.test.ts`
Expected: PASS

### Task 2: Add quantity-change classification to reconciliation

**Files:**
- Modify: `src/lib/finale/reconciler.ts`
- Modify: `src/lib/finale/reconciler.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- exact mapped quantity deltas `<= 5%` classify as auto-approvable
- quantity deltas `> 5%` force `needs_approval`
- weak or overbilled quantity mismatches still require review

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: FAIL because quantity changes are not yet first-class guarded updates.

**Step 3: Write minimal implementation**

Extend the reconciliation result model to capture quantity changes explicitly and classify them with the new `<= 5%` guardrail.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: PASS

### Task 3: Allow surgical committed-PO apply only for exact AP reconciliation writes

**Files:**
- Modify: `src/lib/finale/reconciler.ts`
- Modify: `src/lib/finale/client.ts`
- Modify: `src/lib/finale/client.test.ts`
- Modify: `src/lib/finale/reconciler.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- committed-PO reconciliation updates use `{ source: "ap_reconciliation", action: "update_committed_po" }`
- allowed small price/quantity/freight changes apply
- unapproved or oversized changes remain non-mutating

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/client.test.ts src/lib/finale/reconciler.test.ts`
Expected: FAIL because the reconciliation apply path does not yet use the new write permission or quantity guard.

**Step 3: Write minimal implementation**

Thread the AP reconciliation write context through the exact Finale mutation calls used by `applyReconciliation(...)`, and keep all writes field-targeted and minimal.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/client.test.ts src/lib/finale/reconciler.test.ts`
Expected: PASS

### Task 4: Tighten fallback notes for dashboard review

**Files:**
- Modify: `src/lib/finale/reconciler.ts`
- Modify: `src/lib/finale/reconciler.test.ts`

**Step 1: Write the failing test**

Add tests proving review-required results carry concise operator notes such as:

- `Invoice > PO correlation needs approval`
- `Qty delta exceeded 5%`
- `Price delta exceeded 5%`
- `Freight adjustment requires review`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: FAIL because the notes are still too verbose or inconsistent.

**Step 3: Write minimal implementation**

Normalize review fallback notes into a short action-facing message field without removing existing detailed reporting.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: PASS

### Task 5: Reshape the invoice queue API into action-first buckets

**Files:**
- Modify: `src/app/api/dashboard/invoice-queue/route.ts`
- Modify: `src/app/api/dashboard/invoice-queue/route.test.ts`

**Step 1: Write the failing test**

Add tests proving the API returns:

- actionable review items
- recent auto-applied items
- exception items
- compact notes and diff summaries for each actionable invoice

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`
Expected: FAIL because the route still returns a flatter, status-heavy payload.

**Step 3: Write minimal implementation**

Refactor the route response shape so the panel can render action-first groups without duplicating reconciliation logic client-side.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`
Expected: PASS

### Task 6: Simplify the AP / Invoices dashboard panel

**Files:**
- Modify: `src/components/dashboard/InvoiceQueuePanel.tsx`
- Add or modify tests if present for this panel

**Step 1: Write the failing test**

Add tests proving the panel:

- prioritizes `Needs Approval`
- shows concise diffs and notes
- exposes only the small action set
- de-emphasizes stale noise and non-actionable detail

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx`
Expected: FAIL because the panel is still status-heavy and less action-oriented.

**Step 3: Write minimal implementation**

Refactor the panel into an action-first work queue:

- top bucket: approval-needed items
- secondary bucket: recent auto-applied items
- secondary bucket: exceptions

Keep details expandable but not dominant.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx`
Expected: PASS

### Task 7: Verify non-AP write paths remain fail-closed

**Files:**
- Verify: existing non-dashboard call sites under `src/cli/`, `src/lib/intelligence/`, `src/lib/slack/`, `src/lib/axiom/`
- Add one focused regression test if needed

**Step 1: Write the failing test**

If needed, add a focused regression test showing non-dashboard draft creation or commit paths remain denied without the new AP reconciliation write action.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/client.test.ts`
Expected: FAIL only if a new regression test is added.

**Step 3: Write minimal implementation**

Only make small updates needed to keep denied callers explicit and honest. Do not broaden permissions beyond dashboard PO creation/commit and AP reconciliation surgical updates.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/client.test.ts`
Expected: PASS

### Task 8: Run focused verification

**Files:**
- Verify: `src/lib/finale/write-access.test.ts`
- Verify: `src/lib/finale/client.test.ts`
- Verify: `src/lib/finale/reconciler.test.ts`
- Verify: `src/app/api/dashboard/invoice-queue/route.test.ts`
- Verify: `src/components/dashboard/InvoiceQueuePanel.test.tsx`
- Verify: `src/app/api/dashboard/purchasing/route.test.ts`
- Verify: `src/app/api/dashboard/purchasing/commit/route.test.ts`

**Step 1: Run focused tests**

Run: `npx vitest run src/lib/finale/write-access.test.ts src/lib/finale/client.test.ts src/lib/finale/reconciler.test.ts src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts`
Expected: PASS

**Step 2: Run type verification**

Run: `npx tsc --noEmit --project tsconfig.cli.json`
Expected: exit 0, or document timeout explicitly if this environment still stalls.

**Step 3: Commit**

```bash
git add docs/plans/2026-04-07-ap-reconciliation-surgical-updates-design.md docs/plans/2026-04-07-ap-reconciliation-surgical-updates.md src/lib/finale/write-access.ts src/lib/finale/write-access.test.ts src/lib/finale/reconciler.ts src/lib/finale/reconciler.test.ts src/lib/finale/client.ts src/lib/finale/client.test.ts src/app/api/dashboard/invoice-queue/route.ts src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.tsx src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts
git commit -m "Add surgical AP reconciliation updates"
```
