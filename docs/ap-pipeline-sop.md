# AP Invoice Pipeline — Standard Operating Procedure

**System:** Aria (`aria-bot`)
**Owner:** Will @ BuildASoil
**Last Updated:** 2026-03-02
**Source of truth:** `src/lib/intelligence/ap-agent.ts`, `src/lib/finale/reconciler.ts`

---

## Overview

Every 15 minutes, Aria scans the `ap@buildasoil.com` inbox. For each unread email it classifies intent, downloads any PDF attachments, forwards to `buildasoilap@bill.com` (payment), and runs reconciliation against Finale (audit + cost tracking). The two paths — bill.com forwarding and Finale reconciliation — are **fully independent**. A reconciliation failure never blocks payment.

```
Gmail ap@buildasoil.com
        │
        ▼
Step 1  CLASSIFY INTENT
        │
        ├── ADVERTISEMENT   ─── Archive, mark read, log. Done.
        ├── STATEMENT       ─── Label "Statements", mark read, log. Done.
        ├── HUMAN_INTERACTION ─ Leave unread for Will. Log. Done.
        │
        └── INVOICE / DROPSHIP_INVOICE
                │
                ▼
Step 2  DOWNLOAD PDF(s)
                │
                ├── No PDF found ─── Leave unread, notify Will, log. Done.
                │
                └── PDF found
                        │
                        ├─► Step 3  FORWARD to buildasoilap@bill.com  (immediate)
                        │
                        └─► Step 4  PARSE INVOICE  (background, non-blocking)
                                │
                                ├── confidence: "low" ─── Alert Will, skip reconciliation. Done.
                                │
                                ├── isDropship = true ─── Notify Will, no reconciliation. Done.
                                │
                                └── confidence: "medium"/"high"
                                        │
                                        ▼
                            Step 5  FIND MATCHING PO
                                        │
                                        ├── PO found ──► Step 6  RECONCILE
                                        │
                                        └── No PO found ─► Step 7  UNMATCHED FLOW
```

---

## Step 1 — Email Classification

**File:** `ap-agent.ts` → `classifyEmailIntent()` and `isKnownDropshipVendor()`

### 1a. Known Dropship Fast-Path
Before any LLM call, Aria checks `KNOWN_DROPSHIP_KEYWORDS` against the sender and subject line (case-insensitive). If a match is found, the email is immediately classified as `DROPSHIP_INVOICE` — no API call needed.

Current keywords:
- `autopot`
- `logan labs` / `loganlab`
- `evergreen growers` / `evergreengrow`

**To add a vendor:** Append to the `KNOWN_DROPSHIP_KEYWORDS` array in `ap-agent.ts`.

### 1b. LLM Classification (Claude → GPT-4o fallback)
For all other emails, the agent sends the subject, sender, and Gmail snippet to `unifiedObjectGeneration()` with this schema:

| Intent | Trigger | Action |
|--------|---------|--------|
| `INVOICE` | Standard vendor bill for warehouse stock / bulk order | Proceed to PDF download |
| `DROPSHIP_INVOICE` | Vendor billing for order shipped to customer; dropship signals in subject/snippet | Forward to bill.com; skip Finale reconciliation |
| `STATEMENT` | Account statement, aging summary | Label "Statements"; leave in inbox; mark read |
| `ADVERTISEMENT` | Marketing, spam, newsletters | Remove from inbox; mark read; log |
| `HUMAN_INTERACTION` | Payment questions, disputes, anything requiring a reply | Leave unread; log; do nothing |

**Classification errors** default to `HUMAN_INTERACTION` (fail safe — Will sees it).

---

## Step 2 — PDF Download

**File:** `ap-agent.ts` → `processUnreadInvoices()` → walkParts()

Aria performs a **recursive MIME tree walk** to find PDF attachments. This catches PDFs nested under multipart/mixed → multipart/related chains that a flat `.parts` scan misses (common with Outlook-formatted emails).

