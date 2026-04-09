# PO Lifecycle Evidence Design

**Goal:** Represent the real purchasing process as an evidence-driven lifecycle so the dashboard, calendar, nudges, and tracking updates reflect what actually happened instead of over-trusting raw Finale or email status.

**Problem:** The current system has the right ingredients, but they live in different places:
- `po-sender.ts` knows when a draft PO was committed and emailed.
- `syncPOConversations()` knows when a vendor replied, when tracking appeared in the PO thread, and when to send a follow-up.
- `tracking-agent.ts` and `shipment-intelligence.ts` know how to extract and refresh tracking.
- `active-purchases.ts` and the purchasing calendar know how to show receipt and completion.

What is missing is one shared lifecycle model that answers:
- What stage is this PO in right now?
- What evidence put it there?
- Should we ask for tracking, and have we already asked enough?
- Do we have broad "in transit" evidence versus specific tracking movement?

## Current Context

Relevant existing files:
- `src/lib/purchasing/po-sender.ts`
- `src/lib/intelligence/ops-manager.ts` (`syncPOConversations`, calendar sync, Slack ETA sync)
- `src/lib/intelligence/acknowledgement-agent.ts`
- `src/lib/intelligence/tracking-agent.ts`
- `src/lib/tracking/shipment-intelligence.ts`
- `src/lib/purchasing/active-purchases.ts`
- `src/components/dashboard/PurchasingCalendarPanel.tsx`
- `src/components/dashboard/ActivePurchasesPanel.tsx`

Relevant persistence:
- `purchase_orders`
- `po_sends`
- `ap_activity_log`
- `shipments`
- `purchasing_calendar_events`

## Recommended Approach

Create one shared PO lifecycle layer under `src/lib/purchasing/` that derives operational stage from accumulated evidence, then reuse it everywhere.

Recommendation:
- Keep raw evidence in `purchase_orders` and `shipments`.
- Add a small, explicit set of lifecycle/evidence columns to `purchase_orders`.
- Derive the display state in a shared helper rather than storing every final label.

Why this is the right level:
- It keeps ingestion simple and append-only.
- It avoids duplicating heuristics across calendar, dashboard, Slack, and follow-up jobs.
- It supports loose "in transit" while still reserving richer movement states for trustworthy tracking.

## Lifecycle Model

Canonical stages:
1. `draft_created`
2. `committed`
3. `sent`
4. `vendor_acknowledged`
5. `awaiting_tracking`
6. `tracking_unavailable`
7. `in_transit`
8. `moving_with_tracking`
9. `received`
10. `ap_follow_up`
11. `complete`
12. `exception`

Important distinction:
- `in_transit` is a broad catch-all for shipping evidence.
- `moving_with_tracking` requires clear, attributable tracking or ETA evidence from a trustworthy source.

## Evidence Rules

### Draft / Commit / Send

Evidence sources:
- Draft PO review exists in Finale.
- `po_sends.committed_at`
- `po_sends.sent_at`
- `po_sends.gmail_message_id`

Rules:
- Draft exists but not committed -> `draft_created`
- Committed but not emailed -> `committed`
- Emailed -> `sent`

### Vendor Acknowledgement

Evidence sources:
- First non-BuildASoil reply in PO thread
- Outside-thread vendor email found after PO send date

Rules:
- Any clear vendor response sets `vendor_acknowledged_at`
- Acknowledgement does not automatically imply shipment

### In Transit

Allowed broad evidence:
- Vendor explicitly says shipped
- Vendor provides ETA / arrival date
- Invoice arrives with freight / shipment context
- Tracking or BOL is found

Rules:
- Once any shipping evidence is present, PO may enter `in_transit`
- Tracking is not required for the broad `in_transit` bucket

### Tracking / Movement

Trusted evidence for richer status:
- Tracking number from vendor email, invoice, or tracking email
- BOL / PRO tied to a recognizable carrier
- Explicit vendor ETA with enough specificity to show movement

