# AP Funnel Process — Full Pipeline, SOPs & Crons

## 1. Overview

The AP funnel ingests invoices from `ap@buildasoil.com`, classifies them, matches them to Finale POs, reconciles prices/tracking, and forwards to Bill.com for payment. Every action is logged to `ap_activity_log` for audit trail and dashboard visibility.

**Two inboxes side-by-side:**

| Inbox | Purpose | Auth Token | Pipeline |
|-------|---------|------------|----------|
| `ap@buildasoil.com` | Invoices for processing + Bill.com forwarding | `ap-token.json` (slot "ap") | Full AP funnel (5 stages) |
| `bill.selee@buildasoil.com` | Vendor replies, PO acks, human inquiries | `token.json` (slot "default") | Ack-agent + default inbox classification |

---

## 2. The 5-Stage Pipeline

Each `ap-polling` tick (every 15 min) runs all 5 stages in sequence:

```
Stage 1: Ingest
  ├ Poll Gmail for unread in ap@ / default@ inboxes
  └ Queue raw emails for processing

Stage 2: Route & Classify  
  ├ matchVendorRouting() — deterministic, 0 LLM cost
  │   ├ autopay → mark read, log "Blocked", no forward
  │   ├ dropship → queue for Bill.com, skip PO matching
  │   ├ ignore → archive silently (internal/junk only)
  │   └ amazon_order → route to Amazon parser
  │
  ├ detectAutopay() — heuristic fallback (2-stage: vendor ID + payment verification)
  │
  ├ classifyInvoice() — dropship vs real vs unknown
  │   (single source of truth from invoice-classification.ts)
  │
  └ LLM intent classification (when routing didn't match)
      INVOICE | STATEMENT | ADVERTISEMENT | HUMAN_INTERACTION | PAID_INVOICE

Stage 3: Extract + Match
  ├ PDF extraction chain:
  │   1. Gemini Flash (free)
  │   2. DeepSeek V4 Flash ($0.14/M)
  │   3. Qwen 3 (free)
  │   4. Tesseract.js (local, last resort)
  │
  ├ parseInvoice() → InvoiceData (line items, totals, PO#, vendor)
  │
  └ PO matching:
      ├ Direct PO# from invoice → Finale lookup
      └ Vendor + date fuzzy match (±30-60 days, ±10% amount)

Stage 4: Reconcile + Forward
  ├ reconcileInvoiceToPO()
  │   - Price matching per line item
  │   - Balance validation (catches extraction errors)
  │   - Price change detection (10x guardrail → manual approval)
  │   - Tracking number extraction
  │
  ├ applyReconciliation() → writes to Finale PO
  │
  ├ PO lifecycle transition: ORDERED → INVOICED → RECONCILED
  │
  └ APForwarderAgent → MIME send to buildasoilap@bill.com
      Status: PENDING_FORWARD → PROCESSING_FORWARD → FORWARDED / ERROR_FORWARDING

Stage 5: Post-Run
  ├ Log to ap_activity_log (every action)
  ├ runPOSweep() — catch any POs missed by main path
  ├ Check stuck invoices (email-forwarding-alert every 2h)
  └ Morning report (ap-health-report at 8:30 AM weekdays)
```

---

## 3. Decision Tree

```
Email arrives in ap@buildasoil.com
│
├─ Stage 2: Vendor Routing ──────────────────────────────
│  matchVendorRouting(fromEmail, fromName, subject)
│  │
│  ├──[ignore]────→ archive + mark read. NO log. Internal/junk only.
│  │                (bill.selee@buildasoil.com self-sends)
│  │
│  ├──[autopay]───→ mark read. Log "Blocked: <label>". NO Bill.com forward.
│  │                Paid-elsewhere recurring (Culligan, Gorgias, Google, Pioneer)
│  │
│  ├──[dropship]──→ queue for Bill.com. Skip PO matching.
│  │                Ships direct to customer (AutoPot, Logan Labs, Evergreen, Ferticell)
│  │
│  └──[amazon]────→ route to Amazon order parser (tracking + Slack matching)
│
├─ Stage 2: Autopay Heuristic ────────────────────────────
│  detectAutopay() — runs when vendor routing didn't match
│  │
│  ├── verifiedPaid=true  → OK to archive (subject/snippet confirms payment)
│  └── verifiedPaid=false → LEAVE UNREAD. Log for human escalation.
│
├─ Stage 2: Invoice Classification ───────────────────────
│  classifyInvoice() — deterministic, no LLM
│  │
│  ├── dropship_flow_through → forward to Bill.com, skip PO matching
│  └── real_invoice          → proceed with full processing
│
├─ Stage 2: LLM Intent ───────────────────────────────────
│  (only reached when routing + classification didn't resolve)
│  │
│  ├── ADVERTISEMENT     → archive
│  ├── PAID_INVOICE      → extract → log to paid_invoices → draft PO if unmatched
│  ├── STATEMENT         → queue for statement reconciliation
│  ├── HUMAN_INTERACTION → leave visible in inbox for manual review
│  └── INVOICE           → proceed to Stage 3
│
└─ Stage 3: PO Matching ──────────────────────────────────
    │
    ├── PO# found on invoice → direct Finale lookup
    │
    └── No PO# on invoice → vendor+date fuzzy match
        │
        ├── PO found → reconcile (Stage 4)
        │
        └── PO NOT found → retry OCR (up to 1 time)
            │
            ├── OCR improved → retry match
            └── OCR still fails → log unmatched
                ├── Vendor has PO history? → Telegram alert (critical, 24/7)
                └── No PO history (dropship/freight/one-off) → silent, just log
```

