# Self-Healing Layer C — Autonomous Playbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a known kind of task lands on the queue, Aria attempts the fix automatically — opens a PR, runs a script, restarts a process — and reports outcome on the task itself. Human sees "auto-handled" in Recently Closed instead of a row sitting in Needs Will.

**Architecture:** A `Playbook` interface defines `match(task) → params | null` and `attempt(params) → PlaybookResult`. A registry maps `playbook_kind` strings to handler instances. A new cron `TaskSelfHealer` polls `agent_task` for rows where `playbook_kind IS NOT NULL AND playbook_state IN ('queued','failed') AND retry_count < max_retries`, dispatches each to its registered playbook, and writes the result back via `setPlaybook` + the `task_history` ledger. Successes call `agentTask.complete(taskId, { auto_handled_by: <kind> })`. Failures bump `retry_count` and either retry next cycle or, when retries exhaust, escalate to `NEEDS_APPROVAL` so the row surfaces in Will's lane.

**Tech Stack:** Node, Octokit (for branch + PR creation), `node-cron` via `OpsManager`, existing `agent-task.ts` + Layer B `setPlaybook`, Vitest with mocked Octokit.

---

## Non-Negotiable Guardrails

- **Layer A and Layer B must already be merged.** This plan assumes `playbook_kind`, `playbook_state`, `setPlaybook`, `incrementOrCreate`, `auto_handled_by` all exist.
- **No playbook may modify production data without an explicit allowlist.** Database mutations, file deletions, branch force-pushes are all OFF by default. A playbook that wants any of these must declare it on the type and the runner must check an env-var allowlist (`PLAYBOOK_ALLOW_DB_WRITE`, `PLAYBOOK_ALLOW_FORCE_PUSH`, etc.).
- **Every playbook attempt opens a PR rather than committing to `main` directly**, except the two narrowly-scoped operational ones (`apply_pending_migration`, `restart_stale_pm2_proc`) which are intentionally direct because they're idempotent ops, not code.
- **Concurrency:** Only one TaskSelfHealer iteration may be in flight at a time. The cron uses an in-memory mutex; if the previous run is still going when the new one fires, the new one logs and exits.
- **Cap on attempts per task:** `max_retries = 3` default. After exhausting, the row goes `NEEDS_APPROVAL` with a clear `outputs.error` summary and the playbook is *not* re-attempted unless a human resets it.
- **Cap on attempts per cycle:** A single TaskSelfHealer iteration may dispatch at most 5 playbooks. Prevents a single buggy run from opening 50 PRs.
- **Audit:** Every attempt writes a `task_history` event with `event_type: "playbook_attempted"` (or `playbook_succeeded`/`playbook_failed`) and the full params + result.

## Scope

**Layer C1 — runner + first two playbooks (this plan):**
- `Playbook` interface and `playbook-registry.ts`.
- `apply_pending_migration` playbook.
- `restart_stale_pm2_proc` playbook.
- `TaskSelfHealer` cron.
- Tests + audit ledger.

**Layer C2 — code-mutating playbooks (separate plan):**
- `add_localstorage_shim` (the fix this session needed).
- `bump_typecheck_heap`.
- `restore_or_delete_dead_test`.

These C2 playbooks all open PRs against the repo, which requires Octokit + branch creation infrastructure. They share enough plumbing to deserve their own plan.

**Layer C3 — pattern-driven playbook proposal (later):**
- Pattern miner from Plan A2 emits a "we've seen this 5 times — add a playbook?" task. Manually triaged into a code-change task. (i.e. not autonomous yet — first pass keeps human in the loop on new playbooks.)

---

## Preflight

```bash
# Confirm Layer A + B are on main and applied.
git log --oneline | grep -E "self-heal.*(layer.a|layer.b)"
node _run_migration.js --check 2>&1 || true

# Confirm aria-bot is healthy.
pm2 status aria-bot

# Confirm DATABASE_URL works.
node -e "require('dotenv').config({path:'.env.local'}); console.log(Boolean(process.env.DATABASE_URL))"
```

