# Plan D — Agentic Issue Lifecycle (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agent_issue` ledger that groups related `agent_task` rows into business-flow issues with explicit lifecycle / autonomy / blocker / next_action fields, and surface the issue list on the dashboard + Telegram. Phase 1 is read-mostly: the AP pipeline and other spoke writers stay on the existing `agent_task` surface; a projection cron derives issues from their tasks.

**Architecture:** New `agent_issue` table holds the parent operational item. `agent_task` gains a nullable `issue_id` foreign key. A projection cron groups open + recently-closed tasks by *business-flow key* (vendor + invoice/PO/order id, falling back to source_table:source_id) and upserts issue rows. The command-board service projects issues into `CommandBoardIssue` cards. New API routes and a Telegram `/issues` command serve them. Phase 2 (separate plan) will rewire spoke writers to create issues directly and replace task lanes with issue lanes in the UI.

**Tech Stack:** Supabase (Postgres), Next.js App Router, Telegraf, Vitest, existing `agent-task` + `cron-registry` + `OpsManager` plumbing.

---

## Non-Negotiable Guardrails

- **Never break the existing AP pipeline.** Phase 1 is purely additive — `agent_task` writes proceed exactly as they do today. Issues are *derived*. Spoke-writer rewiring is Phase 2.
- **`blocked` is reserved for true exhaustion.** A task that fails once is `working` (with `autonomy_state = retrying`) until the playbook runner exhausts retries OR an explicit blocker is set. The projection cron must NOT mark issues blocked just because their latest task is in FAILED status.
- **`policy_required` ≠ `human_approval_required`.** First means Aria doesn't know the rule; second means Aria knows the rule but Will must approve. Both populate `blocker_reason` but downstream UIs may color them differently.
- **Manual issues use NULL source columns.** `source_table = NULL`, `source_id = NULL`, `inputs.created_by = "will-dashboard"` (or `"will-telegram"`). The projection cron must skip rows where `source_table IS NULL`.
- **The `getBySource` / `incrementOrCreate` / `decideApproval` shape from `agent-task.ts` is the model to mirror.** Best-effort writes (don't throw on hub-write failures), `appendEvent` for every state change.
- **Backfill window per Will's spec:** open issues at any age, terminal issues only from the last 14 days. Hard-coded in `RECENT_TERMINAL_WINDOW_MS = 14 * 24 * 3600 * 1000`.
- **Telegram `/tasks` keeps working.** Phase 1 introduces `/issues` as the new primary; `/tasks` becomes an alias that calls the same issue-render path with the wording "Open issues". No breakage of muscle memory.

## Out of Scope

- Phase 2 — spoke-writer rewiring (AP-agent, reconciler, dropship-store) to create issues directly.
- Phase 3 — replacing the dashboard task lanes with issue lanes.
- Issue merging UI (mention but defer the `mergeIssues(targetId, sourceId)` helper to Phase 2).
- New playbooks for issue-level autonomy (Layer C ships at task level today; Phase 2 expands).

---

## Preflight

```bash
# Confirm Layer A + B + C are merged and applied.
node _run_migration.js --check 2>&1 || true

# Confirm Supabase connection.
node -e "require('dotenv').config({path:'.env.local'}); console.log('db ok:', Boolean(process.env.DATABASE_URL))"

# Full test suite green at HEAD before starting.
npm test 2>&1 | tail -5
# Expected: 1 pre-existing failure (test-single-po-calendar). All else green.
```

If anything else fails, stop and fix before proceeding.

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260509_create_agent_issue.sql` | New table + FK + check constraints + indices. |
| `src/lib/intelligence/agent-issue.ts` | Public lib: types, `createOrAdvance`, `recordHandoff`, `setBlocker`, `clearBlocker`, `complete`, `linkTask`, `listIssues`, `getById`, `getBySource`. |
| `src/lib/intelligence/agent-issue.test.ts` | Unit tests for the lib (mocked Supabase). |
| `src/lib/intelligence/issue-projection.ts` | Pure logic: `businessFlowKey(task)`, `groupTasksByFlow(tasks)`, `deriveIssueState(group)`. |
| `src/lib/intelligence/issue-projection.test.ts` | Unit tests for grouping + state derivation. |
| `src/lib/intelligence/issue-projection-cron.ts` | Wraps projection: query tasks, group, upsert issues, link `agent_task.issue_id`. |
| `src/lib/scheduler/cron-registry.ts` | Register `IssueProjection` cron entry. |
| `src/lib/scheduler/cron-registry.test.ts` | Bump count + add to expected list. |
| `src/lib/intelligence/ops-manager.ts` | Schedule the projection cron. |
| `src/lib/command-board/types.ts` | `CommandBoardIssue`, `CommandBoardIssueDetail`, `CommandBoardIssueFilters`. |
| `src/lib/command-board/service.ts` | `getCommandBoardIssues(filters)`, `getCommandBoardIssueDetail(id)`. |
| `src/app/api/command-board/issues/route.ts` | `GET` list, `POST` manual creation. |
| `src/app/api/command-board/issues/[id]/route.ts` | `GET` detail. |
| `src/cli/start-bot.ts` | Add `/issues` command + reroute `/tasks` to the same render path. |

---

## Task 1: Migration — `agent_issue` table

**Files:**
- Create: `supabase/migrations/20260509_create_agent_issue.sql`

- [ ] **Step 1.1: Write migration**

```sql
-- Migration: Create agent_issue parent ledger
-- Created: 2026-05-09
-- Purpose: Phase 1 of agentic issue lifecycle — group related agent_task
--          rows under a parent issue with explicit lifecycle, autonomy,
--          blocker, and next_action fields.
--
-- Phase 1 is additive only. Existing agent_task writes proceed unchanged.
-- A projection cron derives issues from tasks via shared business-flow key.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_agent_issue_lifecycle_state;
--   DROP INDEX IF EXISTS idx_agent_issue_business_flow_key;
--   DROP INDEX IF EXISTS idx_agent_issue_owner_priority;
--   DROP INDEX IF EXISTS idx_agent_task_issue_id;
--   ALTER TABLE agent_task DROP COLUMN IF EXISTS issue_id;
--   DROP TABLE IF EXISTS agent_issue;

CREATE TABLE IF NOT EXISTS public.agent_issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    -- Source columns are NULL for manually-created issues.
    source_table    TEXT,
    source_id       TEXT,
    -- The grouping key the projection cron computes from task inputs.
    business_flow_key TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'detected'
        CHECK (lifecycle_state IN ('detected','triaging','working','waiting_external','blocked','complete')),
    autonomy_state  TEXT
        CHECK (autonomy_state IS NULL OR autonomy_state IN ('working','waiting','retrying','resolved','needs_policy')),
    current_handler TEXT,
    blocker_reason  TEXT
        CHECK (blocker_reason IS NULL OR blocker_reason IN (
            'missing_receipt','po_not_found','vendor_mismatch','extraction_failed',
            'policy_required','external_pending','duplicate_or_conflict',
            'source_unavailable','auth_required','data_integrity_error',
            'retry_exhausted','human_approval_required','unknown'
        )),
    next_action     TEXT,
    priority        SMALLINT NOT NULL DEFAULT 2,
    owner           TEXT NOT NULL DEFAULT 'aria',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Manual issues have null source_table; system issues are unique by source.
    -- Partial unique index (not a constraint) so manual issues coexist freely.
    -- Business-flow key is unique per *open* lifecycle for projection idempotency.
    CONSTRAINT agent_issue_priority_range CHECK (priority BETWEEN 0 AND 9)
);

-- Open business-flow keys must be unique. Closed/blocked rows can repeat
-- (e.g. same flow re-fired after a complete).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_issue_business_flow_open
    ON public.agent_issue (business_flow_key)
    WHERE lifecycle_state IN ('detected','triaging','working','waiting_external','blocked');

