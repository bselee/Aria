# Self-Healing Layer A — Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CI failure and migration-drift event becomes a row on the command-board work queue, so problems are visible in the same place ops work lives — no separate "go check GitHub" trip.

**Architecture:** Two write paths into the existing `agent_task` hub. (1) GitHub Actions, on failure, runs a tiny Node script that inserts directly via the Supabase REST API using the service-role key. (2) An in-process tripwire cron registered with `OpsManager` checks "migration files on disk vs. applied in DB" every 30 minutes and writes a task row when they diverge. Both paths reuse `agentTask.incrementOrCreate` semantics so repeated failures don't spam the lane — they bump `dedup_count` and produce a `stuck_source` meta-task after the sixth occurrence.

**Tech Stack:** Node 20, Supabase REST (PostgREST), GitHub Actions, existing `OpsManager`, existing `cron-registry`, existing `agent-task.ts`, Vitest.

---

## Non-Negotiable Guardrails

- All writes go through `agentTask.incrementOrCreate` or its REST equivalent — never direct SQL `INSERT INTO agent_task`. The hub's idempotency, `closes_when` predicate computation, and ledger writes must apply.
- Service-role key lives only in GitHub Actions secrets and `.env.local`. Never commit, never log, never echo in CI output.
- Tripwire is best-effort. A failed tripwire run must not crash `OpsManager` — wrap in `safeRun` like every other ops job.
- New CI step must not fire on success — only on `if: failure()`. Otherwise we'd surface an "all green" event as a task.
- Same `closes_when` philosophy: tripwire-derived tasks auto-close when the next tripwire run sees the underlying invariant satisfied. CI tasks auto-close when the next successful CI run for the same workflow file lands on `main`.

## Scope

**In scope (this plan, A1):**
- GitHub Actions failure → `agent_task` row.
- Migration drift tripwire cron → `agent_task` row.
- Auto-close logic for both task kinds.
- Tests for the writer code paths (unit) and the tripwire library (unit).

**Deferred to a follow-up plan (A2):**
- Pattern miner reading `task_history` to surface recurring failure signatures.
- Tripwires for additional invariants (env vars, PM2 process roster, schema introspection drift).

The deferred items are not blockers for self-healing visibility — A1 alone closes ≥80% of the gap.

---

## Preflight

```bash
# 1. Confirm DATABASE_URL works (we'll mirror this from CI).
node -e "require('dotenv').config({path:'.env.local'}); console.log('db ok:', Boolean(process.env.DATABASE_URL))"

# 2. Confirm SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are set.
node -e "require('dotenv').config({path:'.env.local'}); console.log('svc ok:', Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)); console.log('url ok:', Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL))"

# 3. Confirm the agent_task hub already has the columns we need (no migration required).
node _run_migration.js --check-only 2>&1 || true   # informational; the script may not support flag
```

Expected outputs: `db ok: true`, `svc ok: true`, `url ok: true`. Schema check is informational.

If any are missing, stop and fix env before starting Task 1.

---

## File Structure

