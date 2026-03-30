# Freight Threshold Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow legitimate high freight charges to flow through AP reconciliation without loosening OCR-sensitive product price approvals.

**Architecture:** Keep extraction and matching unchanged, keep product price approvals conservative, and refine only the fee-specific and total-impact logic in the reconciler so freight-heavy invoices are handled by fee-aware guardrails instead of broad percentage loosening.

**Tech Stack:** TypeScript, Vitest, Finale reconciler, AP CLI/dashboard callers

---

### Task 1: Write Freight Guardrail Tests

**Files:**
- Modify: `src/lib/finale/reconciler.test.ts`

**Step 1: Write the failing tests**

Add tests covering:
- large freight-only deltas within the freight cap stay auto-approvable
- large product-price deltas still require approval under conservative price thresholds

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: FAIL on the new freight-vs-price guardrail expectations

**Step 3: Write minimal implementation**

Update `reconciler.ts` to:
- keep product price thresholds conservative
- raise freight-specific fee allowance
- make total-impact gating ignore fee-only changes that already passed their fee-specific caps

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: PASS

### Task 2: Verify Table-Aware Invoice Parser Callers

**Files:**
- Modify: `src/app/api/dashboard/upload/route.ts`
- Modify: `src/cli/dump-uline-parsed.ts`
- Modify: `src/cli/inspect-uline-invoice.ts`
- Modify: `src/cli/run-ap-pipeline.ts`

**Step 1: Verify the caller expectations**

Ensure the remaining dirty caller changes simply pass extracted table context into `parseInvoice(...)`.

**Step 2: Run targeted verification**

Run: `npx vitest run src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts`
Expected: PASS

### Task 3: Clean Up And Commit Remaining Safe Changes

**Files:**
- Commit AP-aligned caller updates and freight guardrail changes together
- Optionally commit copilot helper changes separately after verification

**Step 1: Run targeted suite**

Run: `npx vitest run src/lib/finale/reconciler.test.ts src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts src/test/gold-sample-invoices.test.ts src/lib/storage/invoice-review-corpus.test.ts`
Expected: PASS

**Step 2: Commit focused changes**

Commit AP/freight cleanup separately from unrelated copilot changes.