CREATE INDEX IF NOT EXISTS idx_agent_issue_lifecycle_state
    ON public.agent_issue (lifecycle_state, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_issue_business_flow_key
    ON public.agent_issue (business_flow_key);

CREATE INDEX IF NOT EXISTS idx_agent_issue_owner_priority
    ON public.agent_issue (owner, priority, created_at DESC);

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_issue_id
    ON public.agent_task (issue_id)
    WHERE issue_id IS NOT NULL;

-- Issue-scoped events live in the same task_history ledger as task events,
-- but task_history.task_id is FK'd to agent_task — passing an agent_issue.id
-- through agent-task.appendEvent() would silently fail FK validation.
-- Add a parallel issue_id column so issue events have a real home.
ALTER TABLE public.task_history
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

-- Make task_id nullable so an event can be issue-scoped without a task.
ALTER TABLE public.task_history
    ALTER COLUMN task_id DROP NOT NULL;

-- An event must reference at least one of (task_id, issue_id).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'task_history_task_or_issue_check'
    ) THEN
        ALTER TABLE public.task_history
            ADD CONSTRAINT task_history_task_or_issue_check
            CHECK (task_id IS NOT NULL OR issue_id IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_history_issue_event
    ON public.task_history (issue_id, created_at DESC)
    WHERE issue_id IS NOT NULL;
```

- [ ] **Step 1.2: Apply migration**

```bash
node _run_migration.js supabase/migrations/20260509_create_agent_issue.sql
```

Expected: `✅ Applied`.

- [ ] **Step 1.3: Verify schema**

```bash
node -e "require('dotenv').config({path:'.env.local'}); const{Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='agent_issue' ORDER BY ordinal_position\")).then(r=>{console.log(r.rows.map(x=>x.column_name).join(',')); return c.end()})"
```

Expected output: `id,title,source_table,source_id,business_flow_key,lifecycle_state,autonomy_state,current_handler,blocker_reason,next_action,priority,owner,created_at,updated_at,completed_at,inputs,outputs`

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/20260509_create_agent_issue.sql
git commit -m "feat(issue-ledger): migration — agent_issue table + agent_task.issue_id"
```

---

## Task 2: `agent-issue.ts` — types

**Files:**
- Create: `src/lib/intelligence/agent-issue.ts`

- [ ] **Step 2.1: Write types-only first pass**

```ts
/**
 * @file    agent-issue.ts
 * @purpose Phase 1 of the agentic issue lifecycle. Issues group related
 *          agent_task rows under a parent ledger with explicit lifecycle /
 *          autonomy / blocker / next_action fields. Spoke writers continue
 *          to write tasks; the issue-projection cron derives + maintains
 *          issue rows for now. Phase 2 will rewire spoke writers to
 *          create+advance issues directly.
 *
 *          Mirrors the surface of agent-task.ts intentionally so callers
 *          have a familiar API.
 */

import { createClient } from "@/lib/supabase";

// ── Issue-scoped event ledger (separate from task events) ───────────────────
//
// task_history.task_id is FK'd to agent_task.id, so we can't reuse
// agent-task.appendEvent() for issue lifecycle — it'd silently FK-fail.
// Migration 20260509 adds task_history.issue_id and makes task_id nullable;
// this helper writes rows scoped to an issue.
async function appendIssueEvent(
    issueId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const statusBucket =
        eventType === "issue_complete" ? "success"
            : eventType === "issue_blocked" ? "failure"
                : "shadow";

    const { error } = await supabase.from("task_history").insert({
        task_id: null,
        issue_id: issueId,
        agent_name: typeof payload.agent_name === "string" ? payload.agent_name : "agent-issue",
        task_type: typeof payload.task_type === "string" ? payload.task_type : "issue_lifecycle",
        event_type: eventType,
        status: statusBucket,
        input_summary: typeof payload.input_summary === "string" ? payload.input_summary : "",
        output_summary: typeof payload.output_summary === "string" ? payload.output_summary : "",
        execution_trace: payload,
    });
    if (error) {
        console.warn("[agent-issue] appendIssueEvent failed:", error.message);
    }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type IssueLifecycleState =
    | "detected"
    | "triaging"
    | "working"
    | "waiting_external"
    | "blocked"
    | "complete";

export type IssueAutonomyState =
    | "working"
    | "waiting"
    | "retrying"
    | "resolved"
    | "needs_policy";

export type IssueBlockerReason =
    | "missing_receipt"
    | "po_not_found"
    | "vendor_mismatch"
    | "extraction_failed"
    | "policy_required"
    | "external_pending"
    | "duplicate_or_conflict"
    | "source_unavailable"
    | "auth_required"
    | "data_integrity_error"
    | "retry_exhausted"
    | "human_approval_required"
    | "unknown";

export type AgentIssue = {
    id: string;
    title: string;
    source_table: string | null;
    source_id: string | null;
    business_flow_key: string;
    lifecycle_state: IssueLifecycleState;
    autonomy_state: IssueAutonomyState | null;
    current_handler: string | null;
    blocker_reason: IssueBlockerReason | null;
    next_action: string | null;
    priority: number;
    owner: string;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
};

export type CreateOrAdvanceArgs = {
    /** Required. The grouping key — see issue-projection.ts businessFlowKey(). */
    businessFlowKey: string;
    /** Required on first create; optional on advance (existing title preserved). */
    title?: string;
    sourceTable?: string | null;
    sourceId?: string | null;
    lifecycleState?: IssueLifecycleState;
    autonomyState?: IssueAutonomyState | null;
    currentHandler?: string | null;
    nextAction?: string | null;
    priority?: number;
    owner?: string;
    inputs?: Record<string, unknown>;
};

// ── Hub kill-switch (mirrors agent-task hubEnabled) ─────────────────────────
function hubEnabled(): boolean {
    const v = (process.env.HUB_TASKS_ENABLED ?? "true").toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}
```

(Functions in next steps — keep this file compiling.)

- [ ] **Step 2.2: Run typecheck to confirm clean foundation**

```bash
npm run typecheck:cli
```

Expected: 0 errors.

---

## Task 3: `agent-issue.ts` — `createOrAdvance` + tests

**Files:**
- Modify: `src/lib/intelligence/agent-issue.ts`
- Create: `src/lib/intelligence/agent-issue.test.ts`

- [ ] **Step 3.1: Write the failing test**

`src/lib/intelligence/agent-issue.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const supabaseMock = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
    single: vi.fn(),
};

vi.mock("@/lib/supabase", () => ({ createClient: () => supabaseMock }));
vi.mock("./agent-task", () => ({ appendEvent: vi.fn().mockResolvedValue(undefined) }));

import { createOrAdvance } from "./agent-issue";

describe("createOrAdvance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset chain
        supabaseMock.from.mockReturnThis();
        supabaseMock.select.mockReturnThis();
        supabaseMock.eq.mockReturnThis();
        supabaseMock.in.mockReturnThis();
        supabaseMock.upsert.mockReturnThis();
        supabaseMock.update.mockReturnThis();
        supabaseMock.insert.mockReturnThis();
    });

    it("creates a new issue when no row exists for the business_flow_key", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null });   // existing-row lookup
        supabaseMock.single.mockResolvedValueOnce({                       // insert
            data: {
                id: "new-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                business_flow_key: "colorado-worm-co|inv:124618",
                lifecycle_state: "detected",
            },
            error: null,
        });

        const issue = await createOrAdvance({
            businessFlowKey: "colorado-worm-co|inv:124618",
            title: "Invoice 124618 — Colorado Worm Co.",
            sourceTable: "ap_inbox_queue",
            sourceId: "msg-id-123",
        });

        expect(issue?.id).toBe("new-id");
        expect(issue?.lifecycle_state).toBe("detected");
        expect(supabaseMock.insert).toHaveBeenCalled();
    });

    it("advances an existing open issue without changing its title", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: {
                id: "existing-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                business_flow_key: "colorado-worm-co|inv:124618",
                lifecycle_state: "detected",
            },
        });
        supabaseMock.single.mockResolvedValueOnce({
            data: {
                id: "existing-id",
                title: "Invoice 124618 — Colorado Worm Co.",
                lifecycle_state: "working",
                current_handler: "ap-agent",
            },
            error: null,
        });

        const issue = await createOrAdvance({
            businessFlowKey: "colorado-worm-co|inv:124618",
            lifecycleState: "working",
            currentHandler: "ap-agent",
            // Title intentionally omitted — should be preserved.
        });

        expect(issue?.id).toBe("existing-id");
        expect(issue?.lifecycle_state).toBe("working");
        // Update path used, not insert.
        expect(supabaseMock.update).toHaveBeenCalled();
        expect(supabaseMock.insert).not.toHaveBeenCalled();
    });

    it("returns null when HUB_TASKS_ENABLED is off", async () => {
        process.env.HUB_TASKS_ENABLED = "false";
        const issue = await createOrAdvance({
            businessFlowKey: "k",
            title: "t",
        });
        expect(issue).toBeNull();
        delete process.env.HUB_TASKS_ENABLED;
    });

    it("preserves explicit blocked state — projection cannot revert it", async () => {
        // The existing issue was explicitly blocked by setBlocker().
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: {
                id: "blocked-id",
                title: "Existing",
                business_flow_key: "k",
                lifecycle_state: "blocked",
                blocker_reason: "missing_receipt",
                next_action: "Wait for warehouse",
            },
        });
        // Capture the patch applied via update().
        let appliedPatch: Record<string, unknown> | null = null;
        supabaseMock.update.mockImplementationOnce((p: Record<string, unknown>) => {
            appliedPatch = p;
            return supabaseMock;
        });
        supabaseMock.single.mockResolvedValueOnce({
            data: { id: "blocked-id", lifecycle_state: "blocked" },
            error: null,
        });

        await createOrAdvance({
            businessFlowKey: "k",
            // Projection-shaped input that WOULD normally move us back to working:
            lifecycleState: "working",
            autonomyState: "working",
            currentHandler: "ap-agent",
            nextAction: "Try again",
            // ...and a safe metadata bump that SHOULD apply:
            priority: 1,
            inputs: { task_count: 4 },
        });

        expect(appliedPatch).not.toBeNull();
        // Lifecycle / autonomy / handler / next_action MUST be omitted from the patch.
        expect(appliedPatch).not.toHaveProperty("lifecycle_state");
        expect(appliedPatch).not.toHaveProperty("autonomy_state");
        expect(appliedPatch).not.toHaveProperty("current_handler");
        expect(appliedPatch).not.toHaveProperty("next_action");
        // Safe metadata DID apply.
        expect(appliedPatch).toHaveProperty("priority", 1);
        expect(appliedPatch).toHaveProperty("inputs");
    });
});
```

- [ ] **Step 3.2: Run failing**

```bash
npx vitest run src/lib/intelligence/agent-issue.test.ts
```

Expected: FAIL — `createOrAdvance` not exported.

- [ ] **Step 3.3: Implement `createOrAdvance`**

Append to `src/lib/intelligence/agent-issue.ts`:

```ts
export async function createOrAdvance(args: CreateOrAdvanceArgs): Promise<AgentIssue | null> {
    if (!hubEnabled()) return null;
    const supabase = createClient();
    if (!supabase) return null;

    // Look up existing OPEN issue with this business-flow key.
    const { data: existing } = await supabase
        .from("agent_issue")
        .select("*")
        .eq("business_flow_key", args.businessFlowKey)
        .in("lifecycle_state", ["detected","triaging","working","waiting_external","blocked"])
        .maybeSingle();

    if (existing) {
        // Behavioral guardrail (Will, 2026-04-28): an issue that was
        // explicitly marked `blocked` by setBlocker() must NOT be moved
        // back to working/triaging by the projection cron just because
        // its tasks look active. Only clearBlocker() can change lifecycle
        // out of blocked. Projection-style updates that arrive here for a
        // blocked issue are limited to safe metadata (priority, inputs).
        const isBlocked = existing.lifecycle_state === "blocked";

        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (!isBlocked) {
            if (args.lifecycleState !== undefined) patch.lifecycle_state = args.lifecycleState;
            if (args.autonomyState !== undefined) patch.autonomy_state = args.autonomyState;
            if (args.currentHandler !== undefined) patch.current_handler = args.currentHandler;
            if (args.nextAction !== undefined) patch.next_action = args.nextAction;
        }
        if (args.priority !== undefined) patch.priority = args.priority;
        if (args.owner !== undefined) patch.owner = args.owner;
        if (args.inputs !== undefined) patch.inputs = args.inputs;

        const { data: updated, error } = await supabase
            .from("agent_issue")
            .update(patch)
            .eq("id", existing.id)
            .select()
            .single();
        if (error) {
            console.warn("[agent-issue] advance failed:", error.message);
            return null;
        }
        if (!isBlocked && args.lifecycleState && args.lifecycleState !== existing.lifecycle_state) {
            await appendIssueEvent(existing.id, `issue_${args.lifecycleState}`, {
                task_type: "issue_lifecycle",
                output_summary: `${existing.lifecycle_state} → ${args.lifecycleState}`,
                from: existing.lifecycle_state,
                to: args.lifecycleState,
            });
        }
        return updated as AgentIssue;
    }

    // Create new.
    if (!args.title) {
        // Title required on first create. Caller bug — log and bail.
        console.warn("[agent-issue] createOrAdvance: title required when no existing row");
        return null;
    }
    const { data: created, error: insErr } = await supabase
        .from("agent_issue")
        .insert({
            title: args.title,
            source_table: args.sourceTable ?? null,
            source_id: args.sourceId ?? null,
            business_flow_key: args.businessFlowKey,
            lifecycle_state: args.lifecycleState ?? "detected",
            autonomy_state: args.autonomyState ?? "working",
            current_handler: args.currentHandler ?? null,
            next_action: args.nextAction ?? null,
            priority: args.priority ?? 2,
            owner: args.owner ?? "aria",
            inputs: args.inputs ?? {},
        })
        .select()
        .single();
    if (insErr) {
        console.warn("[agent-issue] create failed:", insErr.message);
        return null;
    }
    if (created?.id) {
        await appendIssueEvent(created.id, "issue_detected", {
            task_type: "issue_lifecycle",
            input_summary: args.title,
            output_summary: args.businessFlowKey,
            business_flow_key: args.businessFlowKey,
        });
    }
    return created as AgentIssue;
}
```

- [ ] **Step 3.4: Run, expect green**

```bash
npx vitest run src/lib/intelligence/agent-issue.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/intelligence/agent-issue.ts src/lib/intelligence/agent-issue.test.ts
git commit -m "feat(issue-ledger): agent-issue.createOrAdvance + types"
```

---

## Task 4: `agent-issue.ts` — `recordHandoff`, `setBlocker`, `clearBlocker`, `complete`, `linkTask`

**Files:**
- Modify: `src/lib/intelligence/agent-issue.ts`
- Modify: `src/lib/intelligence/agent-issue.test.ts`

- [ ] **Step 4.1: Add tests**

Append to `src/lib/intelligence/agent-issue.test.ts`:

```ts
import { recordHandoff, setBlocker, clearBlocker, complete, linkTask } from "./agent-issue";

describe("recordHandoff", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        supabaseMock.update.mockReturnThis();
        supabaseMock.eq.mockReturnThis();
        supabaseMock.eq.mockResolvedValue({ error: null });
    });

    it("updates current_handler and appends a handoff event", async () => {
        await recordHandoff("issue-id", "email-agent", "ap-agent", "Email classified as INVOICE");
        expect(supabaseMock.update).toHaveBeenCalledWith(
            expect.objectContaining({ current_handler: "ap-agent" }),
        );
    });
});

describe("setBlocker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        supabaseMock.update.mockReturnThis();
        supabaseMock.eq.mockReturnThis();
        supabaseMock.eq.mockResolvedValue({ error: null });
    });

    it("transitions lifecycle to blocked and stores reason + next_action", async () => {
        await setBlocker("issue-id", "missing_receipt", "Wait for warehouse to confirm receipt");
        expect(supabaseMock.update).toHaveBeenCalledWith(
            expect.objectContaining({
                lifecycle_state: "blocked",
                blocker_reason: "missing_receipt",
                next_action: "Wait for warehouse to confirm receipt",
            }),
        );
    });
});

describe("complete", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        supabaseMock.update.mockReturnThis();
        supabaseMock.eq.mockReturnThis();
        supabaseMock.eq.mockResolvedValue({ error: null });
    });

    it("transitions lifecycle to complete and sets completed_at", async () => {
        await complete("issue-id", { resolution: "AP approved" });
        expect(supabaseMock.update).toHaveBeenCalledWith(
            expect.objectContaining({ lifecycle_state: "complete" }),
        );
    });
});

describe("linkTask", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        supabaseMock.update.mockReturnThis();
        supabaseMock.eq.mockReturnThis();
        supabaseMock.eq.mockResolvedValue({ error: null });
    });

    it("sets agent_task.issue_id on the named task", async () => {
        await linkTask("task-id", "issue-id");
        expect(supabaseMock.from).toHaveBeenCalledWith("agent_task");
        expect(supabaseMock.update).toHaveBeenCalledWith({ issue_id: "issue-id" });
    });
});
```

- [ ] **Step 4.2: Run failing**

```bash
npx vitest run src/lib/intelligence/agent-issue.test.ts
```

Expected: 4 new tests fail with "is not a function".

- [ ] **Step 4.3: Implement the four helpers**

Append to `src/lib/intelligence/agent-issue.ts`:

```ts
export async function recordHandoff(
    issueId: string,
    fromHandler: string | null,
    toHandler: string,
    reason: string,
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({ current_handler: toHandler, updated_at: new Date().toISOString() })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] recordHandoff failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_handoff", {
        task_type: "issue_lifecycle",
        output_summary: `${fromHandler ?? "?"} → ${toHandler}: ${reason}`,
        from_handler: fromHandler,
        to_handler: toHandler,
        reason,
    });
}

export async function setBlocker(
    issueId: string,
    reason: IssueBlockerReason,
    nextAction: string,
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: "blocked",
            blocker_reason: reason,
            next_action: nextAction,
            autonomy_state: reason === "human_approval_required" || reason === "policy_required"
                ? "needs_policy"
                : "waiting",
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] setBlocker failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_blocked", {
        task_type: "issue_lifecycle",
        output_summary: `${reason}: ${nextAction}`,
        blocker_reason: reason,
        next_action: nextAction,
    });
}

export async function clearBlocker(
    issueId: string,
    resumeState: IssueLifecycleState = "working",
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: resumeState,
            blocker_reason: null,
            autonomy_state: "working",
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] clearBlocker failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_blocker_cleared", {
        task_type: "issue_lifecycle",
        output_summary: `resumed to ${resumeState}`,
    });
}

export async function complete(
    issueId: string,
    outputs: Record<string, unknown> = {},
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_issue")
        .update({
            lifecycle_state: "complete",
            autonomy_state: "resolved",
            completed_at: new Date().toISOString(),
            outputs,
            updated_at: new Date().toISOString(),
        })
        .eq("id", issueId);
    if (error) {
        console.warn("[agent-issue] complete failed:", error.message);
        return;
    }
    await appendIssueEvent(issueId, "issue_complete", {
        task_type: "issue_lifecycle",
        output_summary: typeof outputs.resolution === "string"
            ? outputs.resolution
            : "completed",
        ...outputs,
    });
}

export async function linkTask(taskId: string, issueId: string): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;
    const { error } = await supabase
        .from("agent_task")
        .update({ issue_id: issueId })
        .eq("id", taskId);
    if (error) {
        console.warn("[agent-issue] linkTask failed:", error.message);
    }
}
```

- [ ] **Step 4.4: Run, expect green**

```bash
npx vitest run src/lib/intelligence/agent-issue.test.ts
```

Expected: PASS, 7 tests total.

- [ ] **Step 4.5: Add `listIssues`, `getById`, `getBySource` reads**

Append to `src/lib/intelligence/agent-issue.ts`:

```ts
export type ListIssuesFilters = {
    lifecycleState?: IssueLifecycleState[];
    owner?: string;
    /** Window for terminal lifecycle states. Defaults 14 days. */
    terminalWindowMs?: number;
    limit?: number;
};

const DEFAULT_TERMINAL_WINDOW_MS = 14 * 24 * 3600 * 1000;
const OPEN_LIFECYCLE = ["detected","triaging","working","waiting_external","blocked"] as const;

export async function listIssues(filters: ListIssuesFilters = {}): Promise<AgentIssue[]> {
    const supabase = createClient();
    if (!supabase) return [];

    const limit = Math.min(filters.limit ?? 200, 500);
    const since = new Date(Date.now() - (filters.terminalWindowMs ?? DEFAULT_TERMINAL_WINDOW_MS)).toISOString();

    let query = supabase
        .from("agent_issue")
        .select("*")
        .order("priority", { ascending: true })
        .order("updated_at", { ascending: false });

    if (filters.lifecycleState?.length) {
        query = query.in("lifecycle_state", filters.lifecycleState);
    } else {
        // Default: open at any age + terminal in window.
        query = query.or(
            `lifecycle_state.in.(${OPEN_LIFECYCLE.join(",")}),and(lifecycle_state.eq.complete,completed_at.gte.${since})`,
        );
    }
    if (filters.owner) query = query.eq("owner", filters.owner);
    query = query.limit(limit);

    const { data, error } = await query;
    if (error) {
        console.warn("[agent-issue] listIssues failed:", error.message);
        return [];
    }
    return (data ?? []) as AgentIssue[];
}

export async function getById(id: string): Promise<AgentIssue | null> {
    const supabase = createClient();
    if (!supabase) return null;
    const { data, error } = await supabase.from("agent_issue").select("*").eq("id", id).maybeSingle();
    if (error) {
        console.warn("[agent-issue] getById failed:", error.message);
        return null;
    }
    return (data ?? null) as AgentIssue | null;
}

export async function getBySource(sourceTable: string, sourceId: string): Promise<AgentIssue | null> {
    const supabase = createClient();
    if (!supabase) return null;
    const { data, error } = await supabase
        .from("agent_issue")
        .select("*")
        .eq("source_table", sourceTable)
        .eq("source_id", sourceId)
        .maybeSingle();
    if (error) {
        console.warn("[agent-issue] getBySource failed:", error.message);
        return null;
    }
    return (data ?? null) as AgentIssue | null;
}
```

- [ ] **Step 4.6: Run all agent-issue tests**

```bash
npx vitest run src/lib/intelligence/agent-issue.test.ts
```

Expected: green.

- [ ] **Step 4.7: Commit**

```bash
git add src/lib/intelligence/agent-issue.ts src/lib/intelligence/agent-issue.test.ts
git commit -m "feat(issue-ledger): handoff/setBlocker/complete/linkTask + reads"
```

---

## Task 5: `issue-projection.ts` — pure grouping logic

**Files:**
- Create: `src/lib/intelligence/issue-projection.ts`
- Create: `src/lib/intelligence/issue-projection.test.ts`

- [ ] **Step 5.1: Test first**

```ts
import { describe, expect, it } from "vitest";
import { businessFlowKey, groupTasksByFlow, deriveIssueState } from "./issue-projection";
import type { AgentTask } from "./agent-task";

const baseTask: Partial<AgentTask> = {
    id: "t1",
    type: "approval",
    source_table: "ap_pending_approvals",
    source_id: "src-1",
    goal: "x",
    status: "PENDING",
    owner: "aria",
    priority: 2,
    inputs: {},
    outputs: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
};

describe("businessFlowKey", () => {
    it("uses vendor + invoice_number when both present", () => {
        const t = { ...baseTask, inputs: { vendor_name: "Colorado Worm Co.", invoice_number: "124618" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("colorado-worm-co.|inv:124618");
    });

    it("uses vendor + po_number when invoice missing", () => {
        const t = { ...baseTask, inputs: { vendor_name: "ULINE", po_number: "12345" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("uline|po:12345");
    });

    it("uses vendor + order_id when invoice + PO missing", () => {
        const t = { ...baseTask, inputs: { vendor_name: "FedEx", order_id: "ord-9" } } as AgentTask;
        expect(businessFlowKey(t)).toBe("fedex|ord:ord-9");
    });

    it("falls back to source_table:source_id when no vendor present", () => {
        const t = { ...baseTask, inputs: {} } as AgentTask;
        expect(businessFlowKey(t)).toBe("ap_pending_approvals:src-1");
    });

    it("returns null for manual tasks (no source, no vendor)", () => {
        const t = { ...baseTask, source_table: null, source_id: null, inputs: {} } as AgentTask;
        expect(businessFlowKey(t)).toBeNull();
    });
});

describe("groupTasksByFlow", () => {
    it("groups tasks with the same business_flow_key", () => {
        const tasks = [
            { ...baseTask, id: "t1", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
            { ...baseTask, id: "t2", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
            { ...baseTask, id: "t3", inputs: { vendor_name: "FedEx", invoice_number: "INV-2" } },
        ] as AgentTask[];
        const groups = groupTasksByFlow(tasks);
        expect(groups.size).toBe(2);
        expect(groups.get("uline|inv:INV-1")?.length).toBe(2);
        expect(groups.get("fedex|inv:INV-2")?.length).toBe(1);
    });

    it("skips tasks where businessFlowKey returns null", () => {
        const tasks = [
            { ...baseTask, id: "t1", source_table: null, source_id: null, inputs: {} },
            { ...baseTask, id: "t2", inputs: { vendor_name: "ULINE", invoice_number: "INV-1" } },
        ] as AgentTask[];
        const groups = groupTasksByFlow(tasks);
        expect(groups.size).toBe(1);
    });
});

describe("deriveIssueState", () => {
    it("returns working when at least one task is open", () => {
        const tasks = [
            { ...baseTask, status: "SUCCEEDED" },
            { ...baseTask, status: "PENDING" },
        ] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("working");
    });

    it("returns complete when all tasks terminal-success and recent", () => {
        const tasks = [
            { ...baseTask, status: "SUCCEEDED", completed_at: new Date().toISOString() },
        ] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("complete");
    });

    it("does NOT mark blocked just because the latest task is FAILED", () => {
        const tasks = [{ ...baseTask, status: "FAILED" }] as AgentTask[];
        const s = deriveIssueState(tasks);
        // Phase 1 projection never sets blocked — that's reserved for explicit
        // setBlocker() calls. Failed tasks are still 'working' / retrying.
        expect(s.lifecycle_state).toBe("working");
        expect(s.autonomy_state).toBe("retrying");
    });

    it("returns triaging when only one task and it's PENDING with no claim", () => {
        const tasks = [{ ...baseTask, status: "PENDING", claimed_at: null }] as AgentTask[];
        const s = deriveIssueState(tasks);
        expect(s.lifecycle_state).toBe("triaging");
    });
});
```

- [ ] **Step 5.2: Run failing**

```bash
npx vitest run src/lib/intelligence/issue-projection.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 5.3: Implement**

```ts
/**
 * @file    issue-projection.ts
 * @purpose Pure logic to group agent_task rows under business-flow keys
 *          and derive an issue's lifecycle/autonomy from its tasks.
 *
 *          The projection cron (issue-projection-cron.ts) wires these
 *          helpers to live data. These functions take and return plain
 *          values so they can be unit-tested without DB mocks.
 *
 *          Behavioral guardrail (Will, 2026-04-28): `blocked` is reserved
 *          for explicit setBlocker() calls — the projection never sets it
 *          based on FAILED task status alone. A failed task means
 *          `working` / autonomy_state = `retrying` until retry budget
 *          exhausts.
 */

import type { AgentTask } from "./agent-task";
import type { IssueLifecycleState, IssueAutonomyState } from "./agent-issue";

const OPEN_TASK_STATUSES = new Set(["PENDING","CLAIMED","RUNNING","NEEDS_APPROVAL"]);
const TERMINAL_SUCCESS = new Set(["SUCCEEDED","APPROVED"]);

function slugify(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.\-]/g, "");
}

