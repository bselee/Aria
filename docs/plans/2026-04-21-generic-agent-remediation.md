# Generic Agent Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stabilize the GenericAgent-inspired oversight install and add the narrow skill-learning features that are worth shipping now.

**Architecture:** Standardize the runtime on the existing ops control-plane heartbeat schema, replace fake recovery with registered recovery hooks and control-plane requests, then align task-history and skill persistence to the real database schema. Keep Pinecone optional for archives, and keep skill learning narrow: pending skills, counters, confidence, and shadow-mode records only.

**Tech Stack:** TypeScript, Vitest, Supabase, existing ops control-plane helpers, React dashboard

---

### Task 1: Add failing tests for OversightAgent schema and recovery behavior

**Files:**
- Create: `src/lib/intelligence/oversight-agent.test.ts`
- Modify: `src/lib/intelligence/oversight-agent.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- `registerHeartbeat()` writes `heartbeat_at`, lowercase `status`, and `metadata`
- `checkAllHeartbeats()` reads `heartbeat_at`
- `handleDownAgent()` calls a registered retry hook before fallback behavior
- `handleDownAgent()` requests a control-plane command when retry fails
- `handleDownAgent()` does not report success when it only rewrites a heartbeat row

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/intelligence/oversight-agent.test.ts`

Expected: FAIL because the current implementation still uses the incompatible heartbeat schema and fake retry behavior.

**Step 3: Implement the minimal code**

Update `OversightAgent` to:
- use the control-plane heartbeat shape
- store `currentTask` and `metrics` in `metadata`
- support registered recovery hooks
- use ops-control requests for restart-like recovery instead of shelling out

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/oversight-agent.test.ts`

Expected: PASS

### Task 2: Add failing tests for reliable task-history persistence

**Files:**
- Create: `src/lib/intelligence/memory-layer-manager.test.ts`
- Modify: `src/lib/intelligence/memory-layer-manager.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- `archiveSession()` still writes to `task_history` when Pinecone embedding/indexing fails
- `loadRecentSessions()` maps persisted rows back to the public shape correctly

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/intelligence/memory-layer-manager.test.ts`

Expected: FAIL because the current implementation gates the Supabase write behind the Pinecone try block.

**Step 3: Implement the minimal code**

Split archival into:
- best-effort Pinecone archive
- independent Supabase `task_history` insert

Keep failures isolated so audit persistence does not depend on Pinecone availability.

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/memory-layer-manager.test.ts`

Expected: PASS

### Task 3: Add failing tests for skill persistence against the real schema

**Files:**
- Create: `src/lib/intelligence/skill-crystallizer.test.ts`
- Modify: `src/lib/intelligence/skill-crystallizer.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- `crystallize()` writes `name`, `description`, `trigger`, and `steps`
- `approveSkill()` and `rejectSkill()` update the expected columns
- `recordInvocation()` increments `times_invoked`, `times_succeeded`, and updates `confidence`
- `recordShadowRun()` writes a `task_history` row with `status = 'shadow'`

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/intelligence/skill-crystallizer.test.ts`

Expected: FAIL because the current implementation writes the wrong schema and does not support counters or shadow runs.

**Step 3: Implement the minimal code**

Update `SkillCrystallizer` to:
- align with the real `skills` table
- add narrow confidence/counter tracking
- add shadow-run task-history logging

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/skill-crystallizer.test.ts`

Expected: PASS

### Task 4: Add failing tests for runtime wiring in OpsManager

**Files:**
- Create: `src/lib/intelligence/ops-manager.oversight.test.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`
- Modify: `src/lib/intelligence/email-polling-cycle.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- `safeRun()` records task history for scheduled work
- AP/default inbox polling updates logical-agent heartbeats, not only `ops-manager`
- `OpsManager.start()` still starts oversight and cron registration

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/intelligence/ops-manager.oversight.test.ts`

Expected: FAIL because the current runtime only records `ops-manager` heartbeats.

**Step 3: Implement the minimal code**

Wire logical heartbeats and recovery registrations into:
- `ops-manager`
- default inbox pipeline
- AP pipeline
- nightshift entrypoint if applicable from existing scheduler surfaces

Record task history for scheduled tasks through the stable archive path.

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/intelligence/ops-manager.oversight.test.ts`

Expected: PASS

### Task 5: Add failing tests for dashboard alignment

**Files:**
- Create: `src/components/dashboard/OversightPanel.test.tsx`
- Modify: `src/components/dashboard/OversightPanel.tsx`

**Step 1: Write the failing tests**

Add tests that prove:
- the panel reads `heartbeat_at` from `agent_heartbeats`
- it renders `metadata.currentTask` rather than a removed `current_task` column
- it does not assume uppercase statuses

**Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/dashboard/OversightPanel.test.tsx`

Expected: FAIL because the current panel expects the wrong row shape.

**Step 3: Implement the minimal code**

Update the panel to map the unified schema into the UI shape locally.

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/dashboard/OversightPanel.test.tsx`

Expected: PASS

### Task 6: Add the missing migration for `memories` or remove the fake dependency

**Files:**
- Modify: `src/lib/intelligence/memory-layer-manager.ts`
- Optional Create: `supabase/migrations/20260421_create_memories.sql`

**Step 1: Decide the minimal fix**

Prefer:
- remove the implicit dependency from the runtime paths we are activating now

Only add the migration if `MemoryLayerManager.remember()` remains a supported path after this remediation.

**Step 2: Implement the minimal code**

Ensure no active runtime path depends on a table that may not exist.

**Step 3: Verify**

Run the focused tests from Tasks 2 and 4 again.

Expected: PASS

### Task 7: Run focused verification

**Files:**
- No code changes

**Step 1: Run the targeted suite**

Run:

```bash
npx vitest run src/lib/intelligence/oversight-agent.test.ts src/lib/intelligence/memory-layer-manager.test.ts src/lib/intelligence/skill-crystallizer.test.ts src/lib/intelligence/ops-manager.oversight.test.ts src/components/dashboard/OversightPanel.test.tsx
```

Expected: PASS

**Step 2: Run the adjacent existing tests likely to be impacted**

Run:

```bash
npx vitest run src/lib/ops/control-plane.test.ts src/lib/intelligence/email-polling-cycle.test.ts
```

Expected: PASS

**Step 3: Summarize residual risk**

Document:
- any untested runtime surfaces
- any intentionally deferred GenericAgent ideas
- whether a follow-up migration is still needed
