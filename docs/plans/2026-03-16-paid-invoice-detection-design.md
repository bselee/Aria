# Paid Invoice Detection — Design Document

> **Created:** 2026-03-16  
> **Author:** Will  
> **Status:** Implemented  

## Problem

Emails confirming paid invoices (e.g., "Invoice INV122172 paid $148.76 successfully") arrive in `bill.selee@buildasoil.com`. These were being ingested and labeled `AP-Seen` by the existing pipeline but not processed — the AP classifier had no `PAID_INVOICE` intent, so they fell through as `HUMAN_INTERACTION` and were silently dropped.

Every paid invoice should have a corresponding PO in Finale. When one doesn't exist, a draft PO should be created for human review.

## Solution

### Detection — Two-Layer Approach

1. **Fast regex pre-check** (`detectPaidInvoice`) — Fires before the LLM classifier to catch obvious patterns:
   - `"Invoice INV___ paid"` (AxiomPrint format)
   - `"payment successful"` + dollar amount
   - `"successfully paid"`
   - `"Balance $0.00"` with invoice reference (medium signal, needs 2+)

2. **LLM classification** — `PAID_INVOICE` added to the `APIdentifierAgent` classifier enum as a fallback for subtler patterns the regex misses.

### Extraction

LLM extracts structured data from the email body:
- Vendor name, invoice number, amount paid, date
- PO number (if referenced)
- Product description (if mentioned)

### PO Matching (Precise)

1. **Direct PO# lookup** — If the email references a PO number, look it up in Finale directly
2. **Vendor + amount match** — Search Finale for recent POs from the same vendor, prefer exact amount match ($1 tolerance), then most recent

### Draft PO Creation

When no matching PO exists:
- Look up vendor party by name (searches PO history since Finale has no party search API)
- Create a draft PO with `PLACEHOLDER-PAID-INVOICE` as the SKU, qty 1, price = paid amount
- Memo includes: invoice number, amount, date, product description, and reminder to add real SKU
- Alert Will via Telegram with Finale link

### Data Flow

```
Email → EmailIngestionWorker → email_inbox_queue
                                     ↓
                          APIdentifierAgent
                          ├── regex: detectPaidInvoice? → PAID_INVOICE
                          └── LLM: classifyEmailIntent  → PAID_INVOICE
                                     ↓
                          handlePaidInvoice()
                          ├── LLM extract vendor/inv#/amount
                          ├── Finale: match by PO# or vendor+amount
                          ├── If matched → log to paid_invoices table
                          ├── If no match → findVendorPartyByName → createDraftPurchaseOrder
                          ├── Telegram alert (match / draft created / manual review)
                          └── Label AP-Seen, mark read
```

## Files Changed

| File | Change |
|------|--------|
| `inline-invoice-parser.ts` | Added `detectPaidInvoice()`, `parsePaidInvoice()`, `PaidInvoiceSchema` |
| `workers/ap-identifier.ts` | Added `PAID_INVOICE` intent + `handlePaidInvoice()` handler |
| `finale/client.ts` | Added `findVendorPartyByName()` method |
| `ops-manager.ts` | Pass `bot` to `APIdentifierAgent` constructor |
| `inline-invoice-parser.test.ts` | 14 new tests for `detectPaidInvoice` |
| `migrations/20260316_create_paid_invoices.sql` | New table for logging |

## SKU Strategy

- **For now:** Use `PLACEHOLDER-PAID-INVOICE` as a generic SKU on draft POs. Will replaces with the real vendor SKU before committing.
- **Future:** When the email clearly names a product that maps to a known Finale SKU, auto-correlate it.

## Decisions

- **DECISION(2026-03-16):** Skip emails with PDF attachments — those go through the normal AP invoice pipeline. Paid invoice confirmations are text-only emails.
- **DECISION(2026-03-16):** 60-day search window for vendor PO matching. Paid confirmations can arrive well after the order.
- **DECISION(2026-03-16):** $1 tolerance on amount matching. Online purchases should match to the penny, but tax/rounding differences happen.
- **DECISION(2026-03-16):** Vendor party lookup via PO history (not direct party search). Finale doesn't expose a "search parties by name" API.