/**
 * Compute the business-flow key for a task. Returns null when the task is
 * not groupable (no source, no vendor) — the caller should drop it.
 */
export function businessFlowKey(task: AgentTask): string | null {
    const inputs = task.inputs as Record<string, unknown>;
    const vendor = typeof inputs?.vendor_name === "string" ? slugify(inputs.vendor_name as string) : null;
    const invoice = typeof inputs?.invoice_number === "string" ? inputs.invoice_number : null;
    const po = typeof inputs?.po_number === "string" ? inputs.po_number : null;
    const orderId = typeof inputs?.order_id === "string" ? inputs.order_id : null;

    if (vendor && invoice) return `${vendor}|inv:${invoice}`;
    if (vendor && po) return `${vendor}|po:${po}`;
    if (vendor && orderId) return `${vendor}|ord:${orderId}`;

    if (task.source_table && task.source_id) {
        return `${task.source_table}:${task.source_id}`;
    }
    return null;
}

export function groupTasksByFlow(tasks: AgentTask[]): Map<string, AgentTask[]> {
    const groups = new Map<string, AgentTask[]>();
    for (const t of tasks) {
        const key = businessFlowKey(t);
        if (!key) continue;
        const arr = groups.get(key) ?? [];
        arr.push(t);
        groups.set(key, arr);
    }
    return groups;
}

