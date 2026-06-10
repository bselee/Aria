# Vendor Routing Rules

## Overview

The `vendor-router.ts` module provides deterministic email routing rules that execute **before** the LLM classification stage. This enables fast, deterministic handling of emails from known vendors without consuming LLM tokens.

**Key Principle:** Routing rules are evaluated sequentially until the first match wins. Order within action groups matters.

---

## Routing Actions

### 1. `autopay` — Autopay/Recurring Vendors
**Behavior:** Mark email as read, archive, no Bill.com forward

**When to use:**
- Monthly recurring services (utilities, subscriptions)
- Vendors we pay but don't invoice-match (not in our PO system)
- Payment confirmations already processed elsewhere

**Current rules:**
- `wwex.com` (Worldwide Express autopay)
- `pioneer propane` keyword
- `gorgias.com` domain
- `gorgias` keyword (name/email)
- `google.com` domain
- `google workspace` keyword
- `google cloud` keyword
- `culligan` keyword
- `terminix` keyword
- Subject contains `build a soil statement`
- Sender `buildasoil.com` + subject `statement`

---

### 2. `dropship` — Dropship Vendors
**Behavior:** Forward PDF to Bill.com, mark read, skip PO matching

**When to use:**
- Third-party vendors shipping directly to customers on our behalf
- Known partner integrations (AutoPot, Logan Labs, etc.)
- Invoices that should be paid but not matched against our POs

**Current rules:**
- `logan labs` keyword
- `autopot` keyword
- `evergreen growers` keyword (and `evergreen grow`)
- `ferticell` keyword (and `fert` substring)
- QuickBooks dropship rules:
  - `quickbooks` sender + subject `logan labs`
  - `quickbooks` sender + subject `autopot`
  - `quickbooks` sender + subject `fert`

**Why QuickBooks rules are AND logic:** These vendors sometimes invoice through QuickBooks (dropship) and sometimes directly (autopay). The combined sender+subject rule prevents misclassification.

---

### 3. `ignore` — Internal/Junk Emails
**Behavior:** Archive, mark read, completely silent (no activity log)

**When to use:**
- Internal forwarded messages (e.g., bill.selee@buildasoil.com forwarding to AP inbox)
- System-generated confirmations we don't need to track
- Test emails

**⚠️ Caution:** Use sparingly. `ignore` is completely silent — no audit trail. Prefer `autopay` for anything that should be logged.

**Current rules:**
- `bill.selee@buildasoil.com` exact sender

---

### 4. `amazon_order` — Amazon Order Confirmations
**Behavior:** Route to Amazon order parser for tracking extraction and Slack request matching

**When to use:**
- Amazon order confirmations
- Amazon shipping notifications
- Amazon tracking updates

**Current rules:**
- `auto-confirm@amazon` sender
- `ship-confirm@amazon` sender
- `shipment-tracking@amazon` sender
- `order-update@amazon` sender

---

## Rule Matching Logic

The `matchVendorRouting()` function evaluates rules in this order:

1. **Domain exact match** — Full domain comparison (e.g., `wwex.com`)
2. **Sender exact match** — Full email address comparison (e.g., `bill.selee@buildasoil.com`)
3. **Sender contains + optional subject contains** — If both fields provided, BOTH must match
4. **Subject only contains** — If only subject field provided, subject-only rule

**Sequential evaluation:** Rules are checked in array order until first match wins.

**Case-insensitive:** All matching is lowercase-normalized.

---

## Adding New Rules

### Step 1: Identify the vendor pattern

```bash
# Recent emails from the vendor
SELECT email_from, email_subject, metadata->>'vendorName' 
FROM ap_activity_log 
WHERE created_at > NOW() - INTERVAL '30 days' 
  AND (email_from ILIKE '%vendor%' OR metadata->>'vendorName' ILIKE '%vendor%')
ORDER BY created_at DESC
LIMIT 20;
```

### Step 2: Determine the action

- **Autopay?** → We pay them monthly/recurring but don't match to POs
- **Dropship?** → Third-party ships to customers, we forward invoice to Bill.com
- **Internal?** → Our own messages (use `ignore`, but audit log is lost!)
- **Amazon?** → Order tracking extraction for Slack integration

### Step 3: Add to `VENDOR_ROUTING_RULES`

```typescript
// Place in appropriate action group
{
  match: {
    // Choose one or combine:
    domain: '',                // e.g., 'wwex.com'
    fromExact: '',             // e.g., 'bill.selee@buildasoil.com'
    senderContains: '',        // e.g., 'google workspace'
    subjectContains: '',       // AND logic if senderContains also provided
  },
  action: 'autopay' | 'dropship' | 'ignore' | 'amazon_order',
  label: 'Human-readable label for activity logs'
},
```

### Step 4: Test the rule

```bash
# Verify the rule matches as expected
npx vitest run src/lib/ap/vendor-router.test.ts --grep "your test name"
```

### Step 5: Monitor after deployment

```bash
# Check logs after a few hours
tail -f pm2.log | grep -i "vendor.*routing"

# Query activity log for the vendor
SELECT COUNT(*) AS matches, created_at::date AS date
FROM ap_activity_log
WHERE metadata->>'vendor' = 'Your Vendor Name'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY created_at::date
ORDER BY date DESC;
```

---

## Common Pitfalls

### 1. **Over-specific rules blocking legitimate invoices**
Bad: Routing all `@supplier.com` emails to `ignore` when they sometimes send invoices
Good: Use `senderContains` with specific subdomain or subject pattern

