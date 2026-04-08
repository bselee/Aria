# Slack Request Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add durable Slack request tracking with `👀` on seen, `✅` on verified completion, and manual Telegram override using the existing watchdog and PO commit plumbing.

**Architecture:** Reuse `src/lib/slack/watchdog.ts` for ingestion and reaction handling, promote `slack_requests` into the durable ledger for all tracked Slack asks, and add a completion sweep that checks recent committed PO line items for exact SKU matches. Keep the first version conservative: exact SKU-based completion only, no Slack thread reply generation yet.

**Tech Stack:** TypeScript, Telegraf, Slack Web API, Supabase, existing Finale/PO sender integrations, Vitest

---

### Task 1: Add or verify durable `slack_requests` schema

**Files:**
- Create: `supabase/migrations/20260406_create_or_expand_slack_requests.sql`
- Reference: `src/lib/intelligence/workers/amazon-order-parser.ts`

**Step 1: Write the migration**

Include fields needed for both current Amazon usage and new tracked Slack requests:

- primary key
- channel/message/thread metadata
- requester metadata
- request text and items
- status
- completion metadata
- PO references
- timestamps

**Step 2: Verify migration shape against existing code**

Check:
- `src/lib/intelligence/workers/amazon-order-parser.ts`
- `src/cli/commands/operations.ts`

Expected: existing fields still exist or are made backward-compatible.

**Step 3: Commit**

```bash
git add supabase/migrations/20260406_create_or_expand_slack_requests.sql
git commit -m "feat: add durable slack request tracking schema"
```

### Task 2: Persist normal Slack requests, not just Amazon/unmatched ones

**Files:**
- Modify: `src/lib/slack/watchdog.ts`
- Test: `src/lib/slack/watchdog.test.ts` if it exists, otherwise create targeted tests

**Step 1: Write the failing test**

Test that a normal SKU-backed request results in a durable `slack_requests` row instead of only an in-memory digest entry.

**Step 2: Run the targeted test**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: FAIL showing normal requests are not persisted.

**Step 3: Implement minimal persistence**

Change the watchdog so accepted requests upsert a durable row for:

- Finale-backed SKU requests
- Amazon/one-off requests

Store:

- request metadata
- resolved SKU data
- status `pending`
- `eyes_reacted_at`

**Step 4: Run the targeted test again**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/slack/watchdog.ts src/lib/slack/watchdog.test.ts
git commit -m "feat: persist tracked slack requests"
```

### Task 3: Add completion sweep for recent committed POs

**Files:**
- Modify: `src/lib/slack/watchdog.ts`
- Reference: `src/lib/purchasing/po-sender.ts`
- Reference: `src/lib/active-purchases.ts` or PO access helpers if useful
- Test: `src/lib/slack/watchdog.test.ts`

**Step 1: Write the failing test**

Test that a `pending` tracked request with resolved SKU transitions to completed when a recent committed PO contains that SKU.

**Step 2: Run the targeted test**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: FAIL because there is no completion sweep.

**Step 3: Implement the sweep**

Add a watchdog method that:

- loads `pending` requests
- checks recent committed POs from the last 48 hours
- matches by exact SKU in line items
- records matched PO number(s)
- updates status to `completed_auto`

Call it from the watchdog cycle after polling.

**Step 4: Run the targeted test again**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/slack/watchdog.ts src/lib/slack/watchdog.test.ts
git commit -m "feat: auto-complete slack requests from committed pos"
```

### Task 4: Add `✅` Slack reaction on completion

**Files:**
- Modify: `src/lib/slack/watchdog.ts`
- Test: `src/lib/slack/watchdog.test.ts`

**Step 1: Write the failing test**

Test that auto-completion attempts to add a `white_check_mark` reaction to the original Slack message.

**Step 2: Run the targeted test**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: FAIL because only `eyes` exists today.

**Step 3: Implement the reaction helper**

Add a completion reaction helper that:

- adds `white_check_mark`
- tolerates `already_reacted`
- never crashes polling

**Step 4: Run the targeted test again**