export type DerivedIssueState = {
    lifecycle_state: IssueLifecycleState;
    autonomy_state: IssueAutonomyState;
    /** Title pulled from the most recent task's goal. */
    title: string;
    /** Most recent task's owner (used as fallback issue owner). */
    owner: string;
    /** Aggregate of input fields useful for the issue card. */
    digest: Record<string, unknown>;
};

export function deriveIssueState(tasks: AgentTask[]): DerivedIssueState {
    if (tasks.length === 0) {
        return { lifecycle_state: "detected", autonomy_state: "working", title: "", owner: "aria", digest: {} };
    }
    const sorted = [...tasks].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const latest = sorted[0];

    const hasOpen = tasks.some(t => OPEN_TASK_STATUSES.has(t.status));
    const allTerminalSuccess = tasks.every(t => TERMINAL_SUCCESS.has(t.status));
    const anyFailed = tasks.some(t => t.status === "FAILED");

    let lifecycle_state: IssueLifecycleState = "working";
    let autonomy_state: IssueAutonomyState = "working";

    if (allTerminalSuccess) {
        lifecycle_state = "complete";
        autonomy_state = "resolved";
    } else if (hasOpen) {
        // Only-one-task-and-just-PENDING means we're still figuring out who picks it up.
        if (tasks.length === 1 && latest.status === "PENDING" && !latest.claimed_at) {
            lifecycle_state = "triaging";
            autonomy_state = "waiting";
        } else if (anyFailed) {
            // Failed task in mix → retrying, NOT blocked.
            lifecycle_state = "working";
            autonomy_state = "retrying";
        } else {
            lifecycle_state = "working";
            autonomy_state = "working";
        }
    } else if (anyFailed) {
        // All tasks terminal but at least one failed and none succeeded → retrying.
        // Phase 1 still does NOT set blocked here; explicit setBlocker is the only path.
        lifecycle_state = "working";
        autonomy_state = "retrying";
    }

    return {
        lifecycle_state,
        autonomy_state,
        title: latest.goal,
        owner: latest.owner ?? "aria",
        digest: {
            task_count: tasks.length,
            statuses: Array.from(new Set(tasks.map(t => t.status))),
            latest_task_id: latest.id,
            latest_status: latest.status,
        },
    };
}
```

- [ ] **Step 5.4: Run, expect green**

```bash
npx vitest run src/lib/intelligence/issue-projection.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5.5: Commit**