| Path | Responsibility |
|---|---|
| `scripts/report-ci-failure.mjs` | Tiny Node script run by CI on failure. Reads workflow context env vars, POSTs to Supabase REST `agent_task` with the right shape. Self-contained — no project imports, no `node_modules` resolution beyond `node-fetch`-equivalent (use `globalThis.fetch`, Node 20 has it). |
| `.github/workflows/ci.yml` | Already exists locally (untracked, blocked on `workflow` scope). This plan extends it with a `report-failure` job that runs the script. |
| `src/lib/intelligence/tripwires/index.ts` | Public surface: `runAllTripwires(): Promise<TripwireResult[]>`. |
| `src/lib/intelligence/tripwires/migration-drift.ts` | Single tripwire: list `supabase/migrations/*.sql`, compare to `supabase_migrations` schema/table, return list of unapplied filenames. |
| `src/lib/intelligence/tripwires/migration-drift.test.ts` | Mocks Supabase + filesystem, asserts drift detection. |
| `src/lib/intelligence/tripwire-runner.ts` | Translates `TripwireResult[]` → `agentTask.incrementOrCreate` calls. Handles auto-close (when current run shows OK, close the matching open task). |
| `src/lib/intelligence/tripwire-runner.test.ts` | Mocks `incrementOrCreate` + tripwire results, asserts task creation, dedup, auto-close. |
| `src/lib/intelligence/agent-task-closure.ts` | Add new `closes_when.kind = "ci_workflow_passes"` and `kind = "tripwire_passes"` predicates. |
| `src/lib/intelligence/agent-task-closure.test.ts` | Add cases for the two new predicate kinds. |
| `src/lib/scheduler/cron-registry.ts` | Register `MigrationTripwire` job. |
| `src/lib/scheduler/cron-registry.test.ts` | Sync-test catches the new entry. |
| `src/lib/intelligence/ops-manager.ts` | Wire `MigrationTripwire` into `registerJobs()`. |
| `src/lib/intelligence/agent-task.ts` | Add new task type literal `"ci_failure"` and `"tripwire_violation"` to `AgentTaskType`. |

---

## Task 1: Extend AgentTaskType + closure predicates (foundation)

**Files:**
- Modify: `src/lib/intelligence/agent-task.ts`
- Modify: `src/lib/intelligence/agent-task-closure.ts`
- Modify: `src/lib/intelligence/agent-task-closure.test.ts`

- [ ] **Step 1.1: Write the failing test for `ci_workflow_passes` predicate**

Add to `src/lib/intelligence/agent-task-closure.test.ts`:

```ts
it("ci_workflow_passes closure: matches when later run for same workflow file succeeds", () => {
    const pred: ClosurePredicate = {
        kind: "ci_workflow_passes",
        workflow: "ci.yml",
        ref: "main",
    };
    expect(evaluateClosure(pred, {
        latestCiRun: { workflow: "ci.yml", ref: "main", conclusion: "success", started_at: new Date().toISOString() },
        taskCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    })).toBe(true);
    expect(evaluateClosure(pred, {
        latestCiRun: { workflow: "ci.yml", ref: "main", conclusion: "failure", started_at: new Date().toISOString() },
        taskCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    })).toBe(false);
});

it("tripwire_passes closure: matches when same tripwire reports OK after task creation", () => {
    const pred: ClosurePredicate = { kind: "tripwire_passes", tripwire: "migration-drift" };
    expect(evaluateClosure(pred, {
        latestTripwireRun: { tripwire: "migration-drift", ok: true, ranAt: new Date().toISOString() },
        taskCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    })).toBe(true);
});
```

- [ ] **Step 1.2: Run failing**

```bash
npx vitest run src/lib/intelligence/agent-task-closure.test.ts
```

Expected: FAIL — `evaluateClosure` doesn't recognise the new kinds.

- [ ] **Step 1.3: Extend `ClosurePredicate` union and `evaluateClosure`**

In `src/lib/intelligence/agent-task-closure.ts` add to the `ClosurePredicate` union:

```ts
| { kind: "ci_workflow_passes"; workflow: string; ref: string }
| { kind: "tripwire_passes"; tripwire: string }
```

Extend `evaluateClosure` (or its switch) with:

```ts
case "ci_workflow_passes": {
    const run = ctx.latestCiRun;
    if (!run) return false;
    if (run.workflow !== pred.workflow) return false;
    if (run.ref !== pred.ref) return false;
    if (new Date(run.started_at) <= new Date(ctx.taskCreatedAt)) return false;
    return run.conclusion === "success";
}
case "tripwire_passes": {
    const run = ctx.latestTripwireRun;
    if (!run) return false;
    if (run.tripwire !== pred.tripwire) return false;
    if (new Date(run.ranAt) <= new Date(ctx.taskCreatedAt)) return false;
    return run.ok === true;
}
```

Extend the closure context type with the optional `latestCiRun` and `latestTripwireRun` properties.

