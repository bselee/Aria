# AAA Cooper OCR Hardening Design

**Date:** 2026-04-13

## Goal

Restore and improve AAA Cooper statement splitting so accuracy is prioritized over speed. The system should use OCR-capable extraction first, retry once with a stronger second pass when the first result is weak, and leave the email unread in `ap@` when the splitter still cannot confidently identify invoice pages.

## Current Problem

The old AAA Cooper flow worked better because it used `extractPDF()`, which can fall back to OCR for scanned or image-heavy PDFs. The newer multi-invoice statement flow in `ap-identifier.ts` switched to `extractPerPage()`, which runs `pdf-parse` page-by-page and returns blank text on parse failure. That makes the newer flow fragile for exactly the kind of freight statement PDFs AAA Cooper sends.

The codebase also now has multiple AAA Cooper implementations:

- `src/lib/intelligence/ap-agent.ts`
- `src/lib/intelligence/workers/ap-identifier.ts`
- `src/cli/reconcile-aaa.ts`

These paths use different extraction and classification rules, so behavior depends on which path touched the email.

## Requirements

1. Accuracy over speed for AAA Cooper statement handling.
2. OCR-capable extraction must be the default path, not a fallback after a weak fast parser.
3. A second pass must run when first-pass extraction or classification is weak.
4. If the statement is still ambiguous after pass two, do not split, do not forward, and leave the email unread in `ap@`.
5. Only clearly identified invoice pages should be forwarded or queued.
6. All live AAA Cooper paths should reuse one shared implementation.
7. Multi-attachment AAA Cooper emails must process all PDF attachments, not just the first one.

## Recommended Approach

Create a shared AAA Cooper splitter service that becomes the only supported implementation for this vendor. Both `APAgent` and `APIdentifier` should delegate to it, and the CLI reconciler should either reuse it directly or mirror the same extraction and classification rules.

The splitter should:

1. Download each PDF attachment from the email.
2. Run OCR-capable extraction on the full PDF first.
3. Evaluate extraction quality and page classification confidence.
4. If weak, rerun with a stronger second-pass extraction/classification strategy.
5. Apply the stricter AAA Cooper invoice-page validator before forwarding or queueing any page.
6. Return one of three outcomes:
   - `split_ready`
   - `no_invoice_pages`
   - `needs_review`

For `needs_review`, the caller must leave the Gmail message unread and stop automation.

## Data Flow

### Pass 1

1. Load full PDF buffer.
2. Extract text with OCR-capable `extractPDF()`.
3. Build page candidates from extracted pages.
4. Classify pages as invoice vs non-invoice.
5. Run `filterStatementInvoicePages()` for AAA Cooper validation.
6. Score confidence based on:
   - non-empty page text
   - presence of invoice heading
   - presence of `PRO NUMBER` or `INVOICE NUMBER`
   - presence of billing amounts
   - absence of known non-invoice paperwork markers

### Pass 2

Run only when pass 1 is weak. Weak means one or more of:

- too many blank pages
- zero invoice pages on a likely statement
- invoice pages missing billing identifiers
- conflicting page classifications

The second pass should force stronger extraction, even if the first pass produced some text. This can be done by calling `extractPDFWithLLM()` or a new full-document OCR helper that bypasses fast parsing.

### Final Decision

- If pass 2 produces confident invoice pages, split and continue normal automation.
- If pass 2 still looks weak or ambiguous, mark the result as `needs_review` and leave the email unread.

## Shared Service Shape

Create a new module, likely `src/lib/intelligence/aaa-cooper-splitter.ts`, responsible for:

- extracting and classifying AAA Cooper statement PDFs
- handling first-pass and second-pass OCR logic
- returning normalized invoice-page results
- generating diagnostic metadata for logs

Suggested return shape:

```ts
type AAASplitStatus = "split_ready" | "no_invoice_pages" | "needs_review";

interface AAASplitInvoicePage {
  page: number;
  invoiceNumber: string | null;
  amount: number | null;
  date: string | null;
  confidence: "high" | "medium";
}

interface AAASplitResult {
  status: AAASplitStatus;
  invoices: AAASplitInvoicePage[];
  discardedCount: number;
  diagnostics: {
    passUsed: 1 | 2;
    extractionStrategy: string;
    weakReason?: string;
    processedAttachmentCount: number;
  };
}
```

## Integration Changes

### `src/lib/intelligence/workers/ap-identifier.ts`

- Replace the inline `extractPerPage()` flow in `handleMultiInvoiceStatement()`.
- Process all PDF attachments, not only the first.
- If shared splitter returns `needs_review`, leave the email unread and do not label/archive it as processed.
- If shared splitter succeeds, queue split pages as `PENDING_FORWARD`.

### `src/lib/intelligence/ap-agent.ts`

- Replace the custom AAA Cooper classification path with the shared splitter.
- Remove duplicate page classification rules once the shared service is in place.
- Preserve current forwarding behavior only for confident invoice pages.

### `src/cli/reconcile-aaa.ts`

- Reuse the shared splitter so manual CLI runs behave the same as automated inbox processing.

### `src/lib/pdf/extractor.ts`

- Reuse existing OCR functions where possible.
- Add a clearly named forced-OCR helper if `extractPDFWithLLM()` is the right second-pass tool but needs a cleaner call site.

## Error Handling

- If attachment download fails, log it and continue to the next attachment.
- If OCR fails on one pass, log the failure reason and try the second pass when appropriate.
- If both passes fail or remain ambiguous, return `needs_review`.
- Never mark ambiguous AAA Cooper emails read.

## Testing Strategy

Add focused tests around the shared splitter and the callers:

1. First-pass OCR succeeds on a statement and yields invoice pages.
2. First pass is weak, second pass succeeds.
3. First pass is weak, second pass is still ambiguous, result is `needs_review`.
4. Multi-attachment email processes more than one PDF.
5. `APIdentifier` leaves the email unread on `needs_review`.
6. `APAgent` and CLI delegate to the shared splitter instead of their own heuristics.

Use mocks for OCR/extraction boundaries so tests stay deterministic and fast.

## Why This Design

This keeps the system aligned with the operational requirement: accuracy is the asset. It also removes the current split-brain implementation, which is the deeper reliability problem. One shared AAA Cooper splitter gives us one place to improve OCR, confidence rules, invoice filtering, and hold-for-review behavior without recreating drift across the bot, worker, and CLI flows.