```bash
git add src/lib/intelligence/issue-projection.ts src/lib/intelligence/issue-projection.test.ts
git commit -m "feat(issue-ledger): pure projection logic — businessFlowKey + groupTasksByFlow + deriveIssueState"
```

---

## Task 6: Projection cron — wire to live data

**Files:**
- Create: `src/lib/intelligence/issue-projection-cron.ts`
- Modify: `src/lib/scheduler/cron-registry.ts`
- Modify: `src/lib/scheduler/cron-registry.test.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`

- [ ] **Step 6.1: Implement the cron body**

`src/lib/intelligence/issue-projection-cron.ts`:

```ts
/**
 * @file    issue-projection-cron.ts
 * @purpose Phase 1 projection: scan recent agent_task rows, group by
 *          business-flow key, ensure an agent_issue row exists for each
 *          group, and link the tasks back via agent_task.issue_id.
 *
 *          Runs every 5 min from OpsManager. Best-effort — a failure
 *          here never blocks the spoke writers.
 */

import { createClient } from "@/lib/supabase";
import { listTasks, type AgentTask } from "./agent-task";
import { createOrAdvance, linkTask } from "./agent-issue";
import { groupTasksByFlow, deriveIssueState } from "./issue-projection";

const TERMINAL_WINDOW_MS = 14 * 24 * 3600 * 1000;

export type ProjectionSummary = {
    candidate_tasks: number;
    groups: number;
    issues_created_or_advanced: number;
    tasks_linked: number;
    skipped_no_key: number;
};

export async function runIssueProjection(): Promise<ProjectionSummary> {
    const summary: ProjectionSummary = {
        candidate_tasks: 0,
        groups: 0,
        issues_created_or_advanced: 0,
        tasks_linked: 0,
        skipped_no_key: 0,
    };

    const supabase = createClient();
    if (!supabase) return summary;

    // Pull all open tasks (any age) + recent terminal tasks (last 14 days).
    const open = await listTasks({ limit: 500, includeRecentFailed: true });
    const since = new Date(Date.now() - TERMINAL_WINDOW_MS).toISOString();
    const { data: closed } = await supabase
        .from("agent_task")
        .select("*")
        .in("status", ["SUCCEEDED","APPROVED","CANCELLED","REJECTED","FAILED","EXPIRED"])
        .gte("completed_at", since)
        .limit(500);
    const candidates: AgentTask[] = [...open, ...((closed ?? []) as AgentTask[])];
    summary.candidate_tasks = candidates.length;

    const groups = groupTasksByFlow(candidates);
    summary.groups = groups.size;
    summary.skipped_no_key = candidates.length - Array.from(groups.values()).reduce((n, arr) => n + arr.length, 0);

    for (const [key, tasks] of groups) {
        const derived = deriveIssueState(tasks);
        const first = tasks[0];
        try {
            const issue = await createOrAdvance({
                businessFlowKey: key,
                title: derived.title,
                sourceTable: first.source_table ?? null,
                sourceId: first.source_id ?? null,
                lifecycleState: derived.lifecycle_state,
                autonomyState: derived.autonomy_state,
                owner: derived.owner,
                inputs: derived.digest,
            });
            if (issue) {
                summary.issues_created_or_advanced += 1;
                for (const t of tasks) {
                    if (!t.issue_id || t.issue_id !== issue.id) {
                        await linkTask(t.id, issue.id);
                        summary.tasks_linked += 1;
                    }
                }
            }
        } catch (err) {
            console.warn(`[issue-projection] group ${key} failed:`, err instanceof Error ? err.message : err);
        }
    }

    return summary;
}
```

