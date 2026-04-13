# AAA Cooper OCR Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AAA Cooper statement splitting accuracy-first by using OCR-capable extraction as the default, retrying once with a stronger second pass, and leaving ambiguous emails unread in `ap@` instead of guessing.

**Architecture:** Build one shared AAA Cooper splitter service and route both `APIdentifier` and `APAgent` through it. The shared service should run first-pass OCR-capable extraction, escalate to a forced second pass when results are weak, and return normalized outcomes so callers can either queue/forward invoices or stop and leave the email unread for review.

**Tech Stack:** TypeScript, Vitest, Gmail API integration, `pdf-lib`, `pdf-parse`, existing OCR helpers in `src/lib/pdf/extractor.ts`

---

### Task 1: Add shared AAA Cooper splitter tests first

**Files:**
- Create: `src/lib/intelligence/aaa-cooper-splitter.test.ts`
- Reference: `src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
- Reference: `src/lib/pdf/extractor.ts`

**Step 1: Write the failing tests**

Add tests covering:

- first-pass success returns `split_ready`
- weak first pass escalates to second pass
- weak second pass returns `needs_review`
- multiple attachments are all processed

Use mocks for extraction and filtering. Example skeleton:

```ts
it("escalates to second pass when first-pass extraction is weak", async () => {
  mockedExtractPDF.mockResolvedValueOnce(firstPassWeakResult);
  mockedExtractPDFWithLLM.mockResolvedValueOnce(secondPassStrongResult);

  const result = await splitAAACooperStatementAttachments(input);

  expect(result.status).toBe("split_ready");
  expect(mockedExtractPDFWithLLM).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/aaa-cooper-splitter.test.ts`
Expected: FAIL because the shared splitter does not exist yet.

**Step 3: Commit**

```bash
git add src/lib/intelligence/aaa-cooper-splitter.test.ts
git commit -m "test: add aaa cooper splitter coverage"
```

### Task 2: Implement the shared AAA Cooper splitter

**Files:**
- Create: `src/lib/intelligence/aaa-cooper-splitter.ts`
- Modify: `src/lib/pdf/extractor.ts`
- Reference: `src/lib/intelligence/workers/ap-identifier-statement-filter.ts`

**Step 1: Write minimal implementation**

Create a shared module with:

- `splitAAACooperStatementAttachments()`
- a first-pass extraction path using `extractPDF()`
- a second-pass forced OCR path using `extractPDFWithLLM()` or a small wrapper in `extractor.ts`
- confidence evaluation helpers
- normalized result statuses: `split_ready`, `no_invoice_pages`, `needs_review`

Suggested types:

```ts
export type AAASplitStatus = "split_ready" | "no_invoice_pages" | "needs_review";

export interface AAASplitAttachmentInput {
  attachmentName: string;
  pdfBuffer: Buffer;
}

export interface AAASplitInvoice {
  attachmentName: string;
  page: number;
  invoiceNumber: string | null;
  amount: number | null;
  date: string | null;
}
```

**Step 2: Reuse existing AAA filtering**

After page classification, pass candidates through `filterStatementInvoicePages("AAA Cooper", ...)`.

**Step 3: Add weak-result detection**

Implement a helper like:

```ts
function shouldEscalateToSecondPass(pages: PageContent[], invoicePages: StatementInvoicePageCandidate[]): boolean
```

Escalate when:

- too many blank pages
- zero invoice pages on a multi-page statement
- candidate invoices fail the AAA filter

**Step 4: Run tests**

Run: `npx vitest run src/lib/intelligence/aaa-cooper-splitter.test.ts src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/aaa-cooper-splitter.ts src/lib/pdf/extractor.ts src/lib/intelligence/aaa-cooper-splitter.test.ts
git commit -m "feat: add shared aaa cooper ocr splitter"
```

### Task 3: Route `APIdentifier` through the shared splitter

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.ts`
- Add or extend test: `src/lib/intelligence/workers/ap-identifier.test.ts`

**Step 1: Write the failing tests**

Cover:

- `needs_review` leaves the message unread
- `split_ready` queues invoices as `PENDING_FORWARD`
- all PDF attachments are processed, not just the first

Example assertion:

```ts
expect(gmail.users.messages.modify).not.toHaveBeenCalledWith(
  expect.objectContaining({
    requestBody: expect.objectContaining({ removeLabelIds: expect.arrayContaining(["UNREAD"]) }),
  }),
);
```

**Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier.test.ts`
Expected: FAIL because the current handler still uses `extractPerPage()` and only the first attachment.

**Step 3: Replace inline split logic**

Update `handleMultiInvoiceStatement()` to:

- gather all PDF attachments
- download each attachment
- call the shared splitter once with all attachments
- queue only confident invoice pages
- return `false` or a hold state for `needs_review` so the caller leaves the message unread

Remove the direct `extractPerPage()` dependency from this flow.

**Step 4: Run tests**

Run: `npx vitest run src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/aaa-cooper-splitter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.ts src/lib/intelligence/workers/ap-identifier.test.ts
git commit -m "feat: harden aaa cooper statement intake in ap identifier"
```

### Task 4: Route `APAgent` through the shared splitter

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts`
- Modify: `src/lib/intelligence/ap-agent.test.ts`

**Step 1: Write the failing tests**

Add tests showing:

- AAA Cooper processing delegates to the shared splitter
- `needs_review` does not mark the message read
- `split_ready` forwards only confident invoice pages

**Step 2: Run focused tests and confirm failure**

Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts`
Expected: FAIL until the old inline classifier is removed from AAA Cooper routing.

**Step 3: Implement minimal integration**

Replace the custom `classifyAAAPages()` usage for AAA Cooper with the shared splitter. Keep current MIME-forwarding behavior, but only after `split_ready`.

For `needs_review`:

- stop forwarding
- do not remove `UNREAD`
- log a clear activity entry

**Step 4: Run tests**

Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts src/lib/intelligence/aaa-cooper-splitter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ap-agent.ts src/lib/intelligence/ap-agent.test.ts
git commit -m "feat: reuse shared aaa cooper splitter in ap agent"
```

### Task 5: Align the manual reconciler with the shared OCR-first behavior

**Files:**
- Modify: `src/cli/reconcile-aaa.ts`
- Add or extend test: `src/cli/test-ap-aaa-cooper.ts`

**Step 1: Write the failing test or harness assertion**

Add a focused harness or unit-style test proving the CLI uses the shared splitter instead of its old inline page heuristic.

**Step 2: Run and verify failure**

Run: `node --import tsx src/cli/test-ap-aaa-cooper.ts`
Expected: FAIL or show the old heuristic is still being used.

**Step 3: Replace duplicate logic**

Update the CLI to call the shared splitter for extraction and page selection. Remove the old `classifyPages()` heuristic once the shared flow is wired in.

**Step 4: Re-run the harness**

Run: `node --import tsx src/cli/test-ap-aaa-cooper.ts`
Expected: PASS or show the shared splitter path is active.

**Step 5: Commit**

```bash
git add src/cli/reconcile-aaa.ts src/cli/test-ap-aaa-cooper.ts
git commit -m "refactor: share aaa cooper ocr logic with cli reconciler"
```

### Task 6: Verify hold-for-review behavior end to end

**Files:**
- Modify: `src/lib/intelligence/workers/ap-identifier.test.ts`
- Modify: `src/lib/intelligence/ap-agent.test.ts`

**Step 1: Add one final cross-flow test per caller**

Make sure ambiguous AAA Cooper statements:

- remain unread
- are not queued or forwarded
- log enough context for later investigation

**Step 2: Run the targeted suite**

Run:

```bash
npx vitest run src/lib/intelligence/aaa-cooper-splitter.test.ts src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/ap-agent.test.ts
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/ap-agent.test.ts
git commit -m "test: lock unread review behavior for aaa cooper"
```

### Task 7: Final verification

**Files:**
- Verify only; no new files required

**Step 1: Run focused verification**

Run:

```bash
npx vitest run src/lib/intelligence/aaa-cooper-splitter.test.ts src/lib/intelligence/workers/ap-identifier-statement-filter.test.ts src/lib/intelligence/workers/ap-identifier.test.ts src/lib/intelligence/ap-agent.test.ts
```

Expected: PASS

**Step 2: Run CLI sanity check**

Run:

```bash
node --import tsx src/cli/test-ap-aaa-cooper.ts
```

Expected: no failures, and output indicates the shared splitter path is used.

**Step 3: Run diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected:

- no whitespace errors
- only intended files changed

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "feat: harden aaa cooper ocr statement splitting"
```
