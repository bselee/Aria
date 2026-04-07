# Finale Access Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restrict Finale purchase-order writes to the dashboard purchasing flow, while recording every allowed or denied write attempt for auditability.

**Architecture:** Put a small write gate at the Finale mutation boundary instead of trying to refactor every caller at once. Dashboard routes pass an explicit write context, the Finale client enforces the allowlist, and audit logging records both successful authorizations and blocked attempts.

**Tech Stack:** Next.js, TypeScript, Vitest, Supabase

---

### Task 1: Add Finale write gate policy tests

**Files:**
- Create: `src/lib/finale/write-access.test.ts`
- Create: `src/lib/finale/write-access.ts`

**Step 1: Write the failing test**

Add tests proving:

- `dashboard:create_draft_po` is allowed
- `dashboard:commit_draft_po` is allowed
- `slack_watchdog:create_draft_po` is denied
- `cli:commit_draft_po` is denied

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/write-access.test.ts`
Expected: FAIL because the module does not exist yet.

**Step 3: Write minimal implementation**

Create a small write-access module with:

- `FinaleWriteSource`
- `FinaleWriteAction`
- `FinaleWriteContext`
- `assertFinaleWriteAllowed(context)`

Implement a minimal allowlist for dashboard draft creation and dashboard commit.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/write-access.test.ts`
Expected: PASS

### Task 2: Add audit logging helpers for write attempts

**Files:**
- Modify: `src/lib/finale/write-access.ts`
- Create: `src/lib/finale/write-access-log.ts`
- Create: `src/lib/finale/write-access-log.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- an allowed attempt records `allowed: true`
- a denied attempt records `allowed: false` with a denial reason
- logging failure does not replace the primary authorization result

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/write-access-log.test.ts`
Expected: FAIL because the logging helper does not exist yet.

**Step 3: Write minimal implementation**

Create a lightweight logging helper that can:

- write to Supabase when available, or
- fall back to a structured console log if needed for this pass

Keep the record small and consistent.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/write-access-log.test.ts`
Expected: PASS

### Task 3: Gate Finale draft creation at the client boundary

**Files:**
- Modify: `src/lib/finale/client.ts`
- Test: `src/lib/finale/client.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- `createDraftPurchaseOrder(...)` throws when called without an allowed dashboard write context
- `createDraftPurchaseOrder(...)` proceeds when called with `{ source: "dashboard", action: "create_draft_po" }`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/client.test.ts`
Expected: FAIL because the method does not yet require or enforce write context.

**Step 3: Write minimal implementation**

Update `createDraftPurchaseOrder(...)` to require a write context, validate it before issuing the HTTP request, and record the attempt.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/client.test.ts`
Expected: PASS

### Task 4: Gate Finale commit at the client boundary

**Files:**
- Modify: `src/lib/finale/client.ts`
- Test: `src/lib/finale/client.test.ts`
- Test: `src/lib/copilot/actions.po-send.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- `commitDraftPO(...)` throws when called from a non-dashboard source
- dashboard-triggered PO send still commits successfully through the approved path

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/finale/client.test.ts src/lib/copilot/actions.po-send.test.ts`
Expected: FAIL because commit does not yet require or pass the approved write context.

**Step 3: Write minimal implementation**

Update `commitDraftPO(...)` to require write context and thread the dashboard source through the PO send action path.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/finale/client.test.ts src/lib/copilot/actions.po-send.test.ts`
Expected: PASS

### Task 5: Update dashboard purchasing routes to pass explicit write context

**Files:**
- Modify: `src/app/api/dashboard/purchasing/route.ts`
- Modify: `src/app/api/dashboard/purchasing/commit/route.ts`
- Test: `src/app/api/dashboard/purchasing/route.test.ts`
- Create: `src/app/api/dashboard/purchasing/commit/route.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- dashboard draft creation passes the dashboard write context
- dashboard review/send flow continues to work with the approved source

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts`
Expected: FAIL because the routes do not yet provide explicit write context.

**Step 3: Write minimal implementation**

Pass `{ source: "dashboard", action: "create_draft_po" }` from the purchasing route and `{ source: "dashboard", action: "commit_draft_po" }` from the commit path.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts`
Expected: PASS

### Task 6: Verify blocked non-dashboard callers fail closed

**Files:**
- Modify: `src/lib/slack/watchdog.ts` only if needed to pass explicit denied source for clearer errors
- Verify: selected existing callers under `src/cli/`, `src/lib/intelligence/`, and `src/lib/slack/`

**Step 1: Write the failing test**

If needed, add one focused regression test proving a non-dashboard path receives a clear denial instead of silently writing.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/slack/request-tracker.test.ts`
Expected: FAIL only if a new regression test is added for write denial behavior.

**Step 3: Write minimal implementation**

Only make small caller updates needed for clarity or testability. Do not reopen write permissions for non-dashboard sources.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/slack/request-tracker.test.ts`
Expected: PASS

### Task 7: Run focused verification

**Files:**
- Verify: `src/lib/finale/write-access.test.ts`
- Verify: `src/lib/finale/write-access-log.test.ts`
- Verify: `src/lib/finale/client.test.ts`
- Verify: `src/lib/copilot/actions.po-send.test.ts`
- Verify: `src/app/api/dashboard/purchasing/route.test.ts`
- Verify: `src/app/api/dashboard/purchasing/commit/route.test.ts`

**Step 1: Run focused tests**

Run: `npx vitest run src/lib/finale/write-access.test.ts src/lib/finale/write-access-log.test.ts src/lib/finale/client.test.ts src/lib/copilot/actions.po-send.test.ts src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.test.ts`
Expected: PASS

**Step 2: Run type verification for changed surfaces**

Run: `npx tsc --noEmit --project tsconfig.cli.json`
Expected: exit 0 with no TypeScript errors, or document any timeout if the environment still stalls on full CLI typecheck.

**Step 3: Commit**

```bash
git add docs/plans/2026-04-07-finale-access-hardening-design.md docs/plans/2026-04-07-finale-access-hardening.md src/lib/finale/write-access.ts src/lib/finale/write-access.test.ts src/lib/finale/write-access-log.ts src/lib/finale/write-access-log.test.ts src/lib/finale/client.ts src/lib/finale/client.test.ts src/lib/copilot/actions.po-send.test.ts src/app/api/dashboard/purchasing/route.ts src/app/api/dashboard/purchasing/route.test.ts src/app/api/dashboard/purchasing/commit/route.ts src/app/api/dashboard/purchasing/commit/route.test.ts
git commit -m "Gate Finale PO writes to dashboard flows"
```