- [ ] **Step 1.4: Run test, expect green**

```bash
npx vitest run src/lib/intelligence/agent-task-closure.test.ts
```

Expected: PASS.

- [ ] **Step 1.5: Add task-type literals**

In `src/lib/intelligence/agent-task.ts`, extend the `AgentTaskType` union:

```ts
export type AgentTaskType =
    | "cron_failure"
    | "approval"
    | "dropship_forward"
    | "po_send_confirm"
    | "agent_exception"
    | "control_command"
    | "manual"
    | "code_change"
    | "stuck_source"
    | "ci_failure"            // new
    | "tripwire_violation";   // new
```

- [ ] **Step 1.6: Run typecheck**

```bash
npm run typecheck:cli
```

Expected: 0 errors.

- [ ] **Step 1.7: Commit**

```bash
git add src/lib/intelligence/agent-task.ts src/lib/intelligence/agent-task-closure.ts src/lib/intelligence/agent-task-closure.test.ts
git commit -m "feat(control-plane): add ci_failure + tripwire_violation task types and closure predicates"
```

---

## Task 2: Migration-drift tripwire (pure logic, fully testable)

**Files:**
- Create: `src/lib/intelligence/tripwires/migration-drift.ts`
- Create: `src/lib/intelligence/tripwires/migration-drift.test.ts`
- Create: `src/lib/intelligence/tripwires/index.ts`

- [ ] **Step 2.1: Write the failing test**

`src/lib/intelligence/tripwires/migration-drift.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { detectMigrationDrift } from "./migration-drift";

describe("detectMigrationDrift", () => {
    it("returns ok when on-disk filenames match applied versions", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql"],
            listApplied: async () => ["20260101_a.sql", "20260102_b.sql"],
        });
        expect(result.ok).toBe(true);
        expect(result.unapplied).toEqual([]);
    });

    it("returns drift list when on-disk has more than applied", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql", "20260103_c.sql"],
            listApplied: async () => ["20260101_a.sql", "20260102_b.sql"],
        });
        expect(result.ok).toBe(false);
        expect(result.unapplied).toEqual(["20260103_c.sql"]);
    });

    it("ignores out-of-order applied set (compares by filename only)", async () => {
        const result = await detectMigrationDrift({
            listOnDisk: async () => ["20260101_a.sql", "20260102_b.sql"],
            listApplied: async () => ["20260102_b.sql", "20260101_a.sql"],
        });
        expect(result.ok).toBe(true);
    });
});
```

- [ ] **Step 2.2: Run failing**

```bash
npx vitest run src/lib/intelligence/tripwires/migration-drift.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 2.3: Implement `detectMigrationDrift`**

`src/lib/intelligence/tripwires/migration-drift.ts`:

```ts
/**
 * @file    migration-drift.ts
 * @purpose Tripwire: detect Supabase migrations on disk that have not been
 *          applied to the live database.
 *
 *          Pure function — caller injects the two list sources so we can
 *          unit test without hitting fs/Supabase.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase";

export type TripwireResult = {
    tripwire: string;
    ok: boolean;
    /** Human-readable summary used as the task goal. */
    summary: string;
    /** Structured detail used as task inputs. */
    detail: Record<string, unknown>;
    ranAt: string;
};

export type MigrationDriftDeps = {
    listOnDisk: () => Promise<string[]>;
    listApplied: () => Promise<string[]>;
};

export async function detectMigrationDrift(
    deps: MigrationDriftDeps = defaultMigrationDriftDeps(),
): Promise<TripwireResult & { unapplied: string[] }> {
    const [onDisk, applied] = await Promise.all([deps.listOnDisk(), deps.listApplied()]);
    const appliedSet = new Set(applied);
    const unapplied = onDisk.filter(f => !appliedSet.has(f)).sort();
    const ok = unapplied.length === 0;
    return {
        tripwire: "migration-drift",
        ok,
        summary: ok
            ? "All migrations applied"
            : `${unapplied.length} migration(s) on disk not applied: ${unapplied.slice(0, 3).join(", ")}${unapplied.length > 3 ? " …" : ""}`,
        detail: { unapplied },
        ranAt: new Date().toISOString(),
        unapplied,
    };
}

