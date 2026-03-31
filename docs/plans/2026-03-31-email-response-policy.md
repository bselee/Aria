# Email Response Policy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make purchase-related email handling respond more like Bill by using PO-thread history to decide when to reply, when to leave visible and unread, and when to mark Follow Up.

**Architecture:** Extend the PO correlator from simple vendor response counting into a reusable vendor communication memory layer. Then route the acknowledgement agent through a stricter decision policy that suppresses system/marketplace chatter, prefers leaving purchase emails visible, and only auto-replies when vendor history and email type both justify it.

**Tech Stack:** TypeScript, Gmail API, Supabase, Vitest

---

### Task 1: Add failing tests for purchase email reply policy

**Files:**
- Modify: `src/lib/intelligence/acknowledgement-agent.test.ts`
- Create: `src/lib/intelligence/po-correlator.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- marketplace/order-status emails do not get auto-replied even if classified as routine
- PO thread acknowledgements with prior vendor reply become Follow Up or visible/no-reply instead of canned thanks
- vendor profiles can summarize recent response style from PO thread examples

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/po-correlator.test.ts`

Expected: FAIL for missing response-policy behavior and new correlator helpers.

**Step 3: Commit**

```bash
git add src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/po-correlator.test.ts
git commit -m "test(email): cover purchase response policy"
```

### Task 2: Extend PO correlator into vendor response memory

**Files:**
- Modify: `src/lib/intelligence/po-correlator.ts`
- Test: `src/lib/intelligence/po-correlator.test.ts`

**Step 1: Write minimal implementation**

Add reusable response-memory helpers that derive:
- vendor communication pattern
- whether Bill usually replies after vendor acknowledgements
- whether marketplace/system updates should be reply-suppressed
- recent PO email examples that can be surfaced later

Keep this pure where possible so the acknowledgement agent can consume it cheaply.

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/po-correlator.test.ts`

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/intelligence/po-correlator.ts src/lib/intelligence/po-correlator.test.ts
git commit -m "feat(email): add vendor response memory from PO threads"
```

### Task 3: Route acknowledgement decisions through vendor history

**Files:**
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
- Modify: `src/lib/intelligence/email-feedback.ts`
- Test: `src/lib/intelligence/acknowledgement-agent.test.ts`

**Step 1: Write minimal implementation**

Add a decision helper that:
- blocks auto-replies for marketplace/system/order-status senders
- blocks auto-replies for PO-labeled or purchase-thread updates that should stay visible
- uses PO/vendor response memory to decide whether a short acknowledgement is normal for that vendor
- leaves items unread/visible when Bill likely needs to respond
- records a clearer reason in email feedback

Keep auto-replies available, but narrower and more context-aware.

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts`

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/email-feedback.ts src/lib/intelligence/acknowledgement-agent.test.ts
git commit -m "feat(email): make purchase replies history-aware"
```

### Task 4: Wire visibility/label behavior for purchase emails

**Files:**
- Modify: `src/lib/intelligence/acknowledgement-agent.ts`
- Modify: `src/lib/intelligence/gmail-policy.ts` (only if needed)
- Test: `src/lib/intelligence/acknowledgement-agent.test.ts`

**Step 1: Implement label/read behavior**

Ensure purchase-related messages that need Bill stay:
- visible in inbox
- unread when they still need response
- labeled `Follow Up` when clearly actionable

Routine purchase updates that should not be answered may still stay visible, but must avoid noisy reply behavior.

**Step 2: Run targeted tests**

Run: `npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts`

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/acknowledgement-agent.test.ts
git commit -m "fix(email): keep actionable purchase threads visible"
```

### Task 5: Verify the full email slice

**Files:**
- Verify: `src/lib/intelligence/acknowledgement-agent.ts`
- Verify: `src/lib/intelligence/po-correlator.ts`
- Verify: `src/lib/intelligence/email-feedback.ts`

**Step 1: Run focused verification**

Run:

```bash
npx vitest run src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/po-correlator.test.ts src/lib/intelligence/email-feedback.test.ts
```

Expected: PASS

**Step 2: Optional smoke checks**

Run:

```bash
npx tsx -e "import './src/lib/intelligence/acknowledgement-agent.ts'; import './src/lib/intelligence/po-correlator.ts'; console.log('import-smoke-ok')"
```

Expected: `import-smoke-ok`

**Step 3: Final commit**

```bash
git add src/lib/intelligence/acknowledgement-agent.ts src/lib/intelligence/acknowledgement-agent.test.ts src/lib/intelligence/po-correlator.ts src/lib/intelligence/po-correlator.test.ts src/lib/intelligence/email-feedback.ts docs/plans/2026-03-31-email-response-policy.md
git commit -m "fix(email): tighten purchase reply decisions"
```