All three should be green. Stop and unblock if any fail.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/intelligence/playbooks/types.ts` | `Playbook<T>` interface, `PlaybookResult` discriminated union, `PlaybookContext` (env + clients). |
| `src/lib/intelligence/playbooks/registry.ts` | Registry map: `playbook_kind` string → `Playbook<unknown>`. Read-only after boot. |
| `src/lib/intelligence/playbooks/apply-pending-migration.ts` | Playbook: apply a single unapplied migration file via `_run_migration.js` semantics. |
| `src/lib/intelligence/playbooks/apply-pending-migration.test.ts` | Mocks fs + `_run_migration.js` shell-out, asserts success/failure paths. |
| `src/lib/intelligence/playbooks/restart-stale-pm2-proc.ts` | Playbook: `pm2 restart <name>` for the named process. |
| `src/lib/intelligence/playbooks/restart-stale-pm2-proc.test.ts` | Mocks `child_process.exec`, asserts success path + retry path. |
| `src/lib/intelligence/playbooks/runner.ts` | Single iteration: query queued tasks → dispatch → write back. Pure (testable). |
| `src/lib/intelligence/playbooks/runner.test.ts` | Mocks Supabase + registry, asserts dispatch, retry exhaustion, concurrency cap. |
| `src/lib/scheduler/cron-registry.ts` | Add `TaskSelfHealer` registry entry. |
| `src/lib/intelligence/ops-manager.ts` | Schedule `TaskSelfHealer` via `safeRun`. |
| `supabase/migrations/20260508_max_retries_default.sql` | Set default `max_retries = 3` for new rows; backfill nulls. |

---

## Task 1: Migration — default `max_retries = 3`

**Files:**
- Create: `supabase/migrations/20260508_max_retries_default.sql`

- [ ] **Step 1.1: Migration**

```sql
-- Migration: agent_task.max_retries default 3
-- Created: 2026-05-08
-- Purpose: Layer C runner uses retry_count < max_retries as the stop
--          condition. Existing rows have max_retries = 0 (set by phase 1
--          schema), which would make every queued task escalate
--          immediately. Default to 3 going forward; backfill nulls and
--          zeros to 3 for any task with playbook_kind set.
--
-- Rollback:
--   ALTER TABLE agent_task ALTER COLUMN max_retries DROP DEFAULT;

ALTER TABLE public.agent_task
    ALTER COLUMN max_retries SET DEFAULT 3;

UPDATE public.agent_task
SET max_retries = 3
WHERE playbook_kind IS NOT NULL
  AND (max_retries IS NULL OR max_retries < 3);
```

- [ ] **Step 1.2: Apply**

```bash
node _run_migration.js supabase/migrations/20260508_max_retries_default.sql
```

- [ ] **Step 1.3: Commit**

```bash
git add supabase/migrations/20260508_max_retries_default.sql
git commit -m "feat(self-heal): default max_retries=3 for tasks with playbooks"
```

---

## Task 2: `Playbook` interface

**Files:**
- Create: `src/lib/intelligence/playbooks/types.ts`

- [ ] **Step 2.1: Write types**

```ts
/**
 * @file    types.ts
 * @purpose Shared types for the self-healing playbook layer.
 */

import type { AgentTask } from "../agent-task";

export type PlaybookSuccess = {
    ok: true;
    summary: string;
    detail?: Record<string, unknown>;
    /** PR URL if the fix opened one; else null. */
    prUrl?: string | null;
};

export type PlaybookFailure = {
    ok: false;
    error: string;
    /** True if the failure is recoverable on retry. False = escalate now. */
    retryable: boolean;
    detail?: Record<string, unknown>;
};

export type PlaybookResult = PlaybookSuccess | PlaybookFailure;

export type PlaybookContext = {
    /** Logger that already prefixes [playbook=kind] for traceability. */
    log: (msg: string, extra?: Record<string, unknown>) => void;
    /** Permission flags read from env (PLAYBOOK_ALLOW_*). */
    allow: {
        dbWrite: boolean;
        forcePush: boolean;
    };
};