For each found PDF:
1. Download the raw attachment bytes via Gmail API.
2. Immediately trigger **Step 3** (forward to bill.com).
3. Kick off **Step 4** (parse + reconcile) in the background (non-blocking).

If no PDFs are found on a classified INVOICE email, the email is left **unread** in the inbox and Will is notified to review manually.

After processing all PDFs, the email is labeled `Invoice Forward` and marked read.

---

## Step 3 — Forward to Bill.com

**File:** `ap-agent.ts` → `forwardToBillCom()`

This fires **immediately** after the PDF bytes are downloaded, before any parsing. Purpose: ensure bill.com has the invoice for payment regardless of whether our reconciliation logic succeeds.

- From: `ap@buildasoil.com`
- To: `buildasoilap@bill.com`
- Subject: `Fwd: <original subject>`
- Body: plain text note + original PDF as attachment

Failures are logged but do not stop the pipeline.

---

## Step 4 — Parse Invoice

**File:** `src/lib/pdf/invoice-parser.ts` → `parseInvoice()` and `extractPDF()`

### 4a. PDF Text Extraction
`extractPDF()` converts the PDF buffer to raw text (up to 20,000 characters). Tables are also extracted separately for structured data accuracy.

### 4b. LLM Invoice Extraction
`parseInvoice()` sends the raw text + table context to Claude (`claude-3-5-sonnet-20241022`) via `unifiedObjectGeneration()` with the `InvoiceSchema`.

**Target fields extracted:**

| Field | Description |
|-------|-------------|
| `invoiceNumber` | Invoice identifier (string) |
| `poNumber` | PO number reference printed on invoice (nullable) |
| `orderNumber` | Vendor's internal order number (nullable) |
| `vendorName` | Exact vendor name as printed |
| `vendorAddress` | Full address (nullable) |
| `vendorPhone` / `vendorEmail` / `vendorWebsite` | Contact info (nullable) |
| `billTo` / `shipTo` | Billing and shipping addresses (nullable) |
| `invoiceDate` | Invoice date in `YYYY-MM-DD` format |
| `dueDate` | Due date (or calculated from invoice date + terms) |
| `shipDate` | Ship date (nullable) |
| `paymentTerms` | Exact text — "Net 30", "2/10 Net 30", "Due on Receipt", etc. |
| `lineItems[]` | Array — see below |
| `subtotal` | Pre-tax subtotal |
| `freight` | Freight/shipping charge |
| `fuelSurcharge` | Fuel surcharge (separate from freight) |
| `tax` | Sales tax |
| `tariff` | Import duties, tariffs, customs fees |
| `labor` | Labor, handling, processing charges |
| `discount` | Applied discount (negative) |
| `total` | Invoice total |
| `amountPaid` | Any partial payment already made (nullable) |
| `amountDue` | Balance remaining |
| `currency` | Currency code (nullable, defaults to USD) |
| `trackingNumbers[]` | All tracking numbers found on the invoice |
| `proNumber` | LTL PRO number (nullable) |
| `bolNumber` | Bill of lading number (nullable) |
| `carrierName` | Shipping carrier name (nullable) |
| `remitTo` | Remit-to address if different from vendor (nullable) |
| `notes` | Any notes, special instructions (nullable) |
| `confidence` | `"high"` / `"medium"` / `"low"` — LLM's own assessment of parse quality |

**Line item fields:**

| Field | Description |
|-------|-------------|
| `sku` | SKU / part number (nullable) |
| `description` | Line item description (required) |
| `qty` | Quantity |
| `unit` | Unit of measure — EA, LB, BAG, PALLET (nullable) |
| `unitPrice` | Price per unit |
| `discount` | Per-line discount (nullable) |
| `total` | Line total |
| `poLineRef` | Reference to PO line number if printed (nullable) |

### 4c. Confidence Guard
If `confidence === "low"` (garbled PDF, failed extraction):
- Telegram message sent to Will: "Low-confidence parse — review manually"
- Invoice **already forwarded** to bill.com in Step 3
- No Finale reconciliation attempted
- Logged to `ap_activity_log`
- **Done.**