---

## 4. Cron Jobs (AP-Related)

| Cron Name | Schedule | Purpose | Handler | On Fail |
|-----------|----------|---------|---------|---------|
| `ap-polling` | `*/15 * * * *` | Poll both inboxes, run 5-stage pipeline, PO sweep post-pass | `ops.pollAPInbox()` + `ops.runPOSweep()` | log |
| `followup-sop` | `0 */2 * * *` | Stale Slack requests + AP forwarding alerts (24/7) | `runStaleRequestWatcher()` + `runForwardingEscalation()` | log |
| `ap-health-report` | `30 8 * * 1-5` | **Morning AP pipeline health summary** to Telegram | `generateAPHealthReport()` → `sendTelegramNotify()` | telegram-will |
| `expire-stale-approvals` | `0 6 * * *` | Mark expired pending approvals as 'expired' in DB | `expireStaleApprovals()` | log |
| `missing-reconciliation-watchdog` | `0 9 * * 1-5` | Alert if any vendor missed 24h reconciliation window | `ops.checkMissingReconciliationRuns()` | telegram-will |
| `po-receipt-recheck` | `*/30 * * * *` | Re-check reconciled invoices vs newly received goods | `recheckReconciledInvoices()` | log |
| `po-arrival-risk-check` | `0 */2 * * *` | Detect POs that will arrive after stockout | `ops.runPOArrivalRiskCheck()` | log |
| `cognitive-round` | `*/15 * * * *` | Survey state, decide priorities, suppress/boost crons | `runCognitiveRound()` | log |

### Critical-notify vs Business-hours-gated

| Path | Gate | Used By |
|------|------|---------|
| `sendTelegramNotify()` | Mon-Fri 7AM-5PM Denver | Morning reports, routine summaries |
| `sendCriticalTelegramNotify()` | **None — always sends** | Stuck invoice alerts, system failures |
| `businessHoursAlert()` | Mon-Fri 7AM-5PM Denver | Cron results, status updates (Telegraf path) |
| `criticalAlert()` | **None — always sends** | Crash loops, data corruption (Telegraf path) |

---

## 5. Decision Rules (Semantic Precision)

These three routing actions are NOT interchangeable:

| Action | Behavior | Use Case | Example |
|--------|----------|----------|---------|
| `ignore` | Archive + mark read. **No log, no record.** | Internal/junk only | bill.selee self-sends |
| `autopay` | Mark read. **Logs "Blocked: <label>"**. No Bill.com forward. | Paid elsewhere, recurring | Culligan Water, Gorgias, Google Workspace |
| `dropship` | Forward PDFs to Bill.com. Skip PO matching. **Logs drop-through.** | Ships direct to customer | AutoPot, Logan Labs, Ferticell, Evergreen Growers |

**Decision rule:**
- Paid on autopay / not via Bill.com → `autopay` (logged, no forward)
- Ships direct to customer, pay via Bill.com → `dropship` (forward, no match)
- Freight carrier (AAA Cooper, FedEx) paid via Bill.com → **NO rule** — forward normally
- Internal/junk only → `ignore`

**Do NOT `ignore` a vendor whose bills must still be paid.** `ignore` archives with no forward AND no log.

---

## 6. Data Tables (Supabase)

| Table | Purpose | Key Columns | Intent Coverage |
|-------|---------|-------------|----------------|
| `ap_activity_log` | **Central audit trail** — every pipeline step logged | `id, created_at, email_from, email_subject, intent, action_taken, metadata (JSONB)` | INVOICE, BILL_FORWARD, DROPSHIP, OCR_RETRY, RECONCILIATION, PAID_INVOICE, STATEMENT, ADVERTISEMENT, HUMAN_INTERACTION, BLOCKED_SENDER, PO_RECEIVED, PROCESSING_ERROR, PO_ARRIVAL_AT_RISK, EXCEPTION_ESCALATED, RECEIPT_PROMPT |
| `ap_inbox_queue` | Forward queue lifecycle | `id, message_id, email_from, email_subject, extracted_json (JSONB), status, error_message` | PENDING_FORWARD → PROCESSING_FORWARD → FORWARDED / ERROR_FORWARDING |
| `ap_pending_approvals` | Human approval workflow | `id, invoice_identifier, vendor_name, total, status, expires_at` | pending → approved / rejected / expired (24h) |
| `vendor_po_patterns` | OCR hint learning per vendor | `vendor_name, fail_count, success_count, ocr_hint` | Auto-generated hints after 3+ failures |
| `purchase_orders` | Finale PO local copy | `order_id, lifecycle_state, vendor_name, total` | ORDERED → INVOICED → RECONCILED → RECEIVED → COMPLETED |
| `po_lifecycle_transitions` | PO state audit trail | `po_number, from_state, to_state, triggered_by` | Every state transition logged |
| `reconciliation_outcomes` | Observability | `id, outcome, vendor_name, po_number, created_at` | matched, rejected, needs_approval, failed |

