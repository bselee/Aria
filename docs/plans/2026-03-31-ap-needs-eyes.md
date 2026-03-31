# AP Needs Eyes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a compact `Needs Eyes` AP intake summary to the existing AP / Invoices panel without adding a new panel or cluttering the invoice list.

**Architecture:** Extend the existing invoice queue API to aggregate two AP manual-review reason codes from `ap_activity_log`, then render a single conditional header badge in the existing invoice queue panel. Keep this as summary-only UI, with no new row section and no Gmail actions.

**Tech Stack:** Next.js route handlers, React client components, Supabase query layer, Vitest

---

### Task 1: Extend invoice queue response types with `needsEyes`

**Files:**
- Modify: `src/app/api/dashboard/invoice-queue/route.ts`
- Test: `src/app/api/dashboard/invoice-queue/route.test.ts`

**Step 1: Write the failing test**

Add or extend API route tests to expect:
- `needsEyes.missingPdf`
- `needsEyes.humanInteraction`

Use mocked `ap_activity_log` rows so the response shape is asserted explicitly.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`

Expected: FAIL because the response does not yet include `needsEyes`.

**Step 3: Write minimal implementation**

In `route.ts`:
- extend `InvoiceQueueResponse` with:

```ts
needsEyes: {
    missingPdf: number;
    humanInteraction: number;
};
```

- initialize the response with zero counts

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`

Expected: PASS for the new response-shape assertions.

**Step 5: Commit**

```bash
git add src/app/api/dashboard/invoice-queue/route.ts src/app/api/dashboard/invoice-queue/route.test.ts
git commit -m "feat(ap): add needs-eyes response shape"
```

### Task 2: Aggregate AP manual-review reason codes in the API

**Files:**
- Modify: `src/app/api/dashboard/invoice-queue/route.ts`
- Test: `src/app/api/dashboard/invoice-queue/route.test.ts`

**Step 1: Write the failing test**

Add a test that mocks recent `ap_activity_log` rows with:
- `metadata.reasonCode = "missing_pdf_manual_review"`
- `metadata.reasonCode = "human_interaction_manual_review"`

Assert the route returns the correct counts in `needsEyes`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`

Expected: FAIL because the route does not yet compute these counts.

**Step 3: Write minimal implementation**

In `route.ts`:
- query recent `ap_activity_log` rows needed for the summary
- inspect `metadata.reasonCode`
- count:
  - `missing_pdf_manual_review`
  - `human_interaction_manual_review`
- return those counts under `needsEyes`

Keep the query tight and summary-only; do not add row payloads to the response.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts`

Expected: PASS with correct `needsEyes` counts.

**Step 5: Commit**

```bash
git add src/app/api/dashboard/invoice-queue/route.ts src/app/api/dashboard/invoice-queue/route.test.ts
git commit -m "feat(ap): summarize needs-eyes intake counts"
```

### Task 3: Render the compact header badge in the AP / Invoices panel

**Files:**
- Modify: `src/components/dashboard/InvoiceQueuePanel.tsx`
- Test: `src/components/dashboard/InvoiceQueuePanel.test.tsx`

**Step 1: Write the failing test**

Add component tests that:
- do not render a `Needs Eyes` badge when both counts are zero
- render a single compact badge when counts are present
- show only human-friendly labels like `PDF` and `HUMAN`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx`

Expected: FAIL because the panel does not yet render the badge.

**Step 3: Write minimal implementation**

In `InvoiceQueuePanel.tsx`:
- consume `needsEyes` from the API response
- compute the total count
- render a compact header badge only when total > 0
- keep it visually quieter than `PENDING`

Example shape:

```tsx
{needsEyesTotal > 0 && (
  <span>Needs Eyes {needsEyes.missingPdf} PDF {needsEyes.humanInteraction} HUMAN</span>
)}
```

Refine the styling to match the existing header badges.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/dashboard/InvoiceQueuePanel.test.tsx`

Expected: PASS for both hidden and visible badge states.

**Step 5: Commit**

```bash
git add src/components/dashboard/InvoiceQueuePanel.tsx src/components/dashboard/InvoiceQueuePanel.test.tsx
git commit -m "feat(ap): show compact needs-eyes badge"
```

### Task 4: Verify the full AP panel path

**Files:**
- Verify only:
  - `src/app/api/dashboard/invoice-queue/route.ts`
  - `src/components/dashboard/InvoiceQueuePanel.tsx`
  - related tests

**Step 1: Run focused verification**

Run:

```bash
npx vitest run src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx src/lib/intelligence/workers/ap-identifier-policy.test.ts
```

Expected: PASS with zero failures.

**Step 2: Run import smoke if needed**

Run:

```bash
npx tsx -e "import './src/app/api/dashboard/invoice-queue/route.ts'; import './src/components/dashboard/InvoiceQueuePanel.tsx'; console.log('import-smoke-ok')"
```

Expected: `import-smoke-ok`

**Step 3: Commit**

```bash
git add src/app/api/dashboard/invoice-queue/route.ts src/components/dashboard/InvoiceQueuePanel.tsx src/app/api/dashboard/invoice-queue/route.test.ts src/components/dashboard/InvoiceQueuePanel.test.tsx
git commit -m "feat(ap): surface needs-eyes summary in invoice panel"
```
