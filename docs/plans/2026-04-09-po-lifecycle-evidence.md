# PO Lifecycle Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an evidence-driven PO lifecycle so purchasing surfaces show the real process from draft creation through AP completion, including acknowledgements, tracking unavailable handling, broad in-transit state, and daily movement updates.

**Architecture:** Extend `purchase_orders` with lifecycle evidence fields, add shared lifecycle/evidence helpers under `src/lib/purchasing/`, and reuse them from `po-sender`, `syncPOConversations`, `tracking-agent`, `shipment-intelligence`, the active-purchases API, and the purchasing calendar/dashboard. Keep `POCompletionState` as the AP truth after receipt, but stop letting each surface invent its own shipping-state heuristics.

**Tech Stack:** TypeScript, Vitest, Supabase, Gmail API, Finale client, existing tracking/shipment intelligence

---

### Task 1: Add lifecycle schema support to `purchase_orders`

**Files:**
- Create: `supabase/migrations/20260409_add_po_lifecycle_evidence.sql`
- Reference: `supabase/migrations/20260227_create_purchase_orders.sql`

**Step 1: Write the migration**

Add columns:
- `lifecycle_stage TEXT`
- `draft_created_at TIMESTAMPTZ`
- `committed_at TIMESTAMPTZ`
- `po_sent_at TIMESTAMPTZ`
- `po_email_message_id TEXT`
- `vendor_acknowledged_at TIMESTAMPTZ`
- `vendor_ack_source TEXT`
- `shipping_evidence JSONB DEFAULT '[]'::jsonb`
- `tracking_status_summary TEXT`
- `tracking_unavailable_at TIMESTAMPTZ`
- `tracking_requested_at TIMESTAMPTZ`
- `tracking_request_count INTEGER DEFAULT 0`
- `last_tracking_evidence_at TIMESTAMPTZ`
- `last_movement_update_at TIMESTAMPTZ`
- `last_movement_summary TEXT`

Also add:
- useful comments
- indexes on `lifecycle_stage`, `tracking_requested_at`, and `vendor_acknowledged_at`

**Step 2: Sanity check the migration text**

Run:
```bash
Get-Content supabase/migrations/20260409_add_po_lifecycle_evidence.sql
```

Expected:
- all columns present
- no syntax typos

**Step 3: Commit**

```bash
git add supabase/migrations/20260409_add_po_lifecycle_evidence.sql
git commit -m "feat(purchasing): add PO lifecycle evidence columns"
```

### Task 2: Add a shared PO lifecycle/evidence helper

**Files:**
- Create: `src/lib/purchasing/po-lifecycle-state.ts`
- Create: `src/lib/purchasing/po-lifecycle-state.test.ts`
- Create: `src/lib/purchasing/po-lifecycle-evidence.ts`
- Create: `src/lib/purchasing/po-lifecycle-evidence.test.ts`
- Reference: `src/lib/purchasing/po-completion-state.ts`
- Reference: `src/lib/purchasing/po-receipt-state.ts`

**Step 1: Write the failing lifecycle tests**

Cover:
- `draft_created`
- `committed`
- `sent`
- `vendor_acknowledged`
- `in_transit` from invoice/shipping evidence without tracking
- `moving_with_tracking` from trusted tracking or ETA evidence
- `tracking_unavailable` when evidence implies shipment but no trustworthy tracking was found and cooldown allows a request
- `received`
- `ap_follow_up`
- `complete`

**Step 2: Run the lifecycle tests to verify failure**

Run:
```bash
npx vitest run src/lib/purchasing/po-lifecycle-state.test.ts src/lib/purchasing/po-lifecycle-evidence.test.ts
```

Expected:
- FAIL because helper files do not exist yet

**Step 3: Implement minimal types and derivation**

In `po-lifecycle-state.ts`, add:
- lifecycle stage union
- normalized evidence input type
- `derivePOLifecycleState()`
- `shouldRequestTrackingFollowUp()`

In `po-lifecycle-evidence.ts`, add:
- helpers to normalize shipping evidence entries
- helpers to summarize movement updates
- helpers to choose trusted ETA/tracking evidence

**Step 4: Re-run tests until green**

Run:
```bash
npx vitest run src/lib/purchasing/po-lifecycle-state.test.ts src/lib/purchasing/po-lifecycle-evidence.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/po-lifecycle-state.ts src/lib/purchasing/po-lifecycle-state.test.ts src/lib/purchasing/po-lifecycle-evidence.ts src/lib/purchasing/po-lifecycle-evidence.test.ts
git commit -m "feat(purchasing): derive PO lifecycle from evidence"
```

### Task 3: Persist PO send lifecycle evidence at commit/send time

