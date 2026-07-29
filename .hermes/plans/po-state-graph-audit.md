# Aria PO State Graph — Audit Map (read-only findings)

**Author:** Hermia · **Date:** 2026-07-29 · **Status:** measured, not inferred

## Executive summary

Aria already has a correct PO state machine (`src/lib/purchasing/po-lifecycle.ts`,
9 canonical UPPERCASE states, validated transitions, local-DB write-ahead).
**It has never successfully written a single row.** Every PO in the database is
either `NULL` (833) or stuck on a non-canonical `l3_escalated` (311).

The flow feels disjointed because there is no single source of truth. Five tables
hold competing opinions about "where is this PO," in three incompatible vocabularies.

## Finding 1 — Vocabulary collision on one column

`purchase_orders.lifecycle_stage` is written by two vocabularies at once:

| Vocabulary | Where declared | Example values |
|---|---|---|
| Canonical (state machine) | `po-lifecycle.ts:20` | `REVIEW, SENT, ACKNOWLEDGED, INVOICED, RECONCILED, RECEIVED, COMPLETED, CANCELLED` |
| Ad-hoc (direct writes) | 13 scattered call sites | `sent, received, reconciled, ap_follow_up, closed_stale, moving_with_tracking, ordered_browser, pending_replacement, tracking_unavailable, urgent_followup_requested` |

`assertValidTransition()` only knows the UPPERCASE set. `resolveState()` maps any
unknown value to `REVIEW`, so a PO sitting on `reconciled` (lowercase) is treated
as `REVIEW` and legitimate transitions are rejected. This is the observed
`REVIEW -> RECONCILED` rejection in reconciler test output.

## Finding 2 — 14 writers bypass the state machine

Direct `lifecycle_stage:` assignments that never call `transitionLifecycleState()`:

| Value | Location |
|---|---|
| `sent` | `src/app/api/dashboard/active-purchases/route.ts:105` |
| `moving_with_tracking` | `src/app/api/dashboard/active-purchases/route.ts:185` |
| `ap_follow_up` | `src/app/api/dashboard/active-purchases/route.ts:349` |
| `reconciled` | `src/app/api/dashboard/active-purchases/route.ts:520` |
| `closed_stale` | `src/app/api/dashboard/active-purchases/route.ts:646,661` |
| `ordered_browser` | `src/cli/handlers/order-actions.ts:26` |
| `pending_replacement` | `src/cli/handlers/escalation-actions.ts:31` |
| `urgent_followup_requested` | `src/cli/handlers/escalation-actions.ts:78` |
| `tracking_unavailable` | `src/lib/intelligence/vendor-comms-agent.ts:193` |
| `received` | `src/lib/purchasing/active-purchases.ts:224,228` |
| `sent` | `src/lib/purchasing/po-sender.ts:1049` |
| `ACKNOWLEDGED` | `src/lib/purchasing/po-reply-watcher.ts:346` (canonical, still bypasses) |

~30 call sites *do* correctly route through `transitionLifecycleState()`.
The bypasses overwrite their work.

## Finding 3 — Live data is 100% non-canonical

```
lifecycle_stage distribution (purchase_orders, 1142 rows)
  l3_escalated   311   <- non-canonical
  NULL           833
  canonical        0
```

## Finding 4 — Two invoice tables, 100% disagreement

99 POs appear in both `invoices` and `vendor_invoices`. **All 99 disagree on status.**

```
PO 124688   invoices=matched_review   vendor_invoices=received
PO 124496   invoices=reconciled       vendor_invoices=received
```

Vocabularies do not overlap:
- `invoices`: `unmatched, matched_review, matched_unreconciled, matched_approved, reconciled, completed`
- `vendor_invoices`: `received, reconciled`

There is no mapping between them, so `matched_review` has no counterpart at all.

## Finding 5 — 85 write sites across 5 state tables

| Table | Write sites | Rows |
|---|---|---|
| `purchase_orders` | 39 | 1142 |
| `invoices` | 16 | 180 |
| `vendor_invoices` | 15 | 1006 |
| `ap_pending_approvals` | 11 | 22 (all `expired`) |
| `reconciliation_outcomes` | 4 | 266 |

## Finding 6 — The approval queue is an orphan

`storePendingApproval()` is never called in production; `needs_approval` routes to
`enqueueForDashboardReview()` which writes `ap_activity_log` instead. All 22 rows in
`ap_pending_approvals` are `expired`. `sendApprovalRequest()` (Telegram inline
approve) is defined at `ap-agent.ts:2287` and never invoked.

## Target model

One owning column, one vocabulary, one writer:

```
REVIEW -> SENT -> ACKNOWLEDGED -> RECEIVED -> INVOICED -> RECONCILED -> COMPLETED
                                      |
                                  CANCELLED
```

- `purchase_orders.lifecycle_stage` is the single source of truth.
- `transitionLifecycleState()` is the ONLY writer. No route handler writes the column.
- Other tables hold facts (amounts, dates, documents), not competing state opinions.
- The 3-way match gate (`src/lib/purchasing/three-way-match.ts`) guards exactly one
  transition: `RECONCILED -> COMPLETED`.

## Work plan

1. **Vocabulary reconciliation** — map the 10 ad-hoc values onto canonical states
   (or onto separate boolean/detail columns where they are not lifecycle states —
   e.g. `tracking_unavailable` and `urgent_followup_requested` are *flags*, not stages).
2. **Migration** — backfill 311 `l3_escalated` + 833 NULL rows to canonical states
   derived from existing evidence.
3. **Funnel all writers** through `transitionLifecycleState()`; delete direct writes.
4. **Wire the 3-way gate** to the `RECONCILED -> COMPLETED` transition only.

## Non-goals for this pass

- Do NOT enable `PO_AUTO_COMPLETE_ENABLED` (Bill: not confident).
- Do NOT merge `invoices` / `vendor_invoices` — separate, larger effort.