---

## Step 5 — Find Matching PO

**File:** `ap-agent.ts` → `processInvoiceBuffer()` (PO matching block)

Aria queries Finale directly — no Supabase middle layer.

### 5a. PO# on Invoice (Primary Path)
If `invoiceData.poNumber` is populated, use it directly as `finalePONumber`. No Finale search needed.

Match source label: `"PO# on invoice"`

### 5b. Finale Vendor + Date Fallback (Secondary Path)
If no PO# on the invoice and not a dropship, Aria calls `FinaleClient.findPOByVendorAndDate()`:
- Vendor name from parsed invoice
- Invoice date ± 30 days
- Filters to `Committed` or `Open` POs
- Filters to POs within **10% of invoice total**
- Sorted by closest total amount; picks the best single match

Match source label: `"Finale vendor+date match (<supplier>, <orderDate>) — REQUIRES APPROVAL"`

**Note:** Vendor+date matches always route to `needs_approval` — Will must confirm before Finale is updated.

### 5c. No Match Found → Step 7

---

## Step 6 — Reconcile Against Finale

**File:** `src/lib/finale/reconciler.ts` → `reconcileInvoiceToPO()`

This is the most complex step. Aria fetches the live PO from Finale, compares it against the parsed invoice, and decides what — if anything — needs to be updated. No Finale writes happen during this step; it only produces a `ReconciliationResult` plan.

### 6a. Guard 0 — Duplicate Detection
Queries `ap_activity_log` for any prior `RECONCILIATION` entry with matching `invoiceNumber` + `orderId` in the metadata JSONB.

- **Duplicate found:** Verdict = `"duplicate"`. Send alert, do nothing. Done.
- **Fail-open:** If the Supabase query itself errors, proceed (better to process once than block forever).

### 6b. Guard 1 — Vendor Correlation (3-Signal Check)
Before touching any line items, Aria verifies the invoice actually belongs to this PO. Three signals are checked:

1. **Vendor name fuzzy match** — Jaccard word-overlap ≥ 50% between invoice vendor name and PO supplier name
2. **PO# reference** — Invoice's `poNumber` field references this PO's orderId
3. **SKU overlap** — ≥1 invoice SKU appears in the PO's line items

If **none** of the three signals pass, the match is rejected outright as a vendor mismatch (does not reach guardrails).

### 6c. Line Item Reconciliation
For each invoice line item, Aria attempts to match it to a PO line by SKU or description, then evaluates any price change:

**Price change guardrails (`evaluatePriceChange()`):**

| Condition | Verdict | Action |
|-----------|---------|--------|
| Prices match (< $0.01 delta) | `no_change` | Nothing to do |
| Price change ≤ 3% | `auto_approve` | Auto-apply without human review |
| Price change > 3% but < 10× magnitude | `needs_approval` | Telegram button request |
| New price is 10× higher or lower than PO price | `rejected` | Block — likely decimal/OCR error |
| Line item unit price > $5,000 | `needs_approval` | Manual review regardless of % change |

**Quantity overbill check:**
If invoice quantity > PO quantity ordered, the line is flagged as a warning (`quantity_overbill`). Aria will not auto-apply quantity overages.

**No match found:**
If no PO line item can be matched to an invoice line, verdict = `"no_match"` for that line (informational, logged in warnings).

### 6d. Fee Reconciliation
Fees on the invoice (freight, tax, tariff, labor) are compared against existing PO fee lines in Finale:

| Fee | Finale `productpromo` ID |
|-----|--------------------------|
| FREIGHT | 10007 |
| TAX | 10008 |
| TARIFF | 10014 |
| LABOR | 10016 |
| SHIPPING | 10017 |

**Fee guardrail:**
- Delta (invoice fee − existing PO fee) ≤ $250 → `auto_approve`
- Delta > $250 → `needs_approval`

New fees (not currently on the PO) follow the same threshold against $0 as baseline.