**Files:**
- Modify: `src/lib/purchasing/po-sender.ts`
- Test: `src/lib/copilot/actions.po-send.test.ts`
- Test: `src/lib/purchasing/po-sender.test.ts`

**Step 1: Write failing tests**

Add tests that expect:
- committing a PO records `committed_at`
- emailing a PO records `po_sent_at`
- the Gmail message id is written to both `po_sends` and `purchase_orders`
- lifecycle stage advances to `sent` after successful send

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/lib/copilot/actions.po-send.test.ts src/lib/purchasing/po-sender.test.ts
```

Expected:
- FAIL because `purchase_orders` lifecycle evidence is not updated yet

**Step 3: Implement minimal persistence**

Update `commitAndSendPO()` to upsert into `purchase_orders`:
- `po_number`
- `vendor_name`
- `committed_at`
- `po_sent_at`
- `po_email_message_id`
- `lifecycle_stage`
- `updated_at`

Keep `po_sends` unchanged as the historical log.

**Step 4: Re-run the tests**

Run:
```bash
npx vitest run src/lib/copilot/actions.po-send.test.ts src/lib/purchasing/po-sender.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/po-sender.ts src/lib/copilot/actions.po-send.test.ts src/lib/purchasing/po-sender.test.ts
git commit -m "feat(purchasing): persist PO send lifecycle evidence"
```

### Task 4: Capture vendor acknowledgement and shipping evidence from PO thread sync

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Create: `src/lib/intelligence/ops-manager.po-sync.test.ts`
- Reference: `src/lib/purchasing/po-lifecycle-evidence.ts`

**Step 1: Write failing tests**

Add tests around `syncPOConversations()` behavior for:
- first vendor reply sets `vendor_acknowledged_at`
- outside-thread communication suppresses automated follow-up
- invoice/shipping language can create broad `in_transit` even without tracking
- clear ETA can create richer movement evidence
- tracking unavailable state is only suggested after threshold/cooldown, not immediately

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/lib/intelligence/ops-manager.po-sync.test.ts
```

Expected:
- FAIL because lifecycle evidence is not being persisted

**Step 3: Implement minimal evidence writes**

Update `syncPOConversations()` to:
- write `vendor_acknowledged_at` and `vendor_ack_source`
- append normalized shipping evidence into `purchase_orders.shipping_evidence`
- set `tracking_requested_at` and increment `tracking_request_count` when a follow-up is sent
- set `tracking_unavailable_at` only when the helper says it is appropriate
- derive and persist `lifecycle_stage`

Do not replace existing tracking alert behavior.

**Step 4: Re-run the tests**

Run:
```bash
npx vitest run src/lib/intelligence/ops-manager.po-sync.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts src/lib/intelligence/ops-manager.po-sync.test.ts
git commit -m "feat(purchasing): capture PO acknowledgement and shipping evidence"
```

### Task 5: Upgrade tracking ingestion to feed lifecycle movement state

**Files:**
- Modify: `src/lib/intelligence/tracking-agent.ts`
- Modify: `src/lib/tracking/shipment-intelligence.ts`
- Modify: `src/lib/tracking/shipment-intelligence-read.test.ts`
- Modify: `src/lib/intelligence/tracking-agent.test.ts`

**Step 1: Write failing tests**

Cover:
- invoice/tracking email persists trusted tracking evidence
- BOL / PRO with carrier becomes trustworthy movement evidence
- new tracking updates `last_tracking_evidence_at`
- status changes update `last_movement_summary`
- unchanged tracking status does not spam repeated updates

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/lib/intelligence/tracking-agent.test.ts src/lib/tracking/shipment-intelligence-read.test.ts
```

Expected:
- FAIL until lifecycle evidence fields are updated

**Step 3: Implement minimal lifecycle hooks**

Update tracking ingestion to:
- upsert trusted tracking evidence into `purchase_orders.shipping_evidence`
- update `tracking_status_summary`
- update `last_tracking_evidence_at`
- update `last_movement_summary` and `last_movement_update_at` only on material movement change
- derive `lifecycle_stage = moving_with_tracking` when appropriate

Keep `shipments` as the carrier-truth table.

**Step 4: Re-run the tests**

Run:
```bash
npx vitest run src/lib/intelligence/tracking-agent.test.ts src/lib/tracking/shipment-intelligence-read.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/tracking-agent.ts src/lib/tracking/shipment-intelligence.ts src/lib/intelligence/tracking-agent.test.ts src/lib/tracking/shipment-intelligence-read.test.ts
git commit -m "feat(tracking): feed PO lifecycle movement evidence"
```

### Task 6: Reuse lifecycle state in active-purchases API and dashboard surfaces

**Files:**
- Modify: `src/lib/purchasing/active-purchases.ts`
- Modify: `src/app/api/dashboard/active-purchases/route.ts`
- Modify: `src/components/dashboard/ActivePurchasesPanel.tsx`
- Modify: `src/components/dashboard/PurchasingCalendarPanel.tsx`
- Create: `src/components/dashboard/ActivePurchasesPanel.test.tsx`

**Step 1: Write failing UI/data tests**

Cover:
- active purchases returns lifecycle stage and summary fields
- panel shows `sent`, `awaiting tracking`, `tracking unavailable`, `in transit`, `moving with tracking`, `received`, `AP follow-up`
- broad `in_transit` appears without fake tracking details
- movement summary appears only when tracking evidence is trustworthy

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/components/dashboard/ActivePurchasesPanel.test.tsx src/lib/purchasing/calendar-lifecycle.test.ts
```

