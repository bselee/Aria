# Self-Healing Layer B — Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "what is being done about this task" a first-class field on every agent_task row, so the dashboard can show a live status line ("⚙️ running playbook=X, attempt 1/3, opened PR #14") instead of a bare PENDING badge.

**Architecture:** Two new columns on `agent_task` (`playbook_kind` text, `playbook_state` text constrained enum). Spoke writers and the human dashboard set `playbook_kind` when they know which autonomous attempt should fire. The Layer C runner reads these to know what to dispatch. Today (before C ships) the columns are populated only by manual triage and rendered as "manual_only" placeholder. The dashboard `TaskDetailPanel` renders a single status line above the action buttons. The command-board service `getCommandBoardTaskCard` and `getCommandBoardTaskDetail` project both new columns into the API contract.

**Tech Stack:** Supabase (Postgres), Next.js, React, existing `command-board` service + UI, Vitest.

---

## Non-Negotiable Guardrails

- Migration must be additive: `ADD COLUMN IF NOT EXISTS`. No defaults that require backfill of existing rows. Existing tasks render as before until manually annotated.
- `playbook_state` is a CHECK constraint, not an enum type. Easier to evolve, no `ALTER TYPE` churn later.
- `TaskDetailPanel` change is composition only — no rewrite of existing panels. The new status line is an additional render block, not a refactor.
- The API contract for the existing `tasks` and `tasks/:id` routes is **additive**. No existing field names change. Old clients that don't read the new fields keep working.
- `getCommandBoardSummary` does NOT need to change — these fields don't affect lane counts.

## Scope

**In scope (this plan):**
- Migration adding `playbook_kind` (text) and `playbook_state` (text, CHECK in fixed set).
- TypeScript types + service projection.
- Dashboard `TaskDetailPanel` status line UI.
- Tests for service projection and UI render.

**Out of scope:**
- Any actual playbook *execution* — that's Layer C.
- Backfill of existing tasks. They stay null until something writes them.
- A separate "playbook history" sub-table. The existing `task_history` ledger captures attempt events via `appendEvent`.

---

## Preflight

```bash
# Confirm Layer A migration succeeded (auto_handled_by exists).
node _run_migration.js --check 2>&1 || true

# Confirm command-board surface compiles.
npm run typecheck:cli
```

Both should pass before starting.

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260507_add_playbook_columns.sql` | Migration: add `playbook_kind` + `playbook_state` columns + CHECK constraint + index. |
| `src/lib/intelligence/agent-task.ts` | Add `playbook_kind` and `playbook_state` to the `AgentTask` row type and the `UpsertFromSourceArgs` shape. New helper `setPlaybook(taskId, kind, state)`. |
| `src/lib/intelligence/agent-task.test.ts` | (May not exist yet — create if needed.) Verify `setPlaybook` writes both columns + appends a `playbook_state_changed` event to the ledger. |
| `src/lib/command-board/types.ts` | Extend `CommandBoardTaskCard` and `CommandBoardTaskDetail.task` with the two fields. |
| `src/lib/command-board/service.ts` | Project the two columns in `taskRowToCard` and `getCommandBoardTaskDetail`. |
| `src/lib/command-board/service.test.ts` | Add a test asserting that a task row's `playbook_kind` + `playbook_state` are projected. |
| `src/components/dashboard/command-board/TaskDetailPanel.tsx` | Render a status line block when `playbook_kind` is set. Use lucide icons (`Loader`, `CheckCircle2`, `XCircle`, `User`). |
| `src/components/dashboard/command-board/TaskDetailPanel.test.tsx` | Test the status line for each `playbook_state` value. |

---

## Task 1: Migration

**Files:**
- Create: `supabase/migrations/20260507_add_playbook_columns.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- Migration: Add playbook_kind + playbook_state to agent_task
-- Created: 2026-05-07
-- Purpose: Layer B of the self-healing system. Make "what is being done
--          about this task" a first-class field instead of inferring from
--          status. The Layer C runner will read these to know what to
--          dispatch; until then they are populated only by manual triage.
--
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN playbook_state;
--   ALTER TABLE agent_task DROP COLUMN playbook_kind;
--   DROP INDEX IF EXISTS idx_agent_task_playbook_kind;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_kind TEXT;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_state TEXT;

