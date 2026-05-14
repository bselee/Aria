# Activity Human Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the Activity terminal into a guided operations surface with attention prioritization, notes, process state, invoice/PO correlation explanations, and teachable human corrections.

**Architecture:** Keep the compact terminal as the primary UI, but move workflow decisions into tested pure helpers. Persist human workflow fields on `ap_activity_log` through a small dashboard API route, and render controls only for AP activity rows that need human attention or can teach the system.

**Tech Stack:** Next.js App Router, React, Supabase, Vitest, Tailwind CSS.

---

### Task 1: Activity Workflow Helpers

**Files:**
- Create: `src/components/dashboard/activityWorkflow.ts`
- Modify: `src/components/dashboard/ActivityTerminal.tsx`
- Test: `src/components/dashboard/activityWorkflow.test.ts`

**Steps:**
1. Write failing tests for intent normalization, attention ranking, next human action, link generation, process-state defaults, and invoice/PO correlation explanation.
2. Run `npx vitest run src/components/dashboard/activityWorkflow.test.ts` and confirm the tests fail because helpers do not exist.
3. Implement pure helpers and types.
4. Refactor `ActivityTerminal.tsx` to import those helpers.
5. Run the workflow helper tests and existing `ActivityTerminal.test.ts`.

### Task 2: Activity Workflow API

**Files:**
- Create: `src/app/api/dashboard/activity/[id]/workflow/route.ts`
- Create: `src/app/api/dashboard/activity/[id]/workflow/route.test.ts`
- Create migration: `supabase/migrations/20260514_activity_human_workflow.sql`

**Steps:**
1. Write failing API tests for patching note, process state, resolution, and learning candidate fields.
2. Run the API test and confirm failure because the route is missing.
3. Implement `PATCH` with a narrow allowed field list.
4. Add migration columns on `ap_activity_log`: `human_note`, `human_note_by`, `human_note_at`, `process_state`, `resolution`, `learning_candidate`.
5. Run the API tests.

### Task 3: Terminal UI Controls

**Files:**
- Modify: `src/components/dashboard/ActivityTerminal.tsx`
- Test: `src/components/dashboard/ActivityTerminal.test.tsx`

**Steps:**
1. Write failing UI tests for pinned `Needs Eyes`, note input, state buttons, and teach toggle.
2. Implement controls inside expanded AP rows and a pinned attention strip above the feed.
3. Run component tests.

### Task 4: AP/Reconciliation Correlation Learning

**Files:**
- Modify: `src/components/dashboard/activityWorkflow.ts`
- Modify: `src/components/dashboard/ActivityTerminal.tsx`
- Test: `src/components/dashboard/activityWorkflow.test.ts`

**Steps:**
1. Write failing tests that convert reconciliation metadata into positive/negative correlation signals and a teach-from-correction payload.
2. Implement correlation rendering data.
3. Render correlation details in expanded reconciliation rows.
4. Run workflow and terminal tests.

### Task 5: Verification

**Commands:**
- `npx vitest run src/components/dashboard/activityWorkflow.test.ts src/components/dashboard/ActivityTerminal.test.ts src/app/api/dashboard/activity/[id]/workflow/route.test.ts src/app/api/dashboard/invoice-queue/route.test.ts src/lib/intelligence/ap-agent.test.ts`
- `git diff --check`
- `npm run typecheck` if it completes in reasonable time; if it times out, report timeout and the last known blocker.
