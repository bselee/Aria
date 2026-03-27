# AAA Cooper Statement Filter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten AAA Cooper statement splitting so only real invoice pages are forwarded and Telegram reports how many non-invoice pages were discarded.

**Architecture:** Keep the existing multi-invoice statement split flow, but add a vendor-specific post-filter that validates invoice pages using hard text rules after the LLM’s first-pass page classification. This minimizes risk to other vendors and makes the operator summary more trustworthy.

**Tech Stack:** TypeScript, Vitest, Gmail API, Supabase Storage, existing AP statement splitter

---

### Task 1: Add AAA Cooper Invoice-Page Validator Tests

**Files:**
- Create: `src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
- Modify: `src/lib/intelligence/workers/ap-identifier.ts`

**Step 1: Write the failing test**

Add tests for:
- keeps a page with `INVOICE`, `PRO NUMBER`, and billing charges/total
- rejects a BOL/delivery receipt page with shipment data but no billing markers
- rejects an inspection/correction page that mentions freight context but lacks invoice fields

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
Expected: FAIL because the validator does not exist.

**Step 3: Write minimal implementation**

Extract a pure helper in `ap-identifier.ts` or a nearby helper file that:
- requires `INVOICE`
- accepts `PRO NUMBER` as the billing identifier for AAA Cooper
- requires billing amounts / rate / charge markers
- rejects common non-invoice paperwork markers

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts src/lib/intelligence/workers/ap-identifier.ts
git commit -m "feat: tighten aaa cooper invoice page filtering"
```

### Task 2: Filter Split Pages And Improve Telegram Summary

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.ts`
- Test: `src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`

**Step 1: Write the failing test**

Add a test that simulates mixed statement results and asserts:
- only validated invoice pages are retained
- rejected invoice-like pages count as discarded paperwork
- Telegram summary text includes both kept invoice count and discarded page count

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
Expected: FAIL because the current summary reports only invoice count.

**Step 3: Write minimal implementation**

Update `handleMultiInvoiceStatement` so it:
- applies the AAA Cooper validator to LLM-selected invoice pages
- computes `discardedCount`
- updates logs and Telegram summary to say `Split X invoice(s); discarded Y non-invoice page(s)`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts
git commit -m "feat: report discarded aaa cooper statement pages"
```

### Task 3: Verify Targeted And Full Safety

**Files:**
- Modify: `docs/STATUS.md` if rollout note is needed

**Step 1: Run targeted verification**

Run:
- `npx vitest run src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
- `npm test`

Expected:
- new AAA Cooper tests PASS
- full repo test suite remains green

**Step 2: Run compiler sanity for touched files**

Run:
- `@'`
- `$matches = node ..\\..\\node_modules\\typescript\\bin\\tsc --noEmit 2>&1 | Select-String -Pattern 'ap-identifier|statement-filter'`
- `if ($matches) { $matches | ForEach-Object { $_.Line }; exit 1 } else { Write-Output 'NO_MATCHES' }`
- `'@ | powershell -NoProfile -Command -`

Expected:
- `NO_MATCHES`

**Step 3: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts docs/STATUS.md
git commit -m "fix: filter aaa cooper paperwork from statement splits"
```