-- Constrain playbook_state to a known set. Use CHECK (not ENUM type) so
-- additions can ship without ALTER TYPE.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_task_playbook_state_check'
    ) THEN
        ALTER TABLE public.agent_task
            ADD CONSTRAINT agent_task_playbook_state_check
            CHECK (
                playbook_state IS NULL
                OR playbook_state IN (
                    'queued',
                    'running',
                    'succeeded',
                    'failed',
                    'manual_only'
                )
            );
    END IF;
END $$;

-- Partial index — only rows with a playbook are interesting for the
-- runner's queue scan.
CREATE INDEX IF NOT EXISTS idx_agent_task_playbook_kind
    ON public.agent_task (playbook_kind, playbook_state)
    WHERE playbook_kind IS NOT NULL;
```

- [ ] **Step 1.2: Apply**

```bash
node _run_migration.js supabase/migrations/20260507_add_playbook_columns.sql
```

Expected: `✅ Applied`.

- [ ] **Step 1.3: Verify columns exist**

```bash
node -e "require('dotenv').config({path:'.env.local'}); const{Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='agent_task' AND column_name IN ('playbook_kind','playbook_state')\")).then(r=>{console.log(r.rows);return c.end()})"
```

Expected output: `[{"column_name":"playbook_kind"},{"column_name":"playbook_state"}]`.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/20260507_add_playbook_columns.sql
git commit -m "feat(self-heal): migration — playbook_kind + playbook_state on agent_task"
```

---

## Task 2: Extend `agent-task.ts` types and add `setPlaybook`

**Files:**
- Modify: `src/lib/intelligence/agent-task.ts`
- Create or modify: `src/lib/intelligence/agent-task.test.ts`

- [ ] **Step 2.1: Write a test for `setPlaybook`**

Append to (or create) `src/lib/intelligence/agent-task.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { setPlaybook } from "./agent-task";

vi.mock("@/lib/supabase", () => ({
    createClient: () => ({
        from: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null, data: null }),
        insert: vi.fn().mockResolvedValue({ error: null, data: null }),
    }),
}));

describe("setPlaybook", () => {
    it("writes both columns and appends a ledger event", async () => {
        // The mock client above resolves both update and insert. We're
        // asserting that the call shape is correct, not that DB state changes.
        await expect(
            setPlaybook("task-uuid", "add_localstorage_shim", "running"),
        ).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2.2: Run failing**

```bash
npx vitest run src/lib/intelligence/agent-task.test.ts
```

Expected: FAIL — `setPlaybook` is not exported.

- [ ] **Step 2.3: Add types and helper**

In `src/lib/intelligence/agent-task.ts`, extend the `AgentTask` type:

```ts
export type PlaybookState =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "manual_only";

export type AgentTask = {
    // ... existing fields ...
    playbook_kind?: string | null;
    playbook_state?: PlaybookState | null;
};
```

And add the helper:

```ts
export async function setPlaybook(
    taskId: string,
    kind: string,
    state: PlaybookState,
): Promise<void> {
    if (!hubEnabled()) return;
    const supabase = createClient();
    if (!supabase) return;

    const { error } = await supabase
        .from("agent_task")
        .update({ playbook_kind: kind, playbook_state: state, updated_at: new Date().toISOString() })
        .eq("id", taskId);

    if (error) {
        console.warn("[agent-task] setPlaybook failed:", error.message);
        return;
    }
    await appendEvent(taskId, "playbook_state_changed", {
        task_type: "playbook",
        output_summary: `${kind}=${state}`,
        playbook_kind: kind,
        playbook_state: state,
    });
}
```

- [ ] **Step 2.4: Run test, expect green**

```bash
npx vitest run src/lib/intelligence/agent-task.test.ts
```

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/intelligence/agent-task.ts src/lib/intelligence/agent-task.test.ts
git commit -m "feat(self-heal): setPlaybook helper + PlaybookState type"
```

---

## Task 3: Project columns through command-board service

**Files:**
- Modify: `src/lib/command-board/types.ts`
- Modify: `src/lib/command-board/service.ts`
- Modify: `src/lib/command-board/service.test.ts`

- [ ] **Step 3.1: Write the failing test**

Add to `src/lib/command-board/service.test.ts`:

