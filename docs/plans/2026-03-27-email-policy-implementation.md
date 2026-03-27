# Email Policy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce the approved email policy for `bill.selee@buildasoil.com` and `ap@buildasoil.com`, with clearer Gmail visibility, safer auto-replies, and tighter default-inbox invoice handling.

**Architecture:** Keep hard rules in the email agents and workers, not in prompts alone. Add a small shared Gmail policy helper for labels/state transitions, tighten the acknowledgement agent to only reply in safe cases, preserve human visibility with `Follow Up` and `Replied`, and finish default-inbox invoices by updating Gmail only after PO reconciliation succeeds.

**Tech Stack:** TypeScript, Vitest, Gmail API, Supabase, existing Pinecone feedback loop, Next.js repo tooling

---

### Task 1: Add Policy Tests For Acknowledgement Decisions

**Files:**
- Create: `src/lib/intelligence/acknowledgement-agent.test.ts`
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`

**Step 1: Write the failing test**

Add tests for:
- safe one-line routine reply on `default` inbox adds `Replied` and keeps `UNREAD` + `INBOX`
- no-reply sender does not send a reply and does not add `Replied`
- human-needing thread adds `Follow Up`, sends no reply, keeps message visible
- inline invoice from `default` inbox is queued to nightshift and not archived by the acknowledgement agent

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts`
Expected: FAIL because the agent currently archives routine mail and has no `Replied` / `Follow Up` policy.

**Step 3: Write minimal implementation**

Implement a small, testable decision path in `acknowledgement-agent.ts`:
- add safe reply selection helpers
- add label/state application helpers
- preserve `INBOX` / `UNREAD` for routine replies and human-review cases
- add `Follow Up` only for human-needed cases
- add `Replied` only when a reply is actually sent

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/acknowledgement-agent.test.ts
git commit -m "feat: tighten default inbox acknowledgement policy"
```

### Task 2: Add Shared Gmail Policy Helper

**Files:**
- Create: `src/lib/intelligence/gmail-policy.ts`
- Create: `src/lib/intelligence/gmail-policy.test.ts`
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
- Modify: `src/lib/intelligence/workers/ap-identifier.ts`

**Step 1: Write the failing test**

Add tests for helper behavior:
- resolves or creates `Follow Up`, `Replied`, and invoice labels
- applies additive labels without stripping `INBOX` / `UNREAD` when policy says preserve visibility
- removes `UNREAD` / `INBOX` only when closing a handled invoice path

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/gmail-policy.test.ts`
Expected: FAIL because helper does not exist.

**Step 3: Write minimal implementation**

Create a shared helper that:
- caches Gmail label IDs
- adds/removes labels based on a small action object
- gives all email agents one consistent path for label transitions

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/gmail-policy.test.ts src/lib/intelligence/acknowledgement-agent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/gmail-policy.ts src/lib/intelligence/gmail-policy.test.ts src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/workers/ap-identifier.ts
git commit -m "refactor: centralize gmail label policy helpers"
```

### Task 3: Enforce Default-Inbox Invoice Visibility Rules

**Files:**
- Create: `src/lib/intelligence/workers/default-inbox-invoice.test.ts`
- Modify: `src/lib/intelligence/workers/default-inbox-invoice.ts`
- Modify: `src/lib/intelligence/nightshift-agent.ts`

**Step 1: Write the failing test**

Add tests for:
- successful default-inbox invoice reconciliation marks message read and adds invoice label
- failed/no-PO/default-inbox invoice leaves Gmail untouched for human review
- already-processed invoice still closes cleanly into invoice labeling

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/workers/default-inbox-invoice.test.ts`
Expected: FAIL because the worker currently returns reconciliation outcomes without updating Gmail state.

**Step 3: Write minimal implementation**

Update the worker contract so it can close Gmail state only on successful/duplicate-safe outcomes:
- inject or create Gmail client for `default`
- apply invoice label and mark read after reconciliation success
- leave message visible on failure or ambiguity
- keep all Bill.com exclusion rules intact

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/workers/default-inbox-invoice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/workers/default-inbox-invoice.ts src/lib/intelligence/workers/default-inbox-invoice.test.ts src/lib/intelligence/nightshift-agent.ts
git commit -m "feat: close default inbox invoices only after reconciliation"
```

### Task 4: Record Feedback Signals For Future Autonomy

**Files:**
- Create: `src/lib/intelligence/email-feedback.ts`
- Create: `src/lib/intelligence/email-feedback.test.ts`
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
- Modify: `src/lib/intelligence/workers/default-inbox-invoice.ts`
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Write the failing test**

Add tests for:
- recording an auto-reply event
- recording a default-inbox invoice reconciliation event
- shaping feedback payloads so later human corrections can attach to thread/message IDs

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intelligence/email-feedback.test.ts`
Expected: FAIL because helper does not exist.

**Step 3: Write minimal implementation**

Implement thin wrappers over `recordFeedback` for:
- simple auto-reply sent
- human-follow-up requested
- default-inbox invoice reconciled / blocked / failed

Keep this minimal: event capture only, no speculative learning engine rewrite.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/intelligence/email-feedback.test.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/workers/default-inbox-invoice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/intelligence/email-feedback.ts src/lib/intelligence/email-feedback.test.ts src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/workers/default-inbox-invoice.ts src/lib/intelligence/feedback-loop.ts
git commit -m "feat: capture email feedback signals"
```

### Task 5: Final Cleanup And Verification

**Files:**
- Modify: `docs/STATUS.md`
- Modify: touched email policy files as needed

**Step 1: Run focused verification**

Run:
- `npx vitest run src/lib/intelligence/gmail-policy.test.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/email-feedback.test.ts src/lib/intelligence/workers/default-inbox-invoice.test.ts`
- `git diff --exit-code -- src/lib/slack/watchdog.ts`

Expected:
- all focused tests PASS
- Slack watchdog remains unchanged

**Step 2: Run full verification**

Run:
- `npm test`
- `npm run typecheck`

Expected:
- repo test suite PASS
- typecheck either PASS or any remaining failure is identified with exact file ownership before completion

**Step 3: Clean code**

While staying green:
- remove duplicated Gmail label lookup code replaced by `gmail-policy.ts`
- tighten reply variation helpers to one short controlled source
- keep comments brief and operational

**Step 4: Update status doc**

Document:
- new email policy behavior
- remaining learning-loop follow-up work, if any

**Step 5: Commit**

```bash
git add docs/STATUS.md src/lib/intelligence/gmail-policy.ts src/lib/intelligence/gmail-policy.test.ts src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/email-feedback.ts src/lib/intelligence/email-feedback.test.ts src/lib/intelligence/workers/default-inbox-invoice.ts src/lib/intelligence/workers/default-inbox-invoice.test.ts src/lib/intelligence/nightshift-agent.ts src/lib/intelligence/feedback-loop.ts
git commit -m "feat: tighten email policy and feedback loop"
```