Run: `npx vitest run src/lib/slack/watchdog.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/slack/watchdog.ts src/lib/slack/watchdog.test.ts
git commit -m "feat: react to completed slack requests"
```

### Task 5: Replace `/requests` in-memory view with durable tracker view

**Files:**
- Modify: `src/cli/commands/operations.ts`
- Test: `src/cli/commands/operations.test.ts` or create request command tests

**Step 1: Write the failing test**

Test that `/requests` reads durable tracked requests and can show open and recent completed items.

**Step 2: Run the targeted test**

Run: `npx vitest run src/cli/commands/operations.test.ts`

Expected: FAIL because the command currently reads `deps.watchdog?.getRecentRequests()`.

**Step 3: Implement the durable query**

Update `/requests` to query `slack_requests` from Supabase and format:

- open requests
- recent auto-completed requests
- recent manual-completed requests

Keep formatting short and operational.

**Step 4: Run the targeted test again**

Run: `npx vitest run src/cli/commands/operations.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/commands/operations.ts src/cli/commands/operations.test.ts
git commit -m "feat: back request tracker with durable slack request state"
```

### Task 6: Add manual Telegram completion override

**Files:**
- Modify: `src/cli/commands/operations.ts`
- Modify: `src/cli/start-bot.ts` only if callback wiring is needed
- Test: `src/cli/commands/operations.test.ts`

**Step 1: Write the failing test**

Test a command or callback path that marks a tracked request complete manually and records `completed_manual`.

**Step 2: Run the targeted test**

Run: `npx vitest run src/cli/commands/operations.test.ts`

Expected: FAIL because no manual completion path exists yet.

**Step 3: Implement the minimal manual path**

Recommended first version:

- `/request-complete <request_id>`

Behavior:

- load request
- set `status = completed_manual`
- set `completed_via = manual`
- set `completed_at`
- add `✅` reaction in Slack

**Step 4: Run the targeted test again**

Run: `npx vitest run src/cli/commands/operations.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/commands/operations.ts src/cli/commands/operations.test.ts src/cli/start-bot.ts
git commit -m "feat: add manual slack request completion override"
```

### Task 7: Protect Amazon `/notify` compatibility

**Files:**
- Modify: `src/lib/intelligence/workers/amazon-order-parser.ts` if needed
- Modify: `src/cli/commands/operations.ts` if needed
- Test: `src/lib/intelligence/workers/amazon-order-parser.test.ts` if present, otherwise add one

**Step 1: Write the failing test**

Test that Amazon order matching and `/notify` still function after `slack_requests` becomes a broader ledger.

**Step 2: Run the targeted test**

Run: `npx vitest run src/lib/intelligence/workers/amazon-order-parser.test.ts src/cli/commands/operations.test.ts`

Expected: FAIL if status assumptions break.

**Step 3: Implement compatibility fixes**

Ensure:

- Amazon records still use their current statuses
- `/notify` still targets the correct request rows
- broader request ledger does not collide with Amazon matching queries

**Step 4: Run the targeted test again**

Run: `npx vitest run src/lib/intelligence/workers/amazon-order-parser.test.ts src/cli/commands/operations.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/workers/amazon-order-parser.ts src/cli/commands/operations.ts src/lib/intelligence/workers/amazon-order-parser.test.ts src/cli/commands/operations.test.ts
git commit -m "test: preserve amazon slack request flows"
```

### Task 8: Run full targeted verification

**Files:**
- Modify: none unless fixes are required

**Step 1: Run targeted request-tracking suite**

Run:

```bash
npx vitest run src/lib/slack/watchdog.test.ts src/cli/commands/operations.test.ts src/lib/intelligence/workers/amazon-order-parser.test.ts
```

Expected: PASS

**Step 2: Run adjacent bot/coplanar tests**

Run:

```bash
npx vitest run src/cli/commands/commands.test.ts src/lib/copilot/channels/telegram.test.ts
```

Expected: PASS

**Step 3: Run typecheck**

Run:

```bash
npm run typecheck:cli
```

Expected: PASS

**Step 4: Commit any final fixes**

```bash
git add .
git commit -m "feat: add slack request completion tracking"
```