### 2. **Using `ignore` for non-internal emails**
Bad: `{ match: { senderContains: 'paypal' }, action: 'ignore' }`
Good: `{ match: { senderContains: 'paypal' }, action: 'autopay' }`
Why: `ignore` is completely silent — no activity log, no trace. Hard to debug later.

### 3. **Subject-only rules conflicting with multiple senders**
Bad: `{ match: { subjectContains: 'invoice' }, action: 'autopay' }`
Why: This will match ANY email containing "invoice" from any sender!
Good: Combine with sender: `{ match: { senderContains: 'specific-vendor', subjectContains: 'invoice' }, action: 'autopay' }`

### 4. **Missing case variations**
Bad: `{ match: { senderContains: 'PayPal' }, action: 'autopay' }`
Why: Won't match `paypal` (lowercase)
Solution: All matching is already case-insensitive, so this is actually fine!

### 5. **AND logic rules placed too late**
Bad: Placing `{ match: { subjectContains: 'invoice' }, action: 'ignore' }` BEFORE an AND rule
Why: The subject-only rule will match first and prevent the AND rule from ever winning
Good: Order is crucial — place more specific rules first.

---

## Debugging Routing Issues

### Problem: Email not routing correctly

**Step 1: Check the activity log**
```bash
SELECT * FROM ap_activity_log 
WHERE email_from ILIKE '%problem-vendor%'
  AND created_at > NOW() - INTERVAL '1 day'
ORDER BY created_at DESC
LIMIT 10;
```

Look at:
- `action_taken` — What did the router decide?
- `metadata->>'vendor'` — Vendor name extracted
- `intent` — Was it classified as INVOICE, STATEMENT, etc.?

**Step 2: Test the routing logic directly**

```typescript
import { matchVendorRouting } from './vendor-router';

const result = matchVendorRouting('problem@vendor.com', 'Vendor Name', 'Invoice #123');
console.log(result);
// { action: 'autopay', label: '...', ... } or null
```

**Step 3: Verify rule precedence**

Rules are evaluated in order. If a broad rule (e.g., `subjectContains: 'invoice'`) comes before a specific rule, the broad rule wins.

**Step 4: Check the cron logs**

```bash
pm2 logs ap-invoice-fetcher --lines 100 | grep -i "vendor.*routing"
```

---

## Integration with Other AP Systems

### 1. **Invoice classification (`invoice-classification.ts`)**
Routing rules run BEFORE invoice classification. If a rule matches, classification doesn't override the routing decision.

**Flow:**
```
Email → vendor-router → match? → use routing action
                              → no match? → invoice-classification → further processing
```

### 2. **Forwarding alerts (`email-forwarding-alert.ts`)**
If a vendor is in an `autopay` or `dropship` route, the email won't reach the `FORWARDED` status. It will be logged as:
- `autopay`: `action: 'marked_read_no_forward'`
- `dropship`: `action: 'queued'` (but `vendor_routing_action: 'dropship'` in metadata)
- `ignore`: No log entry

### 3. **Morning report (`ap-health-report.ts`)**
The health report counts all emails by status. Routing rules reduce the number of emails entering full processing, which should improve the healthy/critical ratio.

---

## Future Enhancements

### Planned:
- **Vendor-specific retry strategies** — Different retry logic per vendor (e.g., AutoPot always needs longer OCR time)
- **Auto-learning rules** — When a vendor fails 5+ times, suggest adding a routing rule
- **Dynamic rule management** — Dashboard UI to add/edit routing rules without code changes

### Under Consideration:
- **Time-based rules** — E.g., route all emails from `supplier@vendor.com` to `ignore` on weekends
- **Size-based rules** — E.g., route emails > 10MB to manual review
- **Attachment-based rules** — E.g., route emails with `.csv` to a different parser

---

## Quick Reference Card

| Problem | Solution |
|---------|----------|
| "Why isn't this email being routed?" | Check rule order — earlier rules take precedence |
| "This email should be dropship but it's autopay" | Check QuickBooks rules — combined sender+subject must match |
| "Too many emails from this vendor" | Add routing rule or increase dedup window |
| "This vendor always needs manual review" | Consider adding an exception in invoice classification |
| "How do I test a rule?" | `npx vitest run vendor-router.test.ts --grep "test name"` |
| "How do I debug a routing decision?" | Query `ap_activity_log` for `action_taken` field |

---

## Examples

### Example 1: Adding a new autopay vendor

```typescript
{
  match: {
    senderContains: 'new-vendor',
  },
  action: 'autopay',
  label: 'New Vendor (Monthly Subscription)'
},
```

### Example 2: Adding a QuickBooks dropship vendor

```typescript
{
  match: {
    senderContains: 'quickbooks',
    subjectContains: 'new-partner',
  },
  action: 'dropship',
  label: 'New Partner via QuickBooks'
},
```

### Example 3: Ignoring specific internal forwards

```typescript
{
  match: {
    fromExact: 'ceo@company.com',
  },
  action: 'ignore',
  label: 'CEO Internal Forwards'
},
```

### Example 4: Complex AND logic rule

```typescript
{
  match: {
    senderContains: 'supplier',
    subjectContains: 'credit memo',
  },
  action: 'autopay',
  label: 'Credit Memos (Auto-Archive)'
},
```

---

## Maintenance

**Last updated:** 2026-06-10
**Maintainer:** Hermia / AP team
**Review cadence:** Quarterly (or when routing issues reported)

**Before making changes:**
1. Query recent emails from the vendor
2. Test the rule locally
3. Deploy to staging first
4. Monitor activity logs for 24 hours
5. Verify correct routing decisions in production