function defaultMigrationDriftDeps(): MigrationDriftDeps {
    return {
        listOnDisk: async () => {
            const dir = path.join(process.cwd(), "supabase", "migrations");
            const entries = await readdir(dir);
            return entries.filter(e => e.endsWith(".sql")).sort();
        },
        listApplied: async () => {
            const supabase = createClient();
            if (!supabase) throw new Error("Supabase not configured");
            // Supabase tracks applied migrations in supabase_migrations.schema_migrations.
            // The version column is the migration filename without extension by convention.
            const { data, error } = await supabase
                .schema("supabase_migrations")
                .from("schema_migrations")
                .select("version");
            if (error) throw error;
            // Reconstruct .sql filenames from versions; if conventions diverge,
            // adjust here once. Don't add a normalization layer for hypothetical
            // future variance.
            return (data ?? []).map(r => `${(r as { version: string }).version}.sql`).sort();
        },
    };
}
```

- [ ] **Step 2.4: Run test, expect green**

```bash
npx vitest run src/lib/intelligence/tripwires/migration-drift.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 2.5: Create the index re-export**

`src/lib/intelligence/tripwires/index.ts`:

```ts
import { detectMigrationDrift, type TripwireResult } from "./migration-drift";

export type { TripwireResult };

export async function runAllTripwires(): Promise<TripwireResult[]> {
    const results: TripwireResult[] = [];
    try {
        results.push(await detectMigrationDrift());
    } catch (err) {
        results.push({
            tripwire: "migration-drift",
            ok: false,
            summary: `tripwire crashed: ${err instanceof Error ? err.message : String(err)}`,
            detail: { error: String(err) },
            ranAt: new Date().toISOString(),
        });
    }
    return results;
}
```

- [ ] **Step 2.6: Commit**

```bash
git add src/lib/intelligence/tripwires/
git commit -m "feat(self-heal): migration-drift tripwire — detect unapplied .sql files"
```

---

## Task 3: Tripwire runner (writes results into agent_task)

**Files:**
- Create: `src/lib/intelligence/tripwire-runner.ts`
- Create: `src/lib/intelligence/tripwire-runner.test.ts`

- [ ] **Step 3.1: Write the failing test**

`src/lib/intelligence/tripwire-runner.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TripwireResult } from "./tripwires";
import { applyTripwireResults } from "./tripwire-runner";

vi.mock("@/lib/intelligence/agent-task", () => ({
    incrementOrCreate: vi.fn().mockResolvedValue({ id: "task-uuid" }),
    updateBySource: vi.fn().mockResolvedValue(undefined),
    getBySource: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
}));

import * as agentTask from "@/lib/intelligence/agent-task";

describe("applyTripwireResults", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates a tripwire_violation task when result.ok is false", async () => {
        const result: TripwireResult = {
            tripwire: "migration-drift",
            ok: false,
            summary: "1 migration not applied: 20260606_x.sql",
            detail: { unapplied: ["20260606_x.sql"] },
            ranAt: new Date().toISOString(),
        };
        await applyTripwireResults([result]);
        expect(agentTask.incrementOrCreate).toHaveBeenCalledWith(expect.objectContaining({
            type: "tripwire_violation",
            sourceTable: "tripwires",
            sourceId: "migration-drift",
            owner: "aria",
        }));
    });

    it("auto-closes existing open task when result.ok is true", async () => {
        vi.mocked(agentTask.getBySource).mockResolvedValueOnce({
            id: "open-task",
            status: "PENDING",
            type: "tripwire_violation",
        } as never);
        const result: TripwireResult = {
            tripwire: "migration-drift",
            ok: true,
            summary: "All migrations applied",
            detail: {},
            ranAt: new Date().toISOString(),
        };
        await applyTripwireResults([result]);
        expect(agentTask.complete).toHaveBeenCalledWith(
            "open-task",
            expect.objectContaining({ auto_handled_by: "tripwire-runner" }),
        );
        expect(agentTask.incrementOrCreate).not.toHaveBeenCalled();
    });

    it("no-ops when result.ok is true and no open task exists", async () => {
        const result: TripwireResult = {
            tripwire: "migration-drift",
            ok: true,
            summary: "All migrations applied",
            detail: {},
            ranAt: new Date().toISOString(),
        };
        await applyTripwireResults([result]);
        expect(agentTask.incrementOrCreate).not.toHaveBeenCalled();
        expect(agentTask.complete).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 3.2: Run failing**

```bash
npx vitest run src/lib/intelligence/tripwire-runner.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3.3: Implement runner**