Expected:
- FAIL because these surfaces do not yet consume the new shared lifecycle

**Step 3: Implement minimal API and UI changes**

Update `loadActivePurchases()` to return:
- `lifecycleStage`
- `lifecycleSummary`
- `trackingUnavailable`
- `lastMovementSummary`
- `trackingRequestedAt`

Then render those fields in both dashboard panels.

**Step 4: Re-run the tests**

Run:
```bash
npx vitest run src/components/dashboard/ActivePurchasesPanel.test.tsx src/lib/purchasing/calendar-lifecycle.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/active-purchases.ts src/app/api/dashboard/active-purchases/route.ts src/components/dashboard/ActivePurchasesPanel.tsx src/components/dashboard/PurchasingCalendarPanel.tsx src/components/dashboard/ActivePurchasesPanel.test.tsx
git commit -m "refactor(dashboard): show shared PO lifecycle state"
```

### Task 7: Reuse lifecycle state in purchasing calendar sync and daily movement messaging

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`
- Modify: `src/lib/purchasing/calendar-lifecycle.ts`
- Modify: `src/lib/purchasing/calendar-lifecycle.test.ts`

**Step 1: Write failing tests**

Cover:
- event title/description include lifecycle state and evidence summary
- `in_transit` without trusted tracking does not pretend to have carrier detail
- trusted ETA/tracking updates event description and movement text
- `tracking_unavailable` yields explicit "tracking not available" wording and request history

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/lib/purchasing/calendar-lifecycle.test.ts
```

Expected:
- FAIL until the calendar consumes lifecycle evidence

**Step 3: Implement minimal wiring**

Update calendar sync to:
- derive lifecycle stage from the shared helper
- include shipping evidence and movement summary in event descriptions
- keep existing receipt/AP completion behavior after receipt
- update Slack/Telegram movement messaging only on movement change

**Step 4: Re-run tests**

Run:
```bash
npx vitest run src/lib/purchasing/calendar-lifecycle.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts src/lib/purchasing/calendar-lifecycle.ts src/lib/purchasing/calendar-lifecycle.test.ts
git commit -m "feat(calendar): sync purchasing calendar with PO lifecycle evidence"
```

### Task 8: Verification and cleanup

**Files:**
- Review: `src/lib/purchasing/po-lifecycle-state.ts`
- Review: `src/lib/purchasing/po-lifecycle-evidence.ts`
- Review: `src/lib/intelligence/ops-manager.ts`
- Review: `src/lib/intelligence/tracking-agent.ts`
- Review: `src/lib/purchasing/active-purchases.ts`

**Step 1: Run focused verification**

Run:
```bash
npx vitest run src/lib/purchasing/po-lifecycle-state.test.ts src/lib/purchasing/po-lifecycle-evidence.test.ts src/lib/intelligence/ops-manager.po-sync.test.ts src/lib/intelligence/tracking-agent.test.ts src/lib/tracking/shipment-intelligence-read.test.ts src/lib/purchasing/calendar-lifecycle.test.ts src/components/dashboard/ActivePurchasesPanel.test.tsx
```

Expected:
- PASS

**Step 2: Run whitespace/conflict sanity check**

Run:
```bash
git diff --check
```

Expected:
- no trailing whitespace or conflict markers

**Step 3: Run typecheck if feasible**

Run:
```bash
npm run typecheck
```

Expected:
- PASS

If repo-wide typecheck is too heavy, run:
```bash
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit
```

**Step 4: Commit docs**

```bash
git add docs/plans/2026-04-09-po-lifecycle-evidence-design.md docs/plans/2026-04-09-po-lifecycle-evidence.md
git commit -m "docs(purchasing): plan PO lifecycle evidence model"
```

Plan complete and saved to `docs/plans/2026-04-09-po-lifecycle-evidence.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