- [ ] **Step 6.2: Cron registry entry**

In `src/lib/scheduler/cron-registry.ts`, append:

```ts
{
    name: 'IssueProjection',
    description: 'Phase 1 issue ledger: groups recent tasks by business-flow key into agent_issue rows',
    schedule: '*/5 * * * *',
    scheduleHuman: 'Every 5 minutes',
    category: 'maintenance',
    weekdaysOnly: false,
},
```

- [ ] **Step 6.3: Sync test bump**

In `src/lib/scheduler/cron-registry.test.ts`:

```ts
it('contains the full current runtime schedule', () => {
    expect(CRON_JOBS.length).toBe(21);  // bumped from 20
});
```

And add `'IssueProjection'` to the expectedTasks array.

- [ ] **Step 6.4: OpsManager wiring**

In `src/lib/intelligence/ops-manager.ts`, near the other self-heal jobs:

```ts
schedule("*/5 * * * *", () => {
    this.safeRun("IssueProjection", async () => {
        const { runIssueProjection } = await import("./issue-projection-cron");
        const summary = await runIssueProjection();
        if (summary.issues_created_or_advanced > 0 || summary.tasks_linked > 0) {
            console.log("[OpsManager] IssueProjection:", summary);
        }
    });
});
```

- [ ] **Step 6.5: Run sync test, expect PASS**

```bash
npx vitest run src/lib/scheduler/cron-registry.test.ts
```

- [ ] **Step 6.6: Commit**

```bash
git add src/lib/intelligence/issue-projection-cron.ts src/lib/scheduler/cron-registry.ts src/lib/scheduler/cron-registry.test.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(issue-ledger): IssueProjection cron — every 5 min derives issues from tasks"
```

---

## Task 7: Command-board service — issue projection for API

**Files:**
- Modify: `src/lib/command-board/types.ts`
- Modify: `src/lib/command-board/service.ts`

- [ ] **Step 7.1: Add types**

In `src/lib/command-board/types.ts`:

```ts
export type CommandBoardIssue = {
    id: string;
    title: string;
    lifecycle_state: "detected" | "triaging" | "working" | "waiting_external" | "blocked" | "complete";
    autonomy_state: "working" | "waiting" | "retrying" | "resolved" | "needs_policy" | null;
    current_handler: string | null;
    blocker_reason: string | null;
    next_action: string | null;
    owner: string;
    priority: number;
    source_table: string | null;
    source_id: string | null;
    business_flow_key: string;
    age_seconds: number;
    completed_at: string | null;
    /** Number of agent_task rows linked to this issue. */
    task_count: number;
};

export type CommandBoardIssueDetail = CommandBoardIssue & {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    /** All linked agent_task rows projected as cards (existing CommandBoardTaskCard shape). */
    tasks: CommandBoardTaskCard[];
    /** Lifecycle events from task_history scoped to this issue. */
    timeline: CommandBoardTaskEvent[];
};

export type CommandBoardIssueFilters = {
    lifecycleState?: ("detected" | "triaging" | "working" | "waiting_external" | "blocked" | "complete")[];
    owner?: string;
    limit?: number;
};
```

- [ ] **Step 7.2: Add service helpers**

In `src/lib/command-board/service.ts` (append after the existing task helpers).

The file already exports a private `ageSeconds()` (line 68) and a private
`toCard()` (line 84) for AgentTask → CommandBoardTaskCard projection.
**Reuse both** — do not redeclare. Add only the new imports + issue helpers:

