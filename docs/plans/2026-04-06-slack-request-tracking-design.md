# Slack Request Tracking Design

**Date:** 2026-04-06

## Goal

Extend the existing Slack watchdog so product requests in Slack move through a visible, durable lifecycle:

- `👀` when Aria has seen and accepted a request
- `✅` when Aria can verify the requested SKU was included on a recent committed PO
- manual override when the order is real but automatic matching is incomplete

Phase 1 explicitly does **not** add Slack thread replies with PO links yet. The focus is reaction-based state and trustworthy completion checks.

## Existing System

The current codebase already provides most of the building blocks:

- `src/lib/slack/watchdog.ts`
  - detects explicit Slack product requests
  - watches `#purchasing`, `#purchase-orders`, DMs, and `@Bill` mentions in other channels
  - adds the `eyes` reaction
  - resolves likely SKUs and Finale context
  - reports detections to Telegram
  - persists only Amazon/one-off requests to `slack_requests`
- `src/lib/intelligence/workers/amazon-order-parser.ts`
  - treats `slack_requests` as the durable request ledger for Amazon matching
- `src/lib/purchasing/po-sender.ts`
  - commits draft POs
  - logs committed sends to `po_sends`
  - logs audit entries to `ap_activity_log`
- `src/cli/commands/operations.ts`
  - exposes `/requests`
  - exposes `/notify` for Amazon Slack thread notifications

## Problem

The current watchdog is observant but not stateful for the main request flow:

- `👀` exists, but `✅` does not
- ordinary SKU-backed Slack requests are not durably tracked
- `/requests` reads an in-memory digest buffer instead of a durable ledger
- there is no automatic reconciliation from Slack request -> committed PO match
- there is no manual completion path for normal Slack requests

## Phase 1 Requirements

### Functional

1. When a Slack message is classified as a real purchasing request, Aria adds `👀`.
2. That request is persisted as a durable tracked record.
3. Aria periodically checks whether a recent committed PO from the last 24-48 hours contains the requested SKU(s).
4. When a trusted match is found, Aria adds `✅` and marks the request complete.
5. When matching is unclear, the request remains open until manual override.
6. Telegram must allow manual completion override for a tracked request.
7. `/requests` must report durable tracked requests, not just the unsent digest buffer.

### Non-Goals

1. No Slack thread reply with PO link(s) yet.
2. No vendor/text-only completion matching.
3. No attempt to infer completion from draft POs.
4. No “all requested SKUs must match” requirement for the first version unless explicitly detected and implemented safely.

## Proposed Data Model

Reuse `slack_requests` as the durable request ledger for **all** tracked Slack asks, not just Amazon requests.

Suggested lifecycle states:

- `pending` - seen and tracked, not yet verified complete
- `completed_auto` - verified against a recent committed PO
- `completed_manual` - manually marked complete by Bill
- `dismissed` - optional future state if a request should no longer be tracked
- `ordered` / `shipped` - preserve existing Amazon states if already used by current flows

Suggested new/required fields:

- `channel_id`
- `channel_name`
- `message_ts`
- `thread_ts`
- `requester_user_id`
- `requester_name`
- `original_text`
- `items_requested`
- `quantity`
- `status`
- `matched_skus` or `items_resolved`
- `eyes_reacted_at`
- `completed_at`
- `completed_via` (`auto` | `manual`)
- `completed_po_numbers` (array or jsonb)
- `completion_note`
- `last_checked_at`
- `created_at`

If the existing table already exists in production with a different shape, the migration should be additive and backward-compatible so Amazon flows continue working.

## Matching Rules

### Detection

Keep the current watchdog intent analysis and confidence threshold in `src/lib/slack/watchdog.ts`.

Tracking should begin only when:

- `isProductRequest === true`
- `hasExplicitAsk === true`
- confidence remains above the existing threshold

### Completion Verification

Auto-complete only when all of the following are true:

1. The request has at least one resolved SKU.
2. A committed PO exists within the configured recent window (default 48h, acceptable range 24-48h).
3. The PO line items include the resolved SKU.

Preferred source of truth:

- `po_sends` if the PO was committed through Aria
- `purchase_orders` if the PO exists there with committed/open status and line items

Matching priority:

1. exact SKU match
2. exact PO line item product ID match from resolved SKU

Do **not** auto-complete on:

- vendor name alone
- fuzzy item name alone
- draft/open PO creation alone

## Slack Behavior

### Seen

Current behavior is already correct:

- add `👀` once when the request is accepted
- tolerate `already_reacted`

### Complete

Add a new reaction step:

- add `✅` only when request transitions to `completed_auto` or `completed_manual`
- tolerate `already_reacted`

Avoid removing `👀` in phase 1. Keeping both reactions is simple and easy to reason about:

- `👀` = seen
- `✅` = verified complete

## Telegram Behavior

### `/requests`

Replace the current in-memory “pending digest buffer” view with a durable request tracker view.

Recommended default sections:

- Open requests
- Recently auto-completed requests
- Recently manually completed requests

Each open request should show:

- requester
- channel
- request text
- resolved SKU(s)
- current PO evidence
- status

### Manual Override

Add a Telegram action for:

- mark complete manually

Optional follow-up metadata:

- free-form note later
- selected PO number later

Phase 1 can keep the manual path simple:

- manual complete changes status
- stores `completed_via = manual`
- adds `✅` in Slack

## Processing Model

### Ingestion

When watchdog accepts a Slack request:

1. add `👀`
2. deduplicate by channel + thread/message + SKU context
3. upsert durable `slack_requests` row
4. continue Telegram digest behavior if desired

### Completion Sweep

Introduce a recurring completion checker:

1. fetch `pending` Slack requests from the last N days
2. for each request with resolved SKU(s), search recent committed POs
3. if a SKU match is found, mark `completed_auto`
4. add `✅` reaction in Slack
5. store matched PO number(s)

This should run:

- on watchdog poll cycle end, or
- as a dedicated cron from the bot process

Recommendation: use a dedicated method inside the watchdog, called after polling. It keeps request tracking in one place and avoids a second disconnected subsystem.

## Error Handling

1. Slack reaction failures must never crash polling.
2. Database write failures should log loudly and continue polling.
3. Completion sweep must be idempotent:
   - re-running should not duplicate reactions
   - completed rows should not be re-completed
4. Missing `slack_requests` migration should be treated as a blocker before rollout.

## Testing Strategy

### Unit

- watchdog persists normal tracked requests, not just Amazon/unmatched requests
- completion matcher finds recent committed PO by exact SKU
- completion matcher ignores vendor-only/fuzzy-only matches
- `✅` reaction is attempted on auto-complete
- manual completion path updates durable state and reacts in Slack
- `/requests` reads durable request state instead of the in-memory digest buffer

### Integration

- simulate Slack request -> tracked record -> recent committed PO -> completed state
- simulate manual Telegram completion override
- verify Amazon `/notify` flow still works with the expanded `slack_requests` schema

## Rollout Notes

1. Verify whether `slack_requests` exists in production. The repo currently references it in code, but no migration was found in the checked-in migration set.
2. Keep Amazon behavior backward-compatible.
3. Keep Slack thread replies out of scope until the completion ledger is reliable.

## Recommended Phase 1 Scope

Build exactly this:

- durable tracking for normal Slack product requests
- current `👀` behavior unchanged
- automatic `✅` on recent committed SKU match
- manual Telegram completion override
- `/requests` backed by durable request state

After that is stable, phase 2 can add:

- simple Slack thread reply with PO link(s)
- display of ordered SKU(s) and PO numbers
- stronger “all requested SKUs covered” completion logic
