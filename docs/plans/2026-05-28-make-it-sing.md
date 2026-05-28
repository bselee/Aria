# Aria Make It Sing — Master Plan

> **Goal:** Flush out the email process, dashboard lifecycle, autonomous AP flow, tracking & follow-up — make the whole system sing.

## Architecture Overview

Aria processes **two inboxes** independently with distinct purposes:
- `ap@buildasoil.com` → invoices, vendor bills → Bill.com
- `bill.selee@buildasoil.com` → vendor comms, PO replies, tracking, general

The 5-stage **email polling cycle** (every 15 min):
```
Stage 1: email-ingestion (default)   → email_inbox_queue
Stage 2: acknowledgement-agent        → classify + auto-reply or flag
Stage 3: email-ingestion (AP)         → email_inbox_queue (AP source)
Stage 4: ap-identifier                → classify + ap_inbox_queue
Stage 5: ap-forwarder                 → forward to Bill.com
```

**32 cron jobs** run periodic work: PO follow-up, tracking polls, vendor reconciliation, build risk, daily summaries, etc.

**Dashboard** has 25+ panels across Purchasing, Builds, Tracking, Invoice Queue, Statement Reconciliation, and Command Board.

---

## Phase 1: Email Process — Flush Out

### Gap 1.1: REQUIRES_HUMAN surfacing ❌ → ✅ DONE
When ack-agent classifies an email as REQUIRES_HUMAN, it logs to feedback but **never pings Bill**. 
**Fix:** Batch collect during processing → single Telegram digest at end of cycle.
**Status:** ✅ Shipped (acknowledgement-agent.ts — requiresHumanBatch)

### Gap 1.2: Email search from Telegram ❌
Bill can't ask "what did Grassroots say last?" or "find me the ULINE tracking email" from Telegram.
**Fix:** New `/emailsearch <query>` command — searches email_inbox_queue + ap_inbox_queue by subject, from, body text. Returns concise results with snippet.
**File:** `src/cli/commands/hermia.ts` + new `src/lib/intelligence/email-search.ts`

### Gap 1.3: Promotional classification costs LLM tokens ❌
The ack-agent calls LLM to classify every email. ~60% are clearly promotional (newsletters, no-reply, system senders) that regex could catch.
**Fix:** Expand regex fast-path to catch common promotional patterns BEFORE the LLM call. Already partially done — extend the pattern library.
**File:** `src/lib/intelligence/acknowledgement-agent.ts`

### Gap 1.4: Email→task conversion ❌
When Bill says "remind me to reply to the Grassroots email" in chat, there's no structured workflow.
**Fix:** Chat command handler that extracts sender/subject keywords → creates an agent_task → appears in dashboard TasksPanel.
**File:** `src/lib/intelligence/email-task-creator.ts` (new)

### Gap 1.5: Thread context in ack agent ❌
Individual email classification misses conversation threads — a "REQUIRES_HUMAN" email that's actually a reply to an already-handled conversation gets flagged unnecessarily.
**Fix:** Before classifying, check if the thread_id has already been processed by ack-agent. If so, inherit the prior classification unless the content is clearly different.
**File:** `src/lib/intelligence/acknowledgement-agent.ts`

---

## Phase 2: Dashboard Lifecycle

### Gap 2.1: Unified Pipeline View ❌
No single view showing email→invoice→PO→receive→reconcile as one timeline.
**Fix:** New `PipelinePanel` component — horizontal swimlanes for each PO showing:
  - Email received → Invoice identified → Forwarded to Bill.com → PO created → Committed → Sent → Acked → Tracking received → In transit → Delivered → Received → Reconciled
**File:** `src/components/dashboard/PipelinePanel.tsx` (new) + API route

### Gap 2.2: Vendor Scorecard ❌
No dashboard view of vendor performance.
**Fix:** New `VendorScorecardPanel` showing per-vendor:
  - Avg response time (PO sent → vendor acked)
  - On-time delivery rate (expected vs actual delivery)
  - Invoice accuracy (reconciliation pass rate)
  - Last 5 POs with status
