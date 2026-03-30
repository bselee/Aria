# AP OCR Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden AP invoice extraction so suspicious first-pass OCR results automatically escalate to stronger OCR, while preserving correct freight and PO matching behavior.

**Architecture:** Keep the existing two-tier extraction flow in place, but centralize retry decision logic in the AP agent and prove it with focused regressions. Treat vendor parsers and deterministic extraction as trusted helpers, and make retry telemetry durable enough to explain what happened on every suspicious invoice.

**Tech Stack:** TypeScript, Vitest, existing PDF extractor, invoice parser, AP agent, Supabase audit logging

---

### Task 1: Add failing tests for the live OCR retry path

**Files:**
- Modify: `src/lib/intelligence/ap-agent.test.ts`
- Modify: `src/lib/pdf/invoice-parser.test.ts`

**Step 1: Write the failing test**

- Add an AP-agent regression where first-pass `extractPDF()` + `parseInvoice()` produce a suspicious parse and `extractPDFWithLLM()` returns a better one.
- Assert the retry path fires and the improved parse is the one kept.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/intelligence/ap-agent.test.ts`

**Step 3: Add a freight double-count regression**

- Add a parser regression proving a vendor parser that already set `freight` does not get doubled when `extractShippingToFreight()` sees the same shipping line item.

**Step 4: Run test to verify it fails**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts`

### Task 2: Harden the AP retry decision

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts`

**Step 1: Extract retry heuristics into helpers**

- Add a helper that decides whether first-pass OCR is suspicious enough to retry.
- Add a helper that compares first-pass and retry parse quality without mutating the first-pass snapshot.

**Step 2: Preserve first-pass telemetry**

- Log retry reasons and outcome using the original parse/extraction values, even if the retry improved and replaced the working variables.

**Step 3: Keep the behavior minimal**

- Only retry from the fast `pdf-parse` path.
- Only accept retry when it materially improves parse quality.

**Step 4: Run targeted tests**

Run: `npm test -- src/lib/intelligence/ap-agent.test.ts`

### Task 3: Verify parser guardrails still hold

**Files:**
- Modify: `src/lib/pdf/invoice-parser.ts` only if tests reveal a gap

**Step 1: Keep freight de-duplication intact**

- Ensure vendor-parser freight plus shipping-line freight do not double-count.
- Preserve legitimate additive freight behavior when values materially differ.

**Step 2: Run targeted tests**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts`

### Task 4: Verify the full focused slice

**Files:**
- No new files unless tests reveal gaps

**Step 1: Run the focused verification set**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts src/lib/finale/reconciler.test.ts`