export type Playbook<T> = {
    /** The playbook_kind string. Must match the column value. */
    kind: string;
    /** Short description used in the runner log. */
    description: string;
    /** Pull params from a task row. Return null if this task does not match. */
    match: (task: AgentTask) => T | null;
    /** Run the playbook. Throw only on programmer errors; expected failures should return PlaybookFailure. */
    attempt: (params: T, ctx: PlaybookContext) => Promise<PlaybookResult>;
};
```

- [ ] **Step 2.2: Commit**

```bash
git add src/lib/intelligence/playbooks/types.ts
git commit -m "feat(self-heal): Playbook interface + result types"
```

---

## Task 3: `apply_pending_migration` playbook

**Files:**
- Create: `src/lib/intelligence/playbooks/apply-pending-migration.ts`
- Create: `src/lib/intelligence/playbooks/apply-pending-migration.test.ts`

- [ ] **Step 3.1: Test first**

```ts
import { describe, expect, it, vi } from "vitest";
import { applyPendingMigration } from "./apply-pending-migration";

describe("applyPendingMigration", () => {
    const ctx = {
        log: vi.fn(),
        allow: { dbWrite: true, forcePush: false },
    };

    it("matches tripwire_violation tasks for migration-drift", () => {
        const params = applyPendingMigration.match({
            type: "tripwire_violation",
            source_table: "tripwires",
            source_id: "migration-drift",
            inputs: { unapplied: ["20260606_x.sql"] },
        } as never);
        expect(params).toEqual({ filenames: ["20260606_x.sql"] });
    });

    it("does not match other tripwires", () => {
        expect(applyPendingMigration.match({
            type: "tripwire_violation",
            source_table: "tripwires",
            source_id: "different",
            inputs: {},
        } as never)).toBeNull();
    });

    it("returns failure when dbWrite is not allowed", async () => {
        const result = await applyPendingMigration.attempt(
            { filenames: ["20260606_x.sql"] },
            { ...ctx, allow: { dbWrite: false, forcePush: false } },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.retryable).toBe(false);
            expect(result.error).toMatch(/PLAYBOOK_ALLOW_DB_WRITE/);
        }
    });

    // Note: success path is exercised in an integration smoke run
    // (Task 7) since spawning child processes in unit tests is brittle.
});
```

- [ ] **Step 3.2: Run failing**

```bash
npx vitest run src/lib/intelligence/playbooks/apply-pending-migration.test.ts
```

- [ ] **Step 3.3: Implement**

```ts
/**
 * @file    apply-pending-migration.ts
 * @purpose Self-heal: when migration-drift tripwire fires with a list of
 *          unapplied filenames, run them through _run_migration.js one at
 *          a time.
 *
 *          Operates on the live DB — gated on PLAYBOOK_ALLOW_DB_WRITE=1.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { Playbook, PlaybookResult } from "./types";

type Params = { filenames: string[] };

export const applyPendingMigration: Playbook<Params> = {
    kind: "apply_pending_migration",
    description: "Apply migration files surfaced by migration-drift tripwire",

    match(task) {
        if (task.type !== "tripwire_violation") return null;
        if (task.source_id !== "migration-drift") return null;
        const unapplied = (task.inputs as { unapplied?: unknown }).unapplied;
        if (!Array.isArray(unapplied) || unapplied.length === 0) return null;
        const filenames = unapplied.filter((x): x is string => typeof x === "string");
        if (filenames.length === 0) return null;
        return { filenames };
    },

    async attempt(params, ctx) {
        if (!ctx.allow.dbWrite) {
            return {
                ok: false,
                retryable: false,
                error: "PLAYBOOK_ALLOW_DB_WRITE must be set to run this playbook",
            };
        }
        const applied: string[] = [];
        for (const f of params.filenames) {
            const fullPath = path.join("supabase", "migrations", f);
            const result = await runMigrationScript(fullPath);
            ctx.log(`migration ${f}: ${result.ok ? "applied" : "failed"}`, { stderr: result.stderr });
            if (!result.ok) {
                return {
                    ok: false,
                    retryable: false,   // SQL errors don't fix themselves on retry
                    error: `Migration ${f} failed: ${result.stderr.slice(0, 200)}`,
                    detail: { applied, failed: f, stderr: result.stderr },
                };
            }
            applied.push(f);
        }
        return {
            ok: true,
            summary: `Applied ${applied.length} migration(s)`,
            detail: { applied },
        };
    },
};

async function runMigrationScript(file: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ["_run_migration.js", file], {
            cwd: process.cwd(),
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", d => { stdout += d.toString(); });
        child.stderr?.on("data", d => { stderr += d.toString(); });
        child.on("close", code => resolve({ ok: code === 0, stdout, stderr }));
    });
}
```

- [ ] **Step 3.4: Run, expect green**

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/intelligence/playbooks/apply-pending-migration.ts src/lib/intelligence/playbooks/apply-pending-migration.test.ts
git commit -m "feat(self-heal): apply_pending_migration playbook"
```

---

## Task 4: `restart_stale_pm2_proc` playbook

**Files:**
- Create: `src/lib/intelligence/playbooks/restart-stale-pm2-proc.ts`
- Create: `src/lib/intelligence/playbooks/restart-stale-pm2-proc.test.ts`

- [ ] **Step 4.1: Test first**

```ts
import { describe, expect, it, vi } from "vitest";
import { restartStalePm2Proc } from "./restart-stale-pm2-proc";

vi.mock("node:child_process", () => ({
    exec: (cmd: string, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (cmd.includes("aria-bot")) cb(null, "[PM2] Process aria-bot restarted", "");
        else cb(new Error("not found"), "", "");
    },
}));

describe("restartStalePm2Proc", () => {
    it("matches stale heartbeat tasks", () => {
        const params = restartStalePm2Proc.match({
            type: "agent_exception",
            source_table: "agent_heartbeats",
            inputs: { agent: "aria-bot", staleness: "stale" },
        } as never);
        expect(params).toEqual({ procName: "aria-bot" });
    });

    it("succeeds on known process", async () => {
        const result = await restartStalePm2Proc.attempt(
            { procName: "aria-bot" },
            { log: vi.fn(), allow: { dbWrite: false, forcePush: false } },
        );
        expect(result.ok).toBe(true);
    });
});
```

- [ ] **Step 4.2: Run failing.**

- [ ] **Step 4.3: Implement**

```ts
/**
 * @file    restart-stale-pm2-proc.ts
 * @purpose Self-heal: when an agent's heartbeat goes stale, run
 *          `pm2 restart <name>` and let normal heartbeat recovery confirm.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Playbook } from "./types";

const execAsync = promisify(exec);

type Params = { procName: string };

export const restartStalePm2Proc: Playbook<Params> = {
    kind: "restart_stale_pm2_proc",
    description: "pm2 restart on stale heartbeat",

    match(task) {
        if (task.type !== "agent_exception") return null;
        if (task.source_table !== "agent_heartbeats") return null;
        const inputs = task.inputs as { agent?: unknown; staleness?: unknown };
        if (typeof inputs.agent !== "string") return null;
        if (inputs.staleness !== "stale" && inputs.staleness !== "missing") return null;
        return { procName: inputs.agent };
    },

    async attempt(params, ctx) {
        try {
            const { stdout } = await execAsync(`pm2 restart ${params.procName}`);
            ctx.log(`pm2 restart ${params.procName}`, { stdout: stdout.slice(0, 200) });
            return {
                ok: true,
                summary: `pm2 restarted ${params.procName}`,
                detail: { stdout },
            };
        } catch (err) {
            return {
                ok: false,
                retryable: true,   // transient (pm2 socket flake) — try once more
                error: err instanceof Error ? err.message : String(err),
            };
        }
    },
};
```

- [ ] **Step 4.4: Commit**

```bash
git add src/lib/intelligence/playbooks/restart-stale-pm2-proc.ts src/lib/intelligence/playbooks/restart-stale-pm2-proc.test.ts
git commit -m "feat(self-heal): restart_stale_pm2_proc playbook"
```

---

## Task 5: Registry

**Files:**
- Create: `src/lib/intelligence/playbooks/registry.ts`

- [ ] **Step 5.1: Implement**

```ts
import type { Playbook } from "./types";
import { applyPendingMigration } from "./apply-pending-migration";
import { restartStalePm2Proc } from "./restart-stale-pm2-proc";

const PLAYBOOKS: Playbook<unknown>[] = [
    applyPendingMigration as Playbook<unknown>,
    restartStalePm2Proc as Playbook<unknown>,
];

export const PLAYBOOK_BY_KIND: Map<string, Playbook<unknown>> = new Map(
    PLAYBOOKS.map(p => [p.kind, p]),
);

export function listPlaybookKinds(): string[] {
    return PLAYBOOKS.map(p => p.kind);
}
```

- [ ] **Step 5.2: Commit**

```bash
git add src/lib/intelligence/playbooks/registry.ts
git commit -m "feat(self-heal): playbook registry"
```

---

## Task 6: Runner

**Files:**
- Create: `src/lib/intelligence/playbooks/runner.ts`
- Create: `src/lib/intelligence/playbooks/runner.test.ts`

- [ ] **Step 6.1: Test first** — full failure-and-retry path mocked

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { runOnce } from "./runner";

vi.mock("@/lib/supabase", () => ({
    createClient: () => mockSupabase,
}));

vi.mock("@/lib/intelligence/agent-task", () => ({
    setPlaybook: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./registry", () => ({
    PLAYBOOK_BY_KIND: new Map([
        ["apply_pending_migration", {
            kind: "apply_pending_migration",
            description: "test",
            match: (task: any) => ({ filenames: task.inputs.unapplied }),
            attempt: vi.fn().mockResolvedValue({ ok: true, summary: "applied 1" }),
        }],
    ]),
}));

let mockSupabase: any;

beforeEach(() => {
    vi.clearAllMocks();
});

describe("runOnce", () => {
    it("succeeds and marks task SUCCEEDED", async () => {
        mockSupabase = {
            from: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
                data: [{
                    id: "t1",
                    type: "tripwire_violation",
                    playbook_kind: "apply_pending_migration",
                    playbook_state: "queued",
                    retry_count: 0,
                    max_retries: 3,
                    inputs: { unapplied: ["20260606_x.sql"] },
                }],
            }),
        };
        const summary = await runOnce({ allow: { dbWrite: true, forcePush: false } });
        expect(summary.attempted).toBe(1);
        expect(summary.succeeded).toBe(1);
    });

    it("respects per-cycle cap", async () => {
        mockSupabase = {
            from: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
                data: Array.from({ length: 12 }).map((_, i) => ({
                    id: `t${i}`,
                    type: "tripwire_violation",
                    playbook_kind: "apply_pending_migration",
                    playbook_state: "queued",
                    retry_count: 0,
                    max_retries: 3,
                    inputs: { unapplied: ["x.sql"] },
                })),
            }),
        };
        const summary = await runOnce({ allow: { dbWrite: true, forcePush: false } });
        expect(summary.attempted).toBeLessThanOrEqual(5);
    });
});
```

- [ ] **Step 6.2: Run failing.**

- [ ] **Step 6.3: Implement**

```ts
/**
 * @file    runner.ts
 * @purpose Single iteration of the self-healer. Query queued playbook
 *          tasks, dispatch each to its registered playbook, write back.
 */