**File:** `src/components/dashboard/VendorScorecardPanel.tsx` (new) + API route

### Gap 2.3: PO Aging Dashboard ❌
No color-coded view of POs by age.
**Fix:** Extend ActivePurchasesPanel with:
  - Green: < 7 days since sent
  - Yellow: 7-14 days
  - Orange: 14-21 days  
  - Red: > 21 days or overdue
  - Stripe pattern for POs with no tracking
**File:** Modify `src/components/dashboard/ActivePurchasesPanel.tsx`

### Gap 2.4: Daily Ops Summary on Dashboard ❌
Currently only in Telegram cron. No persistent dashboard view.
**Fix:** New `DailyOpsSummaryPanel` — shows today's email volume, AP invoices processed, POs created/committed/sent, tracking updates, vendor acks.
**File:** `src/components/dashboard/DailyOpsSummaryPanel.tsx` (new) + API route

---

## Phase 3: Autonomous AP Flow

### Gap 3.1: Invoice Auto-Approval ❌
When invoice matches PO exactly (within tolerance), it should auto-approve and route to Bill.com paid queue.
**Fix:** In reconciler, add auto-approve logic:
  - Match found: price within ±$0.05, quantities match, all lines present
  - No human review needed → mark approved → log to ap_activity_log as "auto_approved"
  - Telegram notification only for significant mismatches
**File:** `src/lib/finale/reconciler.ts` + `src/lib/intelligence/ap-agent.ts`

### Gap 3.2: Vendor Dispute Auto-Draft ❌
When reconciliation finds a significant discrepancy, it should draft an email to the vendor.
**Fix:** New `dispute-drafter.ts`:
  - Triggered when reconciliation result has `needs_approval` + delta > threshold
  - Builds professional email citing specific line items, PO vs invoice amounts
  - Creates Gmail draft for Bill to review
**File:** `src/lib/intelligence/dispute-drafter.ts` (new)

### Gap 3.3: Duplicate Invoice Detection ❌
Multi-email threads or vendor resends can create duplicate invoice entries.
**Fix:** Before inserting to ap_inbox_queue, check for existing entries with same:
  - invoice_number + vendor_name
  - Or same pdf_content_hash
  - If duplicate found → log as "duplicate_skipped" + mark original email read
**File:** `src/lib/intelligence/workers/ap-identifier.ts`

### Gap 3.4: Payment Terms Awareness ❌
No knowledge of vendor payment terms (net-30, net-15, due on receipt).
**Fix:** Add payment_terms to vendor_profiles table. When forwarding to Bill.com, include payment terms in the MIME body so Bill.com can schedule payments accordingly.
**Files:** Migration + `src/lib/intelligence/workers/ap-forwarder.ts`

---

## Phase 4: Tracking & Follow-Up

### Gap 4.1: Delivery Exception Auto-Escalation ❌
When tracking shows "exception" or "return to sender", it just sits in the exception bucket.
**Fix:** New cron job `delivery-exception-escalator`:
  - Polls shipment_intelligence for exceptions
  - Auto-drafts vendor email with tracking # and exception details
  - Telegram alert to Bill
**Files:** `src/lib/tracking/delivery-exception-escalator.ts` (new) + cron entry

### Gap 4.2: Receiving Dock Calendar ❌
No auto-populated receiving calendar.
**Fix:** When PO is committed + tracking received:
  - Create Google Calendar event "Receive: PO #XXXX from Vendor" on ETA date
  - Update on delivery date
  - Mark complete on receipt
**File:** `src/lib/tracking/receiving-calendar.ts` (new)

### Gap 4.3: Auto-Receiving Prompt ❌
When tracking shows "delivered" + 24h passes, Bill should be prompted to confirm receipt → auto-receive in Finale.
**Fix:** Extend `po-receiving-watcher` cron:
  - Check delivered_at + 24h > now
  - Send Telegram: "PO #XXXX from Vendor was delivered yesterday. Confirm receipt?"
  - On confirm → call Finale receive endpoint
