# PO Completion State Design

**Goal:** Derive one real-world PO completion state that does not trust Finale's `Completed` status alone and only considers a PO complete when receiving, AP reconciliation, and freight/invoice resolution all line up.

**Problem:** Finale can auto-complete a PO when item quantities line up even if AP has not matched the invoice yet or freight/shipping has not been entered. The purchasing calendar, dashboard, and PO watchers currently infer "done" from different signals, so a PO can look finished before costs are actually captured.

## Recommended Approach

Build one shared derived-state helper for purchasing completion and use it everywhere that surfaces PO status.

The helper should combine:
- **Receiving truth:** items physically received in Finale
- **AP truth:** invoice matched to the PO and reconciliation run
- **Cost-capture truth:** freight/shipping and other fee updates applied or explicitly resolved
- **Exception truth:** open blockers like `needs_approval`, over/under, missing invoice info, or reconciliation errors

This should become the canonical status source for:
- the purchasing Google Calendar
- the dashboard active-purchases view
- the immediate PO-received watcher update path
- any future "ready to close / truly complete" reporting

## Completion Rules

`complete` means all of the following are true:
- Finale shows the PO has been received
- AP has matched the invoice to that PO
- freight/shipping and price updates have been applied or there were no such changes needed
- there are no open blockers such as `needs_approval`, short shipment, overbill, missing invoice data, or reconciliation errors

`received_pending_invoice` means:
- Finale shows receipt, but there is no successful AP reconciliation yet

`received_pending_reconciliation` means:
- an invoice is attached or matched, but there is still an open review/exception state

`delivered_awaiting_receipt` means:
- tracking shows delivered, but Finale receiving is not done yet

`exception` means:
- any blocker remains open, even if some other signals look healthy

## Source of Truth Mapping

- **Finale PO status / receive date / shipments:** `src/lib/finale/client.ts`
- **AP reconciliation outcome:** `src/lib/intelligence/ap-agent.ts`
- **Reconciliation audit metadata and verdicts:** `src/lib/finale/reconciler.ts`
- **Calendar sync + PO watcher + active purchases:** `src/lib/intelligence/ops-manager.ts`
- **Dashboard API / panel:** `src/app/api/dashboard/active-purchases/route.ts`, `src/components/dashboard/PurchasingCalendarPanel.tsx`

## Persistence Strategy

Do not start with a new database table.

First implementation should derive the status from data that already exists:
- `purchase_orders`
- `ap_activity_log`
- `invoices`
- current Finale PO summary data

If this proves valuable and stable, we can later persist a materialized status row or view for analytics and faster dashboard queries.

## Why This Is Safer

- Prevents false "done" states caused by Finale auto-completing early
- Keeps cost capture front-and-center, especially freight
- Makes calendar, dashboard, and AP decisioning agree on what still needs work
- Lets us show clear operational states instead of just "open vs received"

## Implementation Shape

1. Add a shared purchasing completion helper under `src/lib/purchasing/`
2. Feed it normalized PO/AP/reconciliation inputs
3. Replace duplicated local status logic in calendar/dashboard/watcher code
4. Add focused tests for real-world cases:
   - Finale completed but no AP invoice yet
   - invoice matched but freight still unresolved
   - delivered by tracking but not received
   - all three truths satisfied -> complete