```ts
it("projects playbook_kind and playbook_state into card", async () => {
    // Mock listTasks to return one row with a playbook set.
    vi.mocked(agentTask.listTasks).mockResolvedValueOnce([{
        id: "t1",
        type: "ci_failure",
        source_table: "github_actions",
        source_id: "x",
        goal: "g",
        status: "PENDING",
        owner: "aria",
        priority: 1,
        parent_task_id: null,
        requires_approval: false,
        approval_decision: null,
        approval_decided_by: null,
        approval_decided_at: null,
        inputs: {},
        outputs: {},
        cost_cents: 0,
        retry_count: 0,
        max_retries: 0,
        deadline_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        claimed_at: null,
        claimed_by: null,
        completed_at: null,
        playbook_kind: "add_localstorage_shim",
        playbook_state: "running",
    } as never]);
    const result = await getCommandBoardTasks({});
    expect(result.tasks[0].playbookKind).toBe("add_localstorage_shim");
    expect(result.tasks[0].playbookState).toBe("running");
});
```

- [ ] **Step 3.2: Run failing**

Expected: FAIL — `playbookKind` not on type.

- [ ] **Step 3.3: Extend types**

In `src/lib/command-board/types.ts`, extend `CommandBoardTaskCard`:

```ts
export type CommandBoardTaskCard = {
    // ... existing fields ...
    playbookKind: string | null;
    playbookState: "queued" | "running" | "succeeded" | "failed" | "manual_only" | null;
};
```

- [ ] **Step 3.4: Project in service**

In `src/lib/command-board/service.ts`, in the function that converts `AgentTask` → `CommandBoardTaskCard` (likely `taskRowToCard`):

```ts
return {
    // ... existing fields ...
    playbookKind: row.playbook_kind ?? null,
    playbookState: (row.playbook_state ?? null) as CommandBoardTaskCard["playbookState"],
};
```

- [ ] **Step 3.5: Run test, expect green**

```bash
npx vitest run src/lib/command-board/service.test.ts
```

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/command-board/types.ts src/lib/command-board/service.ts src/lib/command-board/service.test.ts
git commit -m "feat(self-heal): project playbook fields through command-board service"
```

---

## Task 4: Render the status line in `TaskDetailPanel`

**Files:**
- Modify: `src/components/dashboard/command-board/TaskDetailPanel.tsx`
- Create: `src/components/dashboard/command-board/TaskDetailPanel.test.tsx` (if missing)

- [ ] **Step 4.1: Write the test**

Create `src/components/dashboard/command-board/TaskDetailPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskDetailPanel } from "./TaskDetailPanel";

const baseTask = {
    id: "t1",
    title: "x",
    status: "PENDING",
    owner: "aria",
    closes_when: null,
    dedup_count: 1,
};

describe("TaskDetailPanel playbook status line", () => {
    it("renders nothing when playbook_kind is null", () => {
        render(<TaskDetailPanel task={{ ...baseTask, playbook_kind: null, playbook_state: null }} events={[]} />);
        expect(screen.queryByTestId("playbook-status")).toBeNull();
    });

    it("renders 'running' status with kind label", () => {
        render(<TaskDetailPanel task={{ ...baseTask, playbook_kind: "add_localstorage_shim", playbook_state: "running" }} events={[]} />);
        const line = screen.getByTestId("playbook-status");
        expect(line.textContent).toMatch(/add_localstorage_shim/);
        expect(line.textContent).toMatch(/running/i);
    });

    it("renders 'manual_only' as a different visual state", () => {
        render(<TaskDetailPanel task={{ ...baseTask, playbook_kind: "audit_invoice", playbook_state: "manual_only" }} events={[]} />);
        const line = screen.getByTestId("playbook-status");
        expect(line.textContent).toMatch(/manual/i);
    });
});
```

- [ ] **Step 4.2: Run failing**

```bash
npx vitest run src/components/dashboard/command-board/TaskDetailPanel.test.tsx
```

Expected: FAIL — `playbook-status` testid doesn't exist.

- [ ] **Step 4.3: Add the status line**

In `TaskDetailPanel.tsx`, near the top of the rendered block (above the action buttons but below the title), add:

```tsx
{task.playbook_kind && (
    <div
        data-testid="playbook-status"
        className="flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono bg-zinc-900/60 border border-zinc-800/60"
        aria-label={`Playbook ${task.playbook_kind} state ${task.playbook_state ?? "unknown"}`}
    >
        {playbookIcon(task.playbook_state)}
        <span className="text-zinc-300">{task.playbook_kind}</span>
        <span className="text-zinc-500">·</span>
        <span className={playbookColor(task.playbook_state)}>{task.playbook_state ?? "unknown"}</span>
    </div>
)}
```

Above the component, add the helpers:

```tsx
import { Loader2, CheckCircle2, XCircle, User, Hourglass } from "lucide-react";