**File:** `src/lib/tracking/shipment-intelligence.ts` + Telegram command

### Gap 4.4: Multi-Shipment PO Consolidation ❌
One PO can have shipments from multiple carriers. Currently shown separately.
**Fix:** In POStepper, group shipments under the PO and show consolidated delivery status:
  - "2 of 3 shipments delivered" with progress bar
  - ETA = latest estimated_delivery_at across all shipments
**File:** Modify `src/components/dashboard/POStepper.tsx`

### Gap 4.5: L2 Escalation — Non-Responsive Vendors ❌
L1 follow-up drafts a gentle poke. If vendor still doesn't respond after 14 days, no escalation.
**Fix:** Extend po-followup-watcher:
  - L1: 5-9 days → gentle draft (exists)
  - L2: 10-14 days → firmer draft mentioning reorder risk
  - L3: 15+ days → Telegram alert to Bill with "Consider alternate vendor" suggestion
**File:** Modify `src/lib/purchasing/po-followup-watcher.ts` + `src/lib/intelligence/vendor-comms-agent.ts`

---

## Priority Matrix

| Phase | Task | Impact | Effort | Priority |
|-------|------|--------|--------|----------|
| 1 | 1.2 Email search from Telegram | HIGH | Low | **P1** |
| 1 | 1.3 Promotional regex expansion | MEDIUM | Medium | P2 |
| 1 | 1.4 Email→task conversion | MEDIUM | Medium | P2 |
| 1 | 1.5 Thread context in ack agent | MEDIUM | Medium | P3 |
| 2 | 2.1 Unified Pipeline View | HIGH | High | **P1** |
| 2 | 2.2 Vendor Scorecard | HIGH | Medium | **P1** |
| 2 | 2.3 PO Aging Dashboard | MEDIUM | Low | P2 |
| 2 | 2.4 Daily Ops Summary on Dashboard | MEDIUM | Medium | P2 |
| 3 | 3.1 Invoice Auto-Approval | HIGH | Medium | **P1** |
| 3 | 3.2 Vendor Dispute Auto-Draft | MEDIUM | Medium | P2 |
| 3 | 3.3 Duplicate Invoice Detection | MEDIUM | Low | P2 |
| 3 | 3.4 Payment Terms Awareness | LOW | Low | P3 |
| 4 | 4.1 Delivery Exception Auto-Escalation | HIGH | Medium | **P1** |
| 4 | 4.2 Receiving Dock Calendar | MEDIUM | Medium | P2 |
| 4 | 4.3 Auto-Receiving Prompt | HIGH | Low | **P1** |
| 4 | 4.4 Multi-Shipment PO Consolidation | LOW | Low | P3 |
| 4 | 4.5 L2/L3 Vendor Escalation | HIGH | Medium | **P1** |

## Execution Order

1. **Email search** (quick win, immediate utility for Bill)
2. **Vendor Scorecard** (dashboard visibility, helps Bill make vendor decisions)
3. **Invoice Auto-Approval** (biggest time saver in AP flow)
4. **Auto-Receiving Prompt** (closes the loop on receiving)
5. **L2/L3 Vendor Escalation** (stops Bill from chasing ghosts)
6. **Delivery Exception Auto-Escalation** (prevents lost shipments)
7. **Unified Pipeline View** (big dashboard overhaul, tackle after smaller wins)
8. Remaining P2/P3 items in priority order

---

## Technical Notes

- All new modules follow existing patterns: `@file` headers, JSDoc, Zod schemas
- Telegram commands use `BotCommand` interface from `src/cli/commands/types.ts`
- New cron jobs use `defineJob()` from `src/cron/registry.ts`
- Dashboard panels register in `src/components/dashboard/command-board/panelRegistry.tsx`
- Supabase migrations go in `supabase/migrations/` with rollback comments
- Skip typecheck (token burner) — build and test manually
- PM2: `pm2 restart aria-bot` after code changes; `npm run build && pm2 reload aria-dashboard` for dashboard
- Git: commit after every logical unit with descriptive message