`src/lib/intelligence/tripwire-runner.ts`:

```ts
/**
 * @file    tripwire-runner.ts
 * @purpose Translate TripwireResult[] into agent_task hub writes. Failed
 *          tripwires create or dedup `tripwire_violation` rows; passing
 *          tripwires auto-close any open row for the same tripwire.
 */

import * as agentTask from "@/lib/intelligence/agent-task";
import type { TripwireResult } from "./tripwires";

export async function applyTripwireResults(results: TripwireResult[]): Promise<void> {
    for (const r of results) {
        if (!r.ok) {
            await agentTask.incrementOrCreate({
                type: "tripwire_violation",
                sourceTable: "tripwires",
                sourceId: r.tripwire,
                goal: r.summary,
                owner: "aria",
                priority: 1,
                requiresApproval: false,
                inputs: { tripwire: r.tripwire, ranAt: r.ranAt, ...r.detail },
            }).catch(err => {
                console.warn(`[tripwire-runner] incrementOrCreate failed for ${r.tripwire}:`, err);
            });
            continue;
        }
        // Passing: auto-close any open violation for this tripwire.
        const open = await agentTask.getBySource("tripwires", r.tripwire).catch(() => null);
        if (open && (open.status === "PENDING" || open.status === "NEEDS_APPROVAL" || open.status === "RUNNING" || open.status === "CLAIMED")) {
            await agentTask.complete(open.id, {
                auto_handled_by: "tripwire-runner",
                resolution: r.summary,
                ranAt: r.ranAt,
            });
        }
    }
}
```

- [ ] **Step 3.4: Run test, expect green**

```bash
npx vitest run src/lib/intelligence/tripwire-runner.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/intelligence/tripwire-runner.ts src/lib/intelligence/tripwire-runner.test.ts
git commit -m "feat(self-heal): tripwire-runner — translate results into agent_task hub writes"
```

---

## Task 4: Wire tripwire into OpsManager + cron registry

**Files:**
- Modify: `src/lib/scheduler/cron-registry.ts`
- Modify: `src/lib/scheduler/cron-registry.test.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`

- [ ] **Step 4.1: Add registry entry**

In `src/lib/scheduler/cron-registry.ts`, add to `CRON_JOBS`:

```ts
{
    name: 'MigrationTripwire',
    description: 'Compares supabase/migrations/*.sql on disk to applied versions in DB; emits a tripwire_violation task when drift detected',
    schedule: '*/30 * * * *',
    scheduleHuman: 'Every 30 minutes',
    category: 'maintenance',
    weekdaysOnly: false,
},
```

- [ ] **Step 4.2: Update sync test count + names**

In `src/lib/scheduler/cron-registry.test.ts`:

```ts
it('contains the full current runtime schedule', () => {
    expect(CRON_JOBS.length).toBe(17);   // bumped from 16
});
```

And add `'MigrationTripwire'` to the `expectedTasks` array in the "includes all task names scheduled by OpsManager.registerJobs" test.

- [ ] **Step 4.3: Run, expect FAIL on the OpsManager scheduling check**

```bash
npx vitest run src/lib/scheduler/cron-registry.test.ts
```

