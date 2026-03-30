# Generic AP Review Corpus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the generic AP invoice path and scaffold a reviewed invoice corpus in Supabase without expanding vendor-specific parser architecture.

**Architecture:** Keep Gmail plus Supabase as the intake/archive flow, tighten OCR retry gating in `ap-agent.ts`, and add a small review-corpus helper layer on top of `vendor_invoices` for human-verified invoice truth and retry evidence.

**Tech Stack:** TypeScript, Vitest, Supabase, Gmail-based AP pipeline

---

### Task 1: Lock The Retry Behavior With Tests

**Files:**
- Modify: `src/lib/intelligence/ap-agent.test.ts`
- Test: `src/lib/intelligence/ap-agent.test.ts`

**Step 1: Write the failing tests**

Add tests for:
- a retried invoice that remains `confidence: "low"` but has a usable PO and line items, and should continue past the old low-confidence gate
- a non-suspicious invoice with ordinary freight/tax that should not trigger OCR retry

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts`
Expected: FAIL on the new retry-gating assertions

**Step 3: Write minimal implementation**

Update `processInvoiceBuffer()` to:
- compute retry reasons in a dedicated helper
- narrow suspicious signals to real extraction failures
- skip the low-confidence early return when deterministic evidence is now strong enough after retry

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts`
Expected: PASS

### Task 2: Reduce One-Off Parser Bias In Invoice Parsing

**Files:**
- Modify: `src/lib/pdf/invoice-parser.ts`
- Test: `src/lib/pdf/invoice-parser.test.ts`
- Test: `src/test/gold-sample-invoices.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- generic PO extraction works without relying on a vendor parser
- shipping/freight normalization still works generically
- gold-sample tests do not require a named vendor parser path

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pdf/invoice-parser.test.ts src/test/gold-sample-invoices.test.ts`
Expected: FAIL if generic behavior still depends on one-off parser logic

**Step 3: Write minimal implementation**

Refactor `invoice-parser.ts` to:
- keep deterministic generic extraction
- remove or reduce vendor-specific parser logic if the generic path covers the same fields
- preserve freight de-duplication and OCR-noise correction

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pdf/invoice-parser.test.ts src/test/gold-sample-invoices.test.ts`
Expected: PASS

### Task 3: Scaffold Reviewed Invoice Corpus Helpers

**Files:**
- Create: `src/lib/storage/invoice-review-corpus.ts`
- Create: `src/lib/storage/invoice-review-corpus.test.ts`

**Step 1: Write the failing test**

Add tests for helper payload shaping that:
- records reviewed critical fields
- records first-pass and retry extraction summaries
- links back to `vendor_invoices` and Supabase storage paths

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/storage/invoice-review-corpus.test.ts`
Expected: FAIL because the helper does not exist yet

**Step 3: Write minimal implementation**

Create a storage helper that prepares and writes review-corpus records with:
- invoice reference fields
- reviewed truth fields
- extraction evidence fields
- review status metadata

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/storage/invoice-review-corpus.test.ts`
Expected: PASS

### Task 4: Verify The Generic AP Slice

**Files:**
- Verify only

**Step 1: Run targeted tests**

Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts src/lib/pdf/invoice-parser.test.ts src/test/gold-sample-invoices.test.ts src/lib/finale/reconciler.test.ts src/lib/storage/invoice-review-corpus.test.ts`
Expected: PASS

**Step 2: Review related diffs**

Check that:
- retry logic is generic
- no unnecessary vendor-specific architecture remains
- review corpus scaffolding does not disturb live AP intake

**Step 3: Summarize remaining follow-up**

Document any next-step migration or AP email backfill work separately instead of expanding this slice.