### 6e. Tracking Update
If the invoice contains tracking numbers not already on the PO, they are queued as a tracking update. Tracking updates are always `auto_approve` (low risk).

### 6f. Total Impact Cap
After all per-line and per-fee verdicts are assigned, the aggregate dollar impact is calculated. If the **total impact across all changes exceeds $500**, the overall verdict escalates to `needs_approval` regardless of any individual line's auto-approve status.

### 6g. Overall Verdict

| Verdict | Meaning |
|---------|---------|
| `auto_approve` | All changes ≤ 3%, total impact ≤ $500, no high-value items |
| `needs_approval` | Any change > 3%, total impact > $500, or high-value item |
| `rejected` | Magnitude error (≥10×) detected on at least one line |
| `duplicate` | Already reconciled — no action |
| `no_change` | Invoice matches PO exactly |
| `no_match` | No PO line items could be correlated (informational) |

---

## Step 6 (continued) — Apply or Queue

**File:** `ap-agent.ts` → `reconcileAndUpdate()` and `reconciler.ts` → `applyReconciliation()`

After the plan is built:

### Path A — `auto_approve`
1. `applyReconciliation()` is called immediately.
2. For each price change: `FinaleClient.updateOrderItemPrice()` — GET PO → modify line price → POST back.
3. For each fee: `FinaleClient.addOrderAdjustment()` — adds `productpromo` fee line to PO.
4. For tracking: `FinaleClient.updateOrderTracking()`.
5. If PO is `ORDER_LOCKED`, call `actionUrlEdit` to unlock first, re-fetch, then modify and POST.
6. Telegram notification: summary of what was applied.
7. Logged to `ap_activity_log`.

### Path B — `needs_approval`
1. `storePendingApproval(result, finaleClient)` stores the plan in-memory (`pendingApprovals` Map, 24h TTL).
2. Telegram message with Approve / Reject inline keyboard buttons.
3. Will taps **Approve** → `approvePendingReconciliation(id)`:
   - Applies all changes to Finale (same write pattern as auto_approve).
   - Writes to `ap_activity_log` as permanent duplicate-detection record.
   - **Vendor learning:** Upserts `vendor_name` into `purchase_orders` table for future matching.
   - Removes entry from in-memory store.
4. Will taps **Reject** → `rejectPendingReconciliation(id)`:
   - No Finale writes.
   - Writes "rejected" to `ap_activity_log` (duplicate detection still fires on future re-processing).
   - Removes entry from in-memory store.

**⚠️ Restart warning:** `pm2 restart aria-bot` clears the in-memory `pendingApprovals` store. Any pending approval requests with buttons become orphaned. The invoice will re-process on the next 15-min poll cycle and prompt again.

### Path C — `rejected`
- No Finale writes. Ever.
- Telegram alert describing the magnitude error.
- Will must manually investigate the invoice and correct the PO if needed.

### Path D — `duplicate`
- No Finale writes.
- Telegram alert showing when the prior reconciliation occurred and what action was taken.

### Path E — `no_change`
- Nothing written to Finale.
- Logged to `ap_activity_log` (for duplicate detection).
- No Telegram notification (silent — expected outcome for clean invoices).

---

## Step 7 — No PO Found

**File:** `ap-agent.ts` → `processInvoiceBuffer()` → `sendNotification()`

When neither the PO# strategy nor the Finale vendor+date fallback yields a match:

1. The parsed invoice data is saved to `dropship-store.ts` (`pendingDropships` Map, **48h TTL**). A unique `dropId` is generated.
2. Aria saves to `documents` + `invoices` tables with `status: "unmatched"`.
3. Telegram notification is sent with **three action buttons**:

| Button | Callback | Behavior |
|--------|----------|----------|
| 📦 Dropship — Forward to bill.com | `dropship_fwd_<dropId>` | Re-forwards raw PDF to bill.com; marks handled |
| 📋 This Has a PO — Enter PO# | `invoice_has_po_<dropId>` | Prompts Will to type the PO#; bot intercepts the reply |
| ⏭️ Skip | `invoice_skip_<dropId>` | Dismisses without action |