Expected: FAIL — registry has it but OpsManager doesn't schedule it yet.

- [ ] **Step 4.4: Add the cron job to OpsManager**

In `src/lib/intelligence/ops-manager.ts`, inside `registerJobs()` (find the existing pattern that wraps each job in `safeRun`), add:

```ts
this.scheduleJob('MigrationTripwire', '*/30 * * * *', async () => {
    const { runAllTripwires } = await import('./tripwires');
    const { applyTripwireResults } = await import('./tripwire-runner');
    const results = await runAllTripwires();
    await applyTripwireResults(results);
});
```

(Use lazy `import()` so the bot's boot path doesn't pull in fs/migrations work unless the cron actually fires.)

- [ ] **Step 4.5: Run sync test, expect PASS**

```bash
npx vitest run src/lib/scheduler/cron-registry.test.ts
```

Expected: PASS.

- [ ] **Step 4.6: Commit**

```bash
git add src/lib/scheduler/cron-registry.ts src/lib/scheduler/cron-registry.test.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(self-heal): MigrationTripwire cron — runs every 30 min, surfaces drift to dashboard"
```

---

## Task 5: CI failure reporter script

**Files:**
- Create: `scripts/report-ci-failure.mjs`
- Create: `scripts/report-ci-failure.test.mjs` (smoke; runs against a mock fetch)

- [ ] **Step 5.1: Write the script**

`scripts/report-ci-failure.mjs`:

```js
#!/usr/bin/env node
/**
 * Run from a GitHub Actions step that triggers on workflow failure.
 * Inserts a `ci_failure` row into agent_task via Supabase REST.
 *
 * Required env (set by GitHub + secrets):
 *   NEXT_PUBLIC_SUPABASE_URL  — e.g. https://abc.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — from repo secrets
 *   GITHUB_REPOSITORY         — auto-set (owner/repo)
 *   GITHUB_RUN_ID             — auto-set (numeric)
 *   GITHUB_RUN_NUMBER         — auto-set
 *   GITHUB_WORKFLOW           — auto-set ("CI")
 *   GITHUB_REF_NAME           — auto-set (branch name)
 *   GITHUB_SHA                — auto-set (commit)
 *   GITHUB_JOB                — auto-set (failing job id)
 *   FAILED_STEP               — optional, set by caller
 */

const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_WORKFLOW",
    "GITHUB_REF_NAME",
    "GITHUB_SHA",
];
for (const k of required) {
    if (!process.env[k]) {
        console.error(`report-ci-failure: missing required env ${k}`);
        process.exit(1);
    }
}

const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/agent_task`;
const sourceId = `${process.env.GITHUB_REPOSITORY}#${process.env.GITHUB_RUN_ID}`;
const goal = `CI failed: ${process.env.GITHUB_WORKFLOW} on ${process.env.GITHUB_REF_NAME} (${process.env.GITHUB_SHA.slice(0, 7)})`;
const inputs = {
    repo: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW,
    runId: process.env.GITHUB_RUN_ID,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    ref: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
    job: process.env.GITHUB_JOB ?? null,
    failedStep: process.env.FAILED_STEP ?? null,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
};

// Stable input_hash so re-running the same failing job dedupes via the
// (source_table, source_id, input_hash) partial unique index. We don't have
// the project's hash() helper here — use a JSON canonical form.
const canonical = JSON.stringify({
    repo: inputs.repo,
    workflow: inputs.workflow,
    ref: inputs.ref,
    sha: inputs.sha,
});
const crypto = await import("node:crypto");
const inputHash = crypto.createHash("sha256").update(canonical).digest("hex");

const closesWhen = {
    kind: "ci_workflow_passes",
    workflow: process.env.GITHUB_WORKFLOW,
    ref: process.env.GITHUB_REF_NAME,
};