```ts
import { listIssues, getById as getIssueById, type AgentIssue } from "@/lib/intelligence/agent-issue";
import type {
    CommandBoardIssue,
    CommandBoardIssueDetail,
    CommandBoardIssueFilters,
} from "./types";

// `ageSeconds` and `toCard` are already declared above in this file —
// reuse them directly. Do not redeclare or rename.

function issueRowToCard(row: AgentIssue, taskCount: number): CommandBoardIssue {
    return {
        id: row.id,
        title: row.title,
        lifecycle_state: row.lifecycle_state,
        autonomy_state: row.autonomy_state,
        current_handler: row.current_handler,
        blocker_reason: row.blocker_reason,
        next_action: row.next_action,
        owner: row.owner,
        priority: row.priority,
        source_table: row.source_table,
        source_id: row.source_id,
        business_flow_key: row.business_flow_key,
        age_seconds: ageSeconds(row.created_at),
        completed_at: row.completed_at,
        task_count: taskCount,
    };
}

export async function getCommandBoardIssues(
    filters: CommandBoardIssueFilters = {},
): Promise<{ issues: CommandBoardIssue[]; total: number }> {
    const supabase = createClient();
    if (!supabase) return { issues: [], total: 0 };

    const rows = await listIssues({
        lifecycleState: filters.lifecycleState,
        owner: filters.owner,
        limit: filters.limit ?? 200,
    });

    if (rows.length === 0) return { issues: [], total: 0 };

    // Get task counts per issue in one batched query.
    const ids = rows.map(r => r.id);
    const { data: counts } = await supabase
        .from("agent_task")
        .select("issue_id")
        .in("issue_id", ids);
    const countByIssue = new Map<string, number>();
    for (const r of counts ?? []) {
        const id = (r as { issue_id: string }).issue_id;
        countByIssue.set(id, (countByIssue.get(id) ?? 0) + 1);
    }

    const issues = rows.map(r => issueRowToCard(r, countByIssue.get(r.id) ?? 0));
    return { issues, total: issues.length };
}

export async function getCommandBoardIssueDetail(id: string): Promise<CommandBoardIssueDetail | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const row = await getIssueById(id);
    if (!row) return null;

    const { data: linkedTasks } = await supabase
        .from("agent_task")
        .select("*")
        .eq("issue_id", id)
        .order("created_at", { ascending: false });

    const linkedTaskRows = (linkedTasks ?? []) as AgentTask[];
    const tasks = linkedTaskRows.map(t => toCard(t, false));

    // Timeline includes both issue-scoped events AND task-scoped events for
    // the linked tasks. Task events are how the user sees what each step
    // tried; issue events show the lifecycle envelope around them.
    const linkedTaskIds = linkedTaskRows.map(t => t.id);
    const { data: issueEvents } = await supabase
        .from("task_history")
        .select("event_type, created_at, execution_trace")
        .eq("issue_id", id)
        .order("created_at", { ascending: false })
        .limit(100);

    let taskEvents: any[] = [];
    if (linkedTaskIds.length > 0) {
        const { data } = await supabase
            .from("task_history")
            .select("event_type, created_at, execution_trace")
            .in("task_id", linkedTaskIds)
            .order("created_at", { ascending: false })
            .limit(200);
        taskEvents = data ?? [];
    }

    // Interleave by created_at desc.
    const timelineRows = [...(issueEvents ?? []), ...taskEvents].sort(
        (a, b) => new Date((b as any).created_at).getTime() - new Date((a as any).created_at).getTime(),
    ).slice(0, 100);

    const timeline = (timelineRows ?? []).map(r => ({
        event_type: (r as { event_type: string }).event_type,
        created_at: (r as { created_at: string }).created_at,
        payload: (r as { execution_trace: Record<string, unknown> }).execution_trace ?? {},
    }));

    const card = issueRowToCard(row, tasks.length);
    return {
        ...card,
        inputs: row.inputs,
        outputs: row.outputs,
        tasks,
        timeline,
    };
}
```

- [ ] **Step 7.3: Run typecheck**

```bash
npm run typecheck:cli
```

Expected: 0 errors.

- [ ] **Step 7.4: Add timeline test**

`src/lib/command-board/service.test.ts` — append:

```ts
it("getCommandBoardIssueDetail interleaves issue events with linked-task events", async () => {
    // Mock chain: getById returns an issue, linked tasks query returns 1 task,
    // task_history returns issue events + task events, sorted desc by created_at.
    const issueRow = {
        id: "i1",
        title: "Test issue",
        business_flow_key: "k",
        lifecycle_state: "working",
        owner: "aria",
        priority: 2,
        created_at: "2026-04-28T10:00:00Z",
        updated_at: "2026-04-28T10:05:00Z",
        completed_at: null,
        inputs: {},
        outputs: {},
    };
    // Wire the supabase mock to return issueRow on the first maybeSingle (getById),
    // [task1] on the linkedTasks select, and event rows on the two task_history
    // queries. Implementation detail in the test file matches the chain shape.

    // The detail.timeline must include both issue events and task events in
    // descending chronological order.
    // (See full mock wiring in surrounding tests.)
});
```

(This test reuses the existing service.test.ts mock harness; copy the
 setup pattern from the closest existing test that mocks supabase chains.)

- [ ] **Step 7.5: Commit**

```bash
git add src/lib/command-board/types.ts src/lib/command-board/service.ts src/lib/command-board/service.test.ts
git commit -m "feat(issue-ledger): command-board service — getCommandBoardIssues + detail with merged timeline"
```

---

## Task 8: API routes

**Files:**
- Create: `src/app/api/command-board/issues/route.ts`
- Create: `src/app/api/command-board/issues/[id]/route.ts`

- [ ] **Step 8.1: List + create route**

`src/app/api/command-board/issues/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
    getCommandBoardIssues,
} from "@/lib/command-board/service";
import { createOrAdvance } from "@/lib/intelligence/agent-issue";
import { randomUUID } from "node:crypto";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams;
    const stateFilter = sp.get("lifecycleState");
    const states = stateFilter
        ? stateFilter.split(",").map(s => s.trim()).filter(Boolean) as any
        : undefined;
    const owner = sp.get("owner") ?? undefined;
    const limit = Math.min(parseInt(sp.get("limit") ?? "200", 10) || 200, 500);

    try {
        const result = await getCommandBoardIssues({ lifecycleState: states, owner, limit });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}

export async function POST(req: NextRequest) {
    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400, headers: NO_STORE });
    }
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) {
        return NextResponse.json({ error: "title required" }, { status: 400, headers: NO_STORE });
    }
    const owner = typeof body?.owner === "string" ? body.owner : "aria";
    const priority = Number.isFinite(body?.priority) ? Math.max(0, Math.min(9, body.priority)) : 2;
    const businessFlowKey = `manual:${randomUUID()}`;

    try {
        const issue = await createOrAdvance({
            businessFlowKey,
            title,
            sourceTable: null,
            sourceId: null,
            lifecycleState: "triaging",
            autonomyState: "working",
            owner,
            priority,
            inputs: {
                created_by: typeof body?.created_by === "string" ? body.created_by : "will-dashboard",
                manual: true,
                ...(body?.notes ? { notes: body.notes } : {}),
            },
        });
        // createOrAdvance returns null when the hub is disabled or Supabase is
        // unavailable. Manual creation is a user-facing action — surface a
        // 503 instead of silently returning {issue: null}.
        if (!issue) {
            return NextResponse.json(
                { error: "issue creation unavailable (hub disabled or Supabase down)" },
                { status: 503, headers: NO_STORE },
            );
        }
        return NextResponse.json({ issue }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues] POST error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}
```

- [ ] **Step 8.2: Detail route**

`src/app/api/command-board/issues/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardIssueDetail } from "@/lib/command-board/service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const detail = await getCommandBoardIssueDetail(params.id);
        if (!detail) {
            return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
        }
        return NextResponse.json(detail, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues:id] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}
```

- [ ] **Step 8.3: Smoke against running dev server**

```bash
# In another terminal: npm run dev
curl -s 'http://localhost:3001/api/command-board/issues?limit=5' | head -c 500
```

Expected: `{"issues":[...],"total":N}`. Empty array is fine on a freshly-projected DB.

```bash
# Manual issue creation
curl -s -X POST 'http://localhost:3001/api/command-board/issues' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Investigate Q1 inventory variance","owner":"aria","priority":1}'
```

Expected: `{"issue":{"id":"...","title":"Investigate ..."}}`.

- [ ] **Step 8.4: Test — POST returns 503 when createOrAdvance returns null**