### "This Has a PO" Manual Flow
When Will taps the PO# button and types a PO number:
1. Bot's text handler checks `pendingPoEntry` map for Will's chat ID.
2. Re-parses the stored base64 PDF to get fresh `InvoiceData`.
3. Force-injects the user-supplied PO#: `invoiceData.poNumber = poNumber`.
4. Calls `reconcileInvoiceToPO(invoiceData, poNumber, finaleClient)` directly.
5. Routes per normal Step 6 verdict logic.

### When Does "No PO" Actually Happen?
- True dropships from vendors NOT in `KNOWN_DROPSHIP_KEYWORDS` (LLM mis-classified as INVOICE).
- Invoice from a vendor who wrote the wrong PO# (or none) on the document.
- New vendor with no recent Finale POs in the ±30-day window.
- Finale vendor+date fallback found candidates but none within 10% of invoice total.

**This path is rare for standard BAS vendor invoices** — almost all have a PO# printed on them.

---

## Audit Trail

All AP agent decisions are logged to `ap_activity_log`:

| Column | What it holds |
|--------|--------------|
| `email_from` | Sender email |
| `email_subject` | Email subject |
| `intent` | Classified intent |
| `action_taken` | Human-readable action description |
| `notified_slack` | Whether Slack was also notified |
| `metadata` | JSONB — PO number, invoice number, verdicts, applied/error arrays |

The `daily recap` (sent at 8:00 AM weekdays) summarizes all entries from the current UTC day grouped by intent. Will can spot-check classifications and flag errors.

---

## Configuration Reference

**File:** `reconciler.ts` → `RECONCILIATION_CONFIG`

| Constant | Value | Meaning |
|----------|-------|---------|
| `AUTO_APPROVE_PERCENT` | 3% | Max price change % for silent auto-apply |
| `MAGNITUDE_CEILING` | 10× | Reject if new price is 10× or 0.1× the PO price |
| `TOTAL_IMPACT_CAP_DOLLARS` | $500 | Escalate to approval if aggregate PO impact exceeds this |
| `HIGH_VALUE_THRESHOLD` | $5,000 | Always require approval for unit prices above this |
| `FEE_AUTO_APPROVE_CAP_DOLLARS` | $250 | Escalate fee additions/changes above this |
| `VENDOR_FUZZY_THRESHOLD` | 0.5 | Jaccard overlap for vendor name correlation |

**To change any threshold:** Edit `RECONCILIATION_CONFIG` in `src/lib/finale/reconciler.ts` and `pm2 restart aria-bot`.

---

## Adding a Known Dropship Vendor

1. Open `src/lib/intelligence/ap-agent.ts`.
2. Add a keyword to `KNOWN_DROPSHIP_KEYWORDS` — vendor name fragment or email domain, lowercase.
3. `pm2 restart aria-bot`.

---

## Cron Schedule

| Time | Days | Action |
|------|------|--------|
| Every 15 min | Mon–Sun | AP inbox scan (`processUnreadInvoices`) |
| Hourly | Mon–Sun | Advertisement cleanup |
| 8:00 AM | Mon–Fri only | Daily summary + AP recap |

---

## Known Limitations

1. **In-memory pending approvals** — `pm2 restart aria-bot` drops all pending Telegram approval requests. Invoice re-processes on next 15-min cycle.
2. **In-memory pending dropships** — Same restart caveat; 48h TTL. Buttons become orphaned if bot restarts.
3. **Vendor+date fallback** — Finale API may be slow; the fallback is best-effort. A timeout is caught and logged; the invoice proceeds to "No PO Found" flow.
4. **Multi-PDF emails** — Each PDF is processed independently. A single email with two invoices creates two separate reconciliation flows.
5. **Duplicate invoice numbers from different vendors** — The duplicate detection query matches on both `invoiceNumber` AND `orderId`. Same invoice number from two different vendors against two different POs will not false-positive as duplicates.