---

## 7. SOPs

### SOP-AP1: Morning Health Check
**Trigger**: Cron `ap-health-report` at 8:30 AM weekdays
**Action**: Generate 6-section report from `ap_activity_log` (24h) + `ap_inbox_queue`:
1. Invoices processed by intent
2. Match rate (matched vs unmatched)
3. Stuck invoices count (excludes zombie records)
4. OCR issues (retries, zero-line-item outcomes)
5. Reconciliation issues
6. Overall status ✅/⚠️/🚨
**Output**: Telegram Markdown message

### SOP-AP2: Stuck Invoice Escalation
**Trigger**: Cron `followup-sop` every 2 hours
**Action**:
1. Query `ap_inbox_queue` WHERE status IN ('ERROR_FORWARDING', 'ERROR_PROCESSING') AND updated_at < 2h ago
2. Filter OUT zombie records (extracted_json IS NULL or has no from/vendor_name/subject)
3. If any meaningful stuck items remain → `sendCriticalTelegramNotify()` (24/7, no gate)
**Output**: Telegram alert with vendor, age, and status details

### SOP-AP3: Stale Approval Expiry
**Trigger**: Cron `expire-stale-approvals` daily at 6 AM
**Action**: UPDATE `ap_pending_approvals` SET status='expired' WHERE status='pending' AND expires_at < NOW()
**Purpose**: Prevents stale approvals from accumulating in the DB

### SOP-AP4: OCR Retry (Built into Pipeline)
**Trigger**: First-pass extraction produces po_missing, zero_line_items, or total_zero
**Action**: Force LLM OCR retry (bypasses text-density check)
**If improved**: Re-run PO matching
**If not improved**: Log as UNMATCHED, continue with whatever was extracted
**Escalation**: If vendor has PO history → critical alert (24/7). If no PO history → silent log.

### SOP-AP5: Balance Validation Guardrail
**Trigger**: Reconciliation computes invoice total that differs from stated amount by >50%
**Action**: `reject_10x` outcome → force manual approval via `ap_pending_approvals`
**Purpose**: Catches OCR extraction errors (common when PDF has mixed content types)

---

## 8. File Map

| File | Role |
|------|------|
| `src/lib/intelligence/email-polling-cycle.ts` | Orchestrates 5-stage pipeline sequence |
| `src/lib/intelligence/services/ap-service.ts` | Thin wrapper: wires deps and calls polling cycle |
| `src/lib/intelligence/workers/email-ingestion.ts` | `EmailIngestionWorker` — fetches unread Gmail messages |
| `src/lib/intelligence/ap/vendor-router.ts` | `matchVendorRouting()` — deterministic pre-LLM routing |
| `src/lib/intelligence/ap/autopay-detector.ts` | `detectAutopay()` — heuristic fallback (2-stage) |
| `src/config/invoice-classification.ts` | `classifyInvoice()` — single source of truth for dropship vs real |
| `src/lib/intelligence/workers/ap-identifier.ts` | `APIdentifierAgent` — LLM intent classification + extraction |
| `src/lib/intelligence/ap-agent.ts` | `APAgent` — full invoice processing (extract, match, reconcile, log) |
| `src/lib/intelligence/workers/ap-forwarder.ts` | `APForwarderAgent` — MIME send to buildasoilap@bill.com |
| `src/lib/finale/reconciler.ts` | `reconcileInvoiceToPO()` + `applyReconciliation()` + guardrails |
| `src/lib/intelligence/email-forwarding-alert.ts` | `runForwardingEscalation()` — stuck invoice alert (critical path) |
| `src/lib/intelligence/ap-health-report.ts` | `generateAPHealthReport()` — morning pipeline summary |
| `src/lib/intelligence/telegram-notify.ts` | `sendTelegramNotify()` (gated) + `sendCriticalTelegramNotify()` (ungated) |
| `src/lib/intelligence/alert-gate.ts` | `isBusinessHours()`, `businessHoursAlert()`, `criticalAlert()` |
| `src/cron/jobs/index.ts` | All cron registrations |
| `src/lib/intelligence/ops-manager.ts` | OpsManager singleton — top-level coordinator |