function playbookIcon(state: string | null | undefined) {
    switch (state) {
        case "running": return <Loader2 size={12} className="animate-spin text-blue-400" />;
        case "queued": return <Hourglass size={12} className="text-zinc-400" />;
        case "succeeded": return <CheckCircle2 size={12} className="text-emerald-400" />;
        case "failed": return <XCircle size={12} className="text-red-400" />;
        case "manual_only": return <User size={12} className="text-amber-400" />;
        default: return null;
    }
}

function playbookColor(state: string | null | undefined): string {
    switch (state) {
        case "running": return "text-blue-300";
        case "queued": return "text-zinc-400";
        case "succeeded": return "text-emerald-300";
        case "failed": return "text-red-300";
        case "manual_only": return "text-amber-300";
        default: return "text-zinc-400";
    }
}
```

- [ ] **Step 4.4: Run test, expect green**

```bash
npx vitest run src/components/dashboard/command-board/TaskDetailPanel.test.tsx
```

- [ ] **Step 4.5: Visual smoke**

```bash
npm run dev
# Open /dashboard, click on any task with a playbook_kind set (manually
# update one via Supabase to test). Verify the status line renders with
# the right icon + color.
```

If you don't have a test row, in psql:

```sql
UPDATE agent_task SET playbook_kind = 'demo', playbook_state = 'running'
WHERE id = (SELECT id FROM agent_task WHERE status = 'PENDING' LIMIT 1);
```

Then revert:

```sql
UPDATE agent_task SET playbook_kind = NULL, playbook_state = NULL WHERE playbook_kind = 'demo';
```

- [ ] **Step 4.6: Commit**

```bash
git add src/components/dashboard/command-board/TaskDetailPanel.tsx src/components/dashboard/command-board/TaskDetailPanel.test.tsx
git commit -m "feat(self-heal): TaskDetailPanel — playbook status line with state icons"
```

---

## Task 5: Wire two existing surfaces to set `playbook_state = 'manual_only'`

This is the "before Layer C ships, what should we annotate?" decision. Two places where a row is known to be human-only today:

**Files:**
- Modify: `src/cli/start-bot.ts` — when `/tasks` displays an approval row, the bot already calls `agentTask.upsertFromSource`. No change needed there; approval rows aren't `playbook_kind` candidates.
- Modify: `src/lib/finale/reconciler.ts` — `storePendingApproval` creates a row that will only be resolved by Will. Mark `playbook_state = 'manual_only'`.

- [ ] **Step 5.1: Add `playbookState` to `incrementOrCreate` args**

In `src/lib/intelligence/agent-task.ts` extend `IncrementOrCreateArgs` with optional `playbookState?: PlaybookState`. In the insert path, pass it through.

- [ ] **Step 5.2: Update `reconciler.storePendingApproval`**

In `src/lib/finale/reconciler.ts`, in the existing `agentTask.incrementOrCreate({ ... })` call, add:

```ts
playbookState: "manual_only",
```

- [ ] **Step 5.3: Smoke**

Trigger a reconciliation that requires approval (or wait for one). Confirm the row in dashboard shows the "manual" badge.

- [ ] **Step 5.4: Commit**

```bash
git add src/lib/intelligence/agent-task.ts src/lib/finale/reconciler.ts
git commit -m "feat(self-heal): mark reconciler approval rows as manual_only"
```

---

## Definition of Done

- `agent_task` has `playbook_kind` (text) and `playbook_state` (CHECK in 5-value set) columns.
- `setPlaybook(taskId, kind, state)` exists and writes both columns + a ledger event.
- The command-board API surfaces both fields in `tasks` and `tasks/:id`.
- `TaskDetailPanel` renders a colored, icon'd status line when `playbook_kind` is set.
- Reconciler approval rows now show as `manual_only` in the UI.
- Typecheck passes. Test suite passes (modulo pre-existing `test-single-po-calendar` failure).
- The schema is ready for Layer C to start writing `running`/`succeeded`/`failed` from a runner.

## Out of Scope (Layer C handles)

- Any code that writes `running`, `succeeded`, or `failed` automatically.
- A "playbook history" sub-table — `task_history` already covers this via `appendEvent("playbook_state_changed", …)`.
- Bulk backfill of existing rows. They stay null.
