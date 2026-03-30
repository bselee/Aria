# Freight Threshold Cleanup Design

**Date:** 2026-03-30
**Owner:** Aria / BuildASoil

## Goal

Clean up the remaining AP-related dirty files without increasing OCR or matching risk.

## Problem

The remaining changes include:

- safe table-aware `parseInvoice(...)` caller updates
- unrelated copilot helper cleanup
- a broad reconciler threshold bump that loosens product price auto-approval too much

You want legitimate freight charges, including truckload-scale freight, to auto-apply when the invoice is otherwise trustworthy. You do **not** want OCR mistakes to gain a wider path into Finale.

## Recommended Design

### 1. Keep OCR And Matching As-Is

- No changes to extraction or matching behavior.
- No additional parser looseness.
- No broader product price auto-approval.

### 2. Keep Product Pricing Tight

- Revert the broad `AUTO_APPROVE_PERCENT` increase.
- Product pricing should remain conservative because OCR risk is highest there.

### 3. Make Freight Smarter

- Increase the fee-specific `FREIGHT` cap to a truckload-safe level.
- Keep other fee types conservative.
- Refine the total-impact gate so large freight-only changes do not automatically force approval when the fee itself is already within the fee-specific cap.

### 4. Clean The Remaining Files In Focused Commits

- Commit the table-aware `parseInvoice(rawText, tables)` caller updates with the freight guardrail refinement.
- Commit the copilot helper changes separately if they are still desired after verification.

## Success Criteria

- High freight invoices can auto-apply when the parsed invoice is otherwise sound.
- Product price changes do not get a broader auto-approval window.
- No changes are made that worsen OCR recognition or matching reliability.
