# Generic AP Review Corpus Design

**Date:** 2026-03-30
**Owner:** Aria / BuildASoil

## Goal

Improve AP invoice matching and cost capture through a generic process that works across vendors:

1. keep email as the intake path
2. keep Supabase as the archive and review system of record
3. harden OCR retry and deterministic extraction before adding vendor-specific code
4. build a reviewed invoice corpus from real AP traffic so future parser changes are measured

## Current State

- `ap-agent.ts` already downloads invoice PDFs from Gmail, forwards them to Bill.com, uploads the PDF to Supabase storage, and archives parsed metadata into `vendor_invoices`.
- `processInvoiceBuffer()` already has a first-pass OCR parse plus a stronger retry path.
- `invoice-parser.ts` now includes deterministic PO extraction and shipping-to-freight normalization.
- The current test corpus is too narrow to justify vendor-specific parser architecture.

## Problems To Solve

1. A successful OCR retry can still be discarded if the retried parse remains marked `confidence: "low"`.
2. Retry heuristics are broader than the business signal and can fire on normal invoices.
3. The fixture set is too small and too repo-local to guide real AP policy.
4. Vendor-specific parser branching is being introduced before the generic process is fully measured.

## Recommended Architecture

### 1. Generic AP Hardening

- Keep the fast OCR pass and the stronger OCR retry.
- Centralize retry decisions in a helper based on extraction failure signals:
  - missing or garbled PO
  - zero line items
  - unknown vendor
  - zero total
  - no usable deterministic match signal
- Only block reconciliation on low confidence when the invoice still lacks deterministic support after retry.

### 2. Reviewed Invoice Corpus

- Keep `vendor_invoices` as the raw intake/archive table.
- Add a small review-focused table for human-verified truth and parser evidence.
- Store:
  - source invoice identity
  - storage path / message reference
  - first-pass extraction summary
  - retry extraction summary
  - reviewed critical fields
  - review status and reviewer metadata

This separates raw intake from trusted labels and avoids overloading `vendor_invoices.raw_data`.

### 3. Generic Test Strategy

- Keep repo fixtures for fast parser regressions.
- Add helpers that can promote reviewed Supabase samples into replayable tests or reports later.
- Prefer generic field assertions over vendor parser assertions.

## Ingestion Process

1. AP email delivers PDF.
2. AP pipeline archives PDF to Supabase storage and writes `vendor_invoices`.
3. Suspicious parses record retry evidence.
4. Human-reviewed invoices are promoted into the review corpus with expected PO, freight, totals, and match outcome.
5. Future extraction changes are measured against that corpus before threshold changes or vendor branches.

## Non-Goals For This Slice

- No bulk Gmail backfill job yet.
- No new OCR vendor integration.
- No broad vendor-specific parser registry expansion.

## Success Criteria

- A retried invoice with usable deterministic signals is allowed to continue into Finale matching.
- Retry heuristics fire on genuine extraction failures rather than ordinary fee structures.
- AP review truth has a first-class place in Supabase.
- The codebase moves toward a single generic process instead of growing one-off vendor branches.
