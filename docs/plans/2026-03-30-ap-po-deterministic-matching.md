# AP PO Deterministic Matching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AP reliably match clear PDF invoices to the correct Finale PO so price and shipping updates are applied to the draft PO every time.

**Architecture:** Add deterministic PO extraction in the invoice parser using raw text plus extracted table cells, then feed PDF tables into the AP parsing path so table-printed PO numbers are not left to the LLM alone. Keep Finale reconciliation guardrails intact and add regression tests that cover a Coats-style invoice with a shipping line.

**Tech Stack:** TypeScript, Vitest, Zod, existing PDF extraction + AP reconciliation pipeline

---

### Task 1: Add regression tests first

**Files:**
- Create: `src/lib/pdf/invoice-parser.test.ts`
- Modify: `src/lib/intelligence/ap-agent.test.ts` (if needed)

**Step 1: Write the failing test**

- Add a parser regression using a Coats-style invoice sample where `P.O. Number` appears in table text as `124547`.
- Assert the parser returns `poNumber = "124547"` even when the mocked LLM omits it.
- Assert a shipping-and-handling line can still support freight handling via existing reconciliation behavior.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts`

**Step 3: Add AP handoff regression**

- Add a test proving `processInvoiceBuffer()` passes extracted table data into `parseInvoice()`.

**Step 4: Run test to verify it fails**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts`

### Task 2: Implement deterministic PO extraction

**Files:**
- Modify: `src/lib/pdf/invoice-parser.ts`

**Step 1: Add a raw-text/table PO extractor**

- Support `P.O. Number`, `PO Number`, `PO #`, `Purchase Order Number`, and similar variants.
- Search both raw text and flattened table rows.
- Normalize whitespace and choose the strongest candidate.

**Step 2: Merge deterministic fields after LLM extraction**

- If the LLM returns no `poNumber`, fill it from deterministic extraction.
- If the LLM returns a weak/garbled value and deterministic extraction finds a stronger numeric PO, prefer the deterministic one.

**Step 3: Run targeted tests**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts`

### Task 3: Wire tables into AP parsing

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts`

**Step 1: Pass extracted tables to `parseInvoice()`**

- Reuse the existing table flattening pattern already used by `attachment-handler.ts`.

**Step 2: Preserve current reconciliation behavior**

- Do not loosen Finale validation.
- Keep exact PO matches trusted only after Finale lookup succeeds.

**Step 3: Run targeted tests**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts`

### Task 4: Verify end-to-end safety

**Files:**
- Modify: `src/lib/finale/reconciler.test.ts` (only if a regression test is needed for derived freight)

**Step 1: Confirm freight handling still works**

- Add or keep a regression that derived freight or explicit freight continues to create a `FREIGHT` adjustment when appropriate.

**Step 2: Run the focused verification set**

Run: `npm test -- src/lib/pdf/invoice-parser.test.ts src/lib/intelligence/ap-agent.test.ts src/lib/finale/reconciler.test.ts`