import { createClient } from "@/lib/supabase";
import { setPlaybook, complete, fail, appendEvent } from "@/lib/intelligence/agent-task";
import type { AgentTask } from "@/lib/intelligence/agent-task";
import { PLAYBOOK_BY_KIND } from "./registry";
import type { PlaybookContext } from "./types";

const PER_CYCLE_CAP = 5;

let inFlight = false;

export type RunSummary = {
    attempted: number;
    succeeded: number;
    failed: number;
    escalated: number;
    skipped: number;
};

export async function runOnce(opts: { allow: PlaybookContext["allow"] }): Promise<RunSummary> {
    if (inFlight) {
        return { attempted: 0, succeeded: 0, failed: 0, escalated: 0, skipped: 1 };
    }
    inFlight = true;
    try {
        return await runIteration(opts);
    } finally {
        inFlight = false;
    }
}

async function runIteration(opts: { allow: PlaybookContext["allow"] }): Promise<RunSummary> {
    const supabase = createClient();
    if (!supabase) return { attempted: 0, succeeded: 0, failed: 0, escalated: 0, skipped: 1 };

    // Supabase doesn't support column-to-column comparison in a chainable
    // filter — pull a slightly oversized window and apply the
    // retry_count < max_retries check in JS. Cheaper than a stored proc
    // for the cap-of-5 workload.
    const { data: rows } = await supabase
        .from("agent_task")
        .select("*")
        .in("playbook_state", ["queued", "failed"])
        .limit(PER_CYCLE_CAP * 4);

    const tasks = (rows ?? [])
        .filter((t: AgentTask) => (t.retry_count ?? 0) < (t.max_retries ?? 3))
        .filter((t: AgentTask) => t.playbook_kind && PLAYBOOK_BY_KIND.has(t.playbook_kind))
        .slice(0, PER_CYCLE_CAP);

    let succeeded = 0;
    let failed = 0;
    let escalated = 0;

    for (const task of tasks) {
        const playbook = PLAYBOOK_BY_KIND.get(task.playbook_kind!)!;
        const params = playbook.match(task);
        if (!params) {
            // Mismatch — mark failed and let next cycle escalate.
            await setPlaybook(task.id, task.playbook_kind!, "failed");
            await appendEvent(task.id, "playbook_match_failed", { playbook_kind: task.playbook_kind });
            failed++;
            continue;
        }

        await setPlaybook(task.id, task.playbook_kind!, "running");
        await appendEvent(task.id, "playbook_attempted", { playbook_kind: task.playbook_kind, retry: task.retry_count });

        const ctx: PlaybookContext = {
            log: (msg, extra) => console.log(`[playbook=${task.playbook_kind} task=${task.id}] ${msg}`, extra ?? ""),
            allow: opts.allow,
        };

        try {
            const result = await playbook.attempt(params, ctx);
            if (result.ok) {
                await setPlaybook(task.id, task.playbook_kind!, "succeeded");
                await complete(task.id, {
                    auto_handled_by: task.playbook_kind,
                    summary: result.summary,
                    pr_url: result.prUrl ?? null,
                    ...(result.detail ?? {}),
                });
                succeeded++;
            } else {
                await setPlaybook(task.id, task.playbook_kind!, "failed");
                const newRetry = (task.retry_count ?? 0) + 1;
                await supabase
                    .from("agent_task")
                    .update({ retry_count: newRetry })
                    .eq("id", task.id);
                if (!result.retryable || newRetry >= (task.max_retries ?? 3)) {
                    await supabase
                        .from("agent_task")
                        .update({ status: "NEEDS_APPROVAL", owner: "will" })
                        .eq("id", task.id);
                    await appendEvent(task.id, "playbook_escalated", { reason: result.error });
                    escalated++;
                } else {
                    failed++;
                }
            }
        } catch (err) {
            // Programmer error in the playbook — escalate immediately.
            await setPlaybook(task.id, task.playbook_kind!, "failed");
            await fail(task.id, err instanceof Error ? err.message : String(err));
            escalated++;
        }
    }

    return { attempted: tasks.length, succeeded, failed, escalated, skipped: 0 };
}
```

- [ ] **Step 6.4: Run, expect green.**

- [ ] **Step 6.5: Commit**

```bash
git add src/lib/intelligence/playbooks/runner.ts src/lib/intelligence/playbooks/runner.test.ts
git commit -m "feat(self-heal): TaskSelfHealer runner with retry/escalation"
```

---

## Task 7: Cron registration + OpsManager wiring

**Files:**
- Modify: `src/lib/scheduler/cron-registry.ts`
- Modify: `src/lib/scheduler/cron-registry.test.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`

- [ ] **Step 7.1: Add registry entry**

```ts
{
    name: 'TaskSelfHealer',
    description: 'Dispatches queued playbooks against agent_task rows; writes outcome back to the hub',
    schedule: '*/10 * * * *',
    scheduleHuman: 'Every 10 minutes',
    category: 'maintenance',
    weekdaysOnly: false,
},
```

- [ ] **Step 7.2: Sync test count**

```ts
expect(CRON_JOBS.length).toBe(18);   // bumped from 17 (Layer A added one)
```

And add `'TaskSelfHealer'` to the expectedTasks array.

- [ ] **Step 7.3: Wire into OpsManager**

```ts
this.scheduleJob('TaskSelfHealer', '*/10 * * * *', async () => {
    const { runOnce } = await import('./playbooks/runner');
    const summary = await runOnce({
        allow: {
            dbWrite: process.env.PLAYBOOK_ALLOW_DB_WRITE === '1',
            forcePush: process.env.PLAYBOOK_ALLOW_FORCE_PUSH === '1',
        },
    });
    console.log('[TaskSelfHealer]', summary);
});
```

- [ ] **Step 7.4: Run test, expect PASS**

- [ ] **Step 7.5: Restart bot, watch first cycle**

```bash
pm2 restart aria-bot
pm2 logs aria-bot --lines 100 --nostream | grep -i selfheal
```

Expected: every 10 minutes, a `[TaskSelfHealer] {…}` line. Initially `attempted: 0` because nothing's queued yet.

- [ ] **Step 7.6: Commit**

```bash
git add src/lib/scheduler/cron-registry.ts src/lib/scheduler/cron-registry.test.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(self-heal): TaskSelfHealer cron — every 10 min"
```

---

## Task 8: End-to-end smoke

- [ ] **Step 8.1: Set PLAYBOOK_ALLOW_DB_WRITE for the smoke**

Append to `.env.local`:

```
PLAYBOOK_ALLOW_DB_WRITE=1
```

Restart bot:

```bash
pm2 restart aria-bot --update-env
```

- [ ] **Step 8.2: Plant a no-op migration**

```bash
cat > supabase/migrations/29991231_selfheal_smoke.sql <<'EOF'
-- noop migration for self-heal smoke test
SELECT 1;
EOF
```

- [ ] **Step 8.3: Force a tripwire pass**

(Same one-liner from Layer A Task 7.3.)

```bash
node --import tsx -e "import('./src/lib/intelligence/tripwires/index.js').then(async m => { const r = await m.runAllTripwires(); const { applyTripwireResults } = await import('./src/lib/intelligence/tripwire-runner.js'); await applyTripwireResults(r); })"
```

- [ ] **Step 8.4: Annotate the row with `playbook_kind`**

In dashboard or via SQL:

```sql
UPDATE agent_task
SET playbook_kind = 'apply_pending_migration', playbook_state = 'queued'
WHERE source_table = 'tripwires' AND source_id = 'migration-drift' AND status = 'PENDING';
```

(In a future Plan C2 iteration, this annotation could be auto-set by the tripwire-runner based on heuristics. For now, it's a one-line manual step that proves the loop.)

- [ ] **Step 8.5: Wait or trigger**

```bash
node --import tsx -e "import('./src/lib/intelligence/playbooks/runner.js').then(async m => console.log(await m.runOnce({allow:{dbWrite:true,forcePush:false}})))"
```

Expected: `{ attempted: 1, succeeded: 1, failed: 0, escalated: 0, skipped: 0 }`. The migration applies. The dashboard task moves to Recently Closed with `auto_handled_by: apply_pending_migration`.

- [ ] **Step 8.6: Cleanup**

```bash
# Delete the smoke migration from disk + supabase_migrations
rm supabase/migrations/29991231_selfheal_smoke.sql
node -e "require('dotenv').config({path:'.env.local'}); const {Client} = require('pg'); const c = new Client({connectionString: process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"DELETE FROM supabase_migrations.schema_migrations WHERE version = '29991231_selfheal_smoke'\")).then(()=>c.end())"
```

---

## Definition of Done

- `Playbook` interface + 2 concrete playbooks shipped.
- `TaskSelfHealer` cron runs every 10 min, bounded to 5 dispatches per cycle, with single-flight protection.
- A queued task with `playbook_kind` set runs autonomously and either:
  - succeeds → `status=SUCCEEDED`, `auto_handled_by=<kind>`, surfaces in Recently Closed.
  - fails (retryable) → `retry_count += 1`, `playbook_state=failed`, queued for next cycle.
  - fails (non-retryable or retries exhausted) → `status=NEEDS_APPROVAL`, `owner=will`, surfaces in Will's lane with `outputs.error`.
- Every attempt writes a `playbook_attempted` event; every outcome writes `playbook_succeeded` or `playbook_failed` or `playbook_escalated` to the ledger.
- `PLAYBOOK_ALLOW_DB_WRITE` env gate works — without it set, `apply_pending_migration` returns failure with a clear error.
- Restart bot leaves no stale `inFlight` mutex (since it's per-process memory; restart resets cleanly).

## Out of Scope (Future Plans)

- **C2 — code-mutating playbooks:** `add_localstorage_shim`, `bump_typecheck_heap`, `restore_or_delete_dead_test`. Each opens a PR via Octokit.
- **C3 — pattern-driven proposal:** miner reads `task_history`, identifies signatures that recur, emits `recurring_pattern` tasks asking Will to author a new playbook.
- **Multi-tenant safety:** today the runner assumes one DB. Multi-env requires keying every playbook on environment.
- **Playbook deprecation:** no mechanism to retire a playbook gracefully if a kind no longer fires.