Create `src/app/api/command-board/issues/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/intelligence/agent-issue", () => ({
    createOrAdvance: vi.fn(),
}));

import * as agentIssue from "@/lib/intelligence/agent-issue";
import { POST } from "./route";

describe("POST /api/command-board/issues", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns 503 with no-store header when createOrAdvance returns null", async () => {
        vi.mocked(agentIssue.createOrAdvance).mockResolvedValueOnce(null);
        const req = new Request("http://localhost/api/command-board/issues", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x" }),
        });
        const res = await POST(req as never);
        expect(res.status).toBe(503);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 400 + no-store on missing title", async () => {
        const req = new Request("http://localhost/api/command-board/issues", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const res = await POST(req as never);
        expect(res.status).toBe(400);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 200 with the issue when create succeeds", async () => {
        vi.mocked(agentIssue.createOrAdvance).mockResolvedValueOnce({
            id: "new-id", title: "x", lifecycle_state: "triaging",
        } as never);
        const req = new Request("http://localhost/api/command-board/issues", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x" }),
        });
        const res = await POST(req as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.issue.id).toBe("new-id");
    });
});
```

Run:

```bash
npx vitest run src/app/api/command-board/issues/route.test.ts
```

Expected: 3 passing.

- [ ] **Step 8.5: Smoke against running dev server**

(Same curls as before — list + create round-trip.)

- [ ] **Step 8.6: Commit**

```bash
git add src/app/api/command-board/issues/
git commit -m "feat(issue-ledger): GET issues list + detail, POST manual create with 503 on hub-down"
```

---

## Task 9: Telegram `/issues` + `/tasks` alias

**Files:**
- Modify: `src/cli/start-bot.ts`

- [ ] **Step 9.1: Locate the existing `/tasks` handler**

```bash
grep -n "bot.command.*tasks\|/tasks" src/cli/start-bot.ts | head -10
```

Find the line registering `bot.command('tasks', …)`.

- [ ] **Step 9.2: Extract the rendering into a shared helper**

Identify the function body that today fetches `/api/dashboard/tasks` and renders the list. Extract it into a local helper `renderIssueOrTaskList(ctx, kind: 'issues' | 'tasks')`.

Concrete: the existing handler should become:

```ts
async function renderIssueList(ctx: any) {
    const base = process.env.DASHBOARD_BASE_URL ?? "http://localhost:3001";
    const res = await fetch(`${base}/api/command-board/issues?limit=10`);
    if (!res.ok) {
        await ctx.reply(`⚠️ Could not fetch issues (HTTP ${res.status})`);
        return;
    }
    const { issues } = await res.json();
    if (!issues || issues.length === 0) {
        await ctx.reply("✅ No open issues.");
        return;
    }
    const lines = issues.slice(0, 10).map((i: any) =>
        `• [${i.lifecycle_state}] ${i.title}${i.next_action ? `\n   → ${i.next_action}` : ""}`
    );
    await ctx.reply(`*Open issues* (${issues.length})\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
}

bot.command("issues", renderIssueList);
bot.command("tasks", renderIssueList);  // Alias kept for muscle memory.
```

Replace whatever the existing `tasks` handler currently does with the alias. Keep the function name `renderIssueList` so future readers don't expect task-shape data.

- [ ] **Step 9.3: Restart bot**

```bash
pm2 restart aria-bot --update-env
```

Then in Telegram, send `/issues`. Expected: list of open issues, or "No open issues."

- [ ] **Step 9.4: Send `/tasks` — should produce the same output as `/issues`**

Both must hit the same `renderIssueList` handler. Verify by:

1. Adding a synthetic issue via the manual POST route.
2. Sending `/issues` and noting the message text.
3. Sending `/tasks` and confirming byte-for-byte identical message text.

If outputs diverge, the alias is broken — revisit the bot wiring.

- [ ] **Step 9.5: Commit**

```bash
git add src/cli/start-bot.ts
git commit -m "feat(issue-ledger): /issues Telegram command + /tasks alias"
```

---

## Task 10: Backfill verification + smoke

- [ ] **Step 10.1: Wait for first projection cron tick (or trigger manually)**

```bash
node --import tsx --env-file=.env.local -e "
import('./src/lib/intelligence/issue-projection-cron.ts').then(async m => {
    const summary = await m.runIssueProjection();
    console.log(JSON.stringify(summary, null, 2));
});
"
```

Expected: a summary like
```json
{
  "candidate_tasks": 30,
  "groups": 12,
  "issues_created_or_advanced": 12,
  "tasks_linked": 30,
  "skipped_no_key": 0
}
```

- [ ] **Step 10.2: Confirm in DB**

```bash
node -e "require('dotenv').config({path:'.env.local'}); const{Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"SELECT lifecycle_state, COUNT(*) FROM agent_issue GROUP BY lifecycle_state\")).then(r=>{console.log(r.rows); return c.end()})"
```

Expected: counts per lifecycle state. Most should be `working` or `triaging`. **No `blocked` rows from projection alone** — that's the behavioral guardrail.

- [ ] **Step 10.3: Confirm tasks linked**

```bash
node -e "require('dotenv').config({path:'.env.local'}); const{Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"SELECT COUNT(*) FILTER (WHERE issue_id IS NOT NULL) AS linked, COUNT(*) AS total FROM agent_task\")).then(r=>{console.log(r.rows); return c.end()})"
```

Expected: `linked / total` ratio matches the `tasks_linked / candidate_tasks` from Step 10.1.

- [ ] **Step 10.4: Hit the API**

```bash
curl -s 'http://localhost:3001/api/command-board/issues?limit=3' | head -c 800
```

Confirm shape matches `CommandBoardIssue[]`.

- [ ] **Step 10.5: Manual issue smoke**

```bash
curl -s -X POST 'http://localhost:3001/api/command-board/issues' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Smoke test — delete me","priority":3,"created_by":"smoke"}'
```

Then verify it shows up in `/issues` Telegram and the API list. Then delete via SQL:

```bash
node -e "require('dotenv').config({path:'.env.local'}); const{Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"DELETE FROM agent_issue WHERE title = 'Smoke test — delete me'\")).then(()=>c.end())"
```

- [ ] **Step 10.6: Final tests + typecheck**

```bash
npx vitest run
npm run typecheck:cli
```

Expected: 1 pre-existing test-single-po-calendar failure (still). All else green. Typecheck clean.

---

## Definition of Done

- `agent_issue` table exists; `agent_task.issue_id` exists.
- `agent-issue.ts` lib exposes `createOrAdvance`, `recordHandoff`, `setBlocker`, `clearBlocker`, `complete`, `linkTask`, `listIssues`, `getById`, `getBySource`. All hub-write paths swallow errors and best-effort `appendEvent`.
- Projection cron runs every 5 min, derives issues from tasks, links tasks back. `IssueProjection` registered + sync test green.
- API: `GET /api/command-board/issues`, `GET /api/command-board/issues/:id`, `POST /api/command-board/issues` (manual creation with `source_table = NULL`).
- Telegram `/issues` works; `/tasks` is now an alias rendering issues.
- The projection NEVER sets `lifecycle_state = blocked` — that requires explicit `setBlocker()`.
- Backfill grouped: open issues at any age + terminal in last 14 days.
- Spec coverage:
  - Question 1 (granularity): business-flow key includes vendor + invoice/po/order. ✅ Task 5.
  - Question 2 (blocker enum): all 13 values in DB CHECK + TS type. ✅ Tasks 1, 2.
  - Question 3 (manual issues): POST route + `source_table=null`. ✅ Task 8.
  - Question 4 (Telegram): `/issues` primary + `/tasks` alias. ✅ Task 9.
  - Question 5 (backfill window): open + 14d closed. ✅ Tasks 4, 6.
  - Behavioral correction (`blocked` reserved): explicit guardrail in `deriveIssueState`. ✅ Task 5.

## Out of Scope (Phase 2)

- Spoke-writer rewires (AP-agent, reconciler, dropship-store) to create issues directly instead of just tasks.
- Dashboard UI cutover (issue lanes replacing task lanes — they keep coexisting in Phase 1).
- `mergeIssues(targetId, sourceId)` for linking issues that the projection split into separate rows.
- Issue-level playbooks (Layer C currently dispatches against tasks, not issues — Phase 2 will extend).
- `recurring_pattern` mining from issue history.