const body = {
    type: "ci_failure",
    source_table: "github_actions",
    source_id: sourceId,
    input_hash: inputHash,
    goal,
    status: "PENDING",
    owner: "aria",
    priority: 1,
    requires_approval: false,
    inputs,
    closes_when: closesWhen,
    dedup_count: 1,
};

const res = await fetch(url, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",   // dedup on conflict
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
});

if (!res.ok) {
    const text = await res.text();
    console.error(`report-ci-failure: ${res.status} ${res.statusText} — ${text}`);
    process.exit(1);
}

console.log(`report-ci-failure: surfaced run ${process.env.GITHUB_RUN_ID} as agent_task`);
```

- [ ] **Step 5.2: Mark executable + smoke test**

```bash
chmod +x scripts/report-ci-failure.mjs

# Dry run — should fail with missing env
node scripts/report-ci-failure.mjs
```

Expected: prints "missing required env" and exits 1.

- [ ] **Step 5.3: Live test against the real DB**

Set the four GitHub-style env vars manually and run with `.env.local` loaded:

```bash
GITHUB_REPOSITORY=bselee/Aria \
GITHUB_RUN_ID=test-$(date +%s) \
GITHUB_WORKFLOW=ci.yml \
GITHUB_REF_NAME=main \
GITHUB_SHA=$(git rev-parse HEAD) \
node --env-file=.env.local scripts/report-ci-failure.mjs
```

Expected: prints `surfaced run …`. Verify with:

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/agent_task?source_table=eq.github_actions&select=id,goal,status&order=created_at.desc&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Should show one row with `goal` containing "CI failed".

- [ ] **Step 5.4: Clean up the test row**

```bash
# Delete the synthetic test row by goal pattern
curl -X DELETE "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/agent_task?source_id=like.bselee%2FAria%23test-*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

- [ ] **Step 5.5: Commit**

```bash
git add scripts/report-ci-failure.mjs
git commit -m "feat(self-heal): scripts/report-ci-failure.mjs — POST CI failures into agent_task"
```

---

## Task 6: Wire reporter into the CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml` (currently local-only — see preflight note in plan)

> Requires `gh auth refresh -h github.com -s workflow` first, since the OAuth token used to push must include the `workflow` scope.

- [ ] **Step 6.1: Add the failure-reporting job**

Append to `.github/workflows/ci.yml`:

```yaml
  report-ci-failure:
    runs-on: ubuntu-latest
    needs: test-and-typecheck
    if: failure() && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Surface failure as agent_task
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          FAILED_STEP: ${{ needs.test-and-typecheck.outputs.failed_step }}
        run: node scripts/report-ci-failure.mjs
```

Only fire on `main` so PR failures don't pollute the lane (PR failures are visible in GitHub directly). `main` failures mean the merged code broke something.

- [ ] **Step 6.2: Add the two repo secrets**

Run locally:

```bash
gh secret set NEXT_PUBLIC_SUPABASE_URL < <(node -e "require('dotenv').config({path:'.env.local'}); process.stdout.write(process.env.NEXT_PUBLIC_SUPABASE_URL || '')")
gh secret set SUPABASE_SERVICE_ROLE_KEY < <(node -e "require('dotenv').config({path:'.env.local'}); process.stdout.write(process.env.SUPABASE_SERVICE_ROLE_KEY || '')")
```

Verify:

```bash
gh secret list
```

Should show both secrets.

- [ ] **Step 6.3: Refresh token + commit**

```bash
gh auth refresh -h github.com -s workflow
git add .github/workflows/ci.yml
git commit -m "ci: report failures on main into agent_task hub"
git push
```

- [ ] **Step 6.4: Validate by intentionally breaking a test on a branch**

```bash
git checkout -b ci-failure-smoke-test
# Break a tiny test deliberately
echo "it.fails && it('intentional', () => expect(1).toBe(2));" >> src/lib/copilot/smoke.test.ts
git add src/lib/copilot/smoke.test.ts
git commit -m "test: intentional smoke failure (revert me)"
git push -u origin ci-failure-smoke-test
gh pr create --base main --title "[smoke] CI failure surface test" --body "DELETE-ME"
```