Rules:
- Clear tracking or trusted ETA upgrades to `moving_with_tracking`
- Daily movement updates append only when status materially changes
- If tracking is not found but we are confident it should exist, mark `tracking_unavailable`

### Tracking Unavailable / Nudge Policy

Rules:
- Do not ask for tracking immediately just because it is absent
- Only ask when all of these are true:
  - PO is older than configured threshold
  - there is no trustworthy tracking or ETA evidence
  - we have not already nudged recently
  - vendor has not already answered with non-tracking shipping context

Recommended anti-nag constraints:
- One automated ask per PO per cooldown window
- No repeated asks unless a new milestone happens
- Outside-thread replies suppress the nudge

### Received / AP

Rules:
- Receipt remains evidence-driven using Finale receipt date and shipment receive dates
- After receipt, lifecycle continues as `ap_follow_up` until AP reconciliation is truly complete
- Existing `POCompletionState` remains the source for the AP endgame

## Data Model

Add explicit lifecycle evidence columns to `purchase_orders`.

Recommended columns:
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

Why JSON for shipping evidence:
- Email, invoice, thread, BOL, and manual ETA sources are heterogeneous
- We need source attribution more than a rigid relational model right now

## Shared Helper Shape

Proposed files:
- `src/lib/purchasing/po-lifecycle-state.ts`
- `src/lib/purchasing/po-lifecycle-state.test.ts`
- `src/lib/purchasing/po-lifecycle-evidence.ts`
- `src/lib/purchasing/po-lifecycle-evidence.test.ts`

Responsibilities:
- normalize lifecycle evidence from DB + Gmail/Finale/shipments inputs
- derive one operational stage
- decide if tracking follow-up is appropriate
- produce display-ready summary fields for calendar/dashboard

## Surface Behavior

### Active Purchases Panel

Should show:
- current stage
- concise evidence summary
- tracking unavailable when applicable
- latest movement summary if available

### Purchasing Calendar

Should show:
- `sent`, `awaiting_tracking`, `tracking_unavailable`, `in_transit`, `moving_with_tracking`, `received`, `ap_follow_up`
- richer event description with evidence source and last movement update
- no fake "received" from weak signals

### Slack / Telegram

Should:
- alert on first trustworthy tracking
- append movement updates only when the status string changes
- avoid duplicate nudges when tracking is still absent

## Alternatives Considered

### Option 1: Keep current heuristics and patch each surface separately

Pros:
- fastest short-term patching

Cons:
- logic keeps drifting
- more false positives / false negatives
- harder to reason about anti-nag behavior

### Option 2: Store final lifecycle labels directly in DB

Pros:
- simple reads for UI

Cons:
- hard to recompute when heuristics improve
- encourages stale state
- hides source evidence

### Option 3: Store evidence, derive lifecycle centrally

Pros:
- best auditability
- safest for operational automation
- easiest to test

Cons:
- slightly more up-front design work

Recommended: Option 3.

## Testing Strategy

Need focused tests for:
- draft -> committed -> sent progression
- vendor acknowledgement in-thread and outside-thread
- invoice-only shipping evidence leading to broad `in_transit`
- tracking number / BOL / ETA upgrading to `moving_with_tracking`
- missing tracking with cooldown-respecting follow-up recommendation
- receipt and AP follow-up coexisting cleanly
- calendar/dashboard rendering based on shared lifecycle, not local heuristics

## Non-Goals

Not in this pass:
- fully replacing `po_sends` or `shipments`
- manual workflow UI for editing lifecycle evidence
- carrier-specific scraping beyond existing tracking infrastructure
- vendor-specific custom nudge cadences unless already encoded elsewhere

## Implementation Summary

Build one evidence-driven lifecycle model, persist the key timestamps and evidence summaries on `purchase_orders`, feed it from PO send + acknowledgement + invoice/tracking ingestion, and make the calendar/dashboard consume that derived state. This keeps "in transit" intentionally broad while requiring trustworthy evidence for more specific tracking-driven movement states.