(PR failures don't fire the reporter because we gated on `main` — that's intentional.)

To test the actual `main` path: don't merge the smoke; instead temporarily disable the `if: github.ref == 'refs/heads/main'` guard, push to `main` directly with the broken test, observe the row appear in dashboard, then restore.

This is the "explicitly destructive validation" — only do it if you want the proof. Otherwise skip and trust the unit-test contract from Task 5.

- [ ] **Step 6.5: Clean up smoke branch**

```bash
git checkout main
git branch -D ci-failure-smoke-test
gh pr close <smoke-pr-number> --delete-branch
```

---

## Task 7: Restart bot, verify tripwire fires once cleanly

- [ ] **Step 7.1: Typecheck + test full**

```bash
npm run typecheck:cli
npm test
```

Expected: 0 typecheck errors. 1 pre-existing test failure (`test-single-po-calendar`) tolerated.

- [ ] **Step 7.2: Restart**

```bash
pm2 restart aria-bot
pm2 logs aria-bot --lines 50 --nostream
```

Look for the cron registration log line — `MigrationTripwire` should appear.

- [ ] **Step 7.3: Force a fire**

```bash
# Insert a fake migration file that won't apply (just sits on disk)
echo "-- placeholder, does nothing" > supabase/migrations/29991231_tripwire_smoke.sql

# Wait up to 30 min OR trigger manually if there's an admin command:
#   /tasks (Telegram) — should show a new tripwire_violation row within ~30 min
# Or run inline:
node --import tsx -e "import('./src/lib/intelligence/tripwires/index.js').then(async m => { const r = await m.runAllTripwires(); console.log(r); const { applyTripwireResults } = await import('./src/lib/intelligence/tripwire-runner.js'); await applyTripwireResults(r); })"
```

Expected: console shows `ok: false, unapplied: ['29991231_tripwire_smoke.sql']`. Then check the dashboard `/dashboard` — a tripwire_violation card should be in the Needs Will (or Autonomous) lane.

- [ ] **Step 7.4: Resolve and verify auto-close**

```bash
rm supabase/migrations/29991231_tripwire_smoke.sql
node --import tsx -e "import('./src/lib/intelligence/tripwires/index.js').then(async m => { const r = await m.runAllTripwires(); const { applyTripwireResults } = await import('./src/lib/intelligence/tripwire-runner.js'); await applyTripwireResults(r); })"
```

Expected: the card should disappear from the open lanes and appear in Recently Closed with `auto_handled_by: tripwire-runner`.

- [ ] **Step 7.5: Final commit (if any drift in tests was discovered)**

```bash
git status
# If clean, no commit needed.
```

---

## Definition of Done

- A failing CI run on `main` produces exactly one `ci_failure` row in `agent_task` within 30 seconds.
- A subsequent successful CI run on the same workflow + ref auto-closes that row (status → SUCCEEDED, `auto_handled_by: ci-reporter` or via `closes_when` evaluator).
- An unapplied migration file on disk produces a `tripwire_violation` row within 30 minutes.
- Removing or applying the migration auto-closes the row on the next tripwire pass.
- Repeated identical failures (same workflow, same ref, same sha for CI; same tripwire for tripwires) do not create new rows — they bump `dedup_count`.
- `pm2 restart aria-bot` reliably starts the new cron and the old behavior is unchanged.
- Telegram `/tasks` and dashboard `/dashboard` both surface the new task types without code changes (the schema didn't change, only enum values).
- Typecheck passes. Test suite passes (modulo the pre-existing `test-single-po-calendar` failure).

## Out of Scope (Future Work)

- **Pattern miner (Plan A2):** scan `task_history` nightly for recurring failure signatures and emit `recurring_pattern` tasks.
- **Additional tripwires:** required env vars, PM2 process roster, `tsc --noEmit` pass.
- **Severity classification:** today every CI failure is priority 1. A future pass can read the test name + history and assign priority.
