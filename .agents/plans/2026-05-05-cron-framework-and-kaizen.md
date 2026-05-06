# Cron Framework + Kaizen Punchlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ops-manager.ts`'s 12 inline `cron.schedule()` calls with a declarative `defineJob` registry, then land all 12 kaizen punchlist items — most as one-line config edits inside the new framework.

**Architecture:** A typed job registry (`src/cron/`) wraps `node-cron` (existing dep) and `bottleneck` (new, ~6KB) for concurrency. Each job declares schedule + handler + budget + onFail + dependsOn. A tick runner enforces concurrency, records every run to `cron_runs`, routes failures via `onFail`, and exposes `/jobs` + `/run <name>` Telegram commands. Kaizen items #3, #4, #5, #6, #12 collapse to config edits in this framework. Items #1, #2, #7, #8, #9 are independent and land in their existing files.

**Tech Stack:** TypeScript, node-cron, bottleneck (new), Supabase, Vitest, Telegraf (existing bot).

**Out of scope:** Modules layer, skills registry, MCP server endpoint. Per Will's redirect (2026-05-05), these are deferred until a concrete pain point requires them.

---

## File Structure

**New files:**
```
src/cron/
  registry.ts            # defineJob + JobDef type + global Map<name, JobDef>
  runner.ts              # node-cron + bottleneck wiring · onFail routing · dependsOn enforcement
  history.ts             # cron_runs writer (start, end, status, duration, failure reason)
  registry.test.ts       # registry behavior tests
  runner.test.ts         # tick + concurrency + budget + dependsOn tests
  history.test.ts        # cron_runs writer tests
  jobs/                  # one file per migrated job (re-exported from index.ts)
    qty-calibration.ts
    ap-polling.ts
    po-sync.ts
    ...
    index.ts             # imports all jobs (side-effect registration)
src/cli/jobs-bootstrap.ts  # imports src/cron/jobs/index.ts then starts the runner
supabase/migrations/
  20260506000001_cron_runs.sql
```

**Modified files:**
```
src/lib/intelligence/ops-manager.ts   # delete inline cron.schedule calls; keep only the imperative methods that jobs reference
src/cli/start-bot.ts                   # mount the cron runner; add /jobs and /run tools
src/lib/intelligence/llm.ts            # kaizen #1 — add cacheControl support
src/lib/purchasing/active-purchases.ts # kaizen #2 + #7 — pre-warm vendor cache + Promise.all
src/lib/pdf/extractor.ts               # kaizen #8 — base64 cache by file hash
src/lib/intelligence/po-correlator.ts  # kaizen #9 — batch backfill
package.json                            # +bottleneck
```

---

## Conventions used by every task

- Tests: Vitest. File adjacent to source: `foo.ts` ↔ `foo.test.ts`.
- Test command: `npx vitest run path/to/file.test.ts` (single file) or `npm test`.
- Type-check command: `npx tsc --noEmit --project tsconfig.cli.json` (cli/lib only — much faster than the app config).
- Migration command: `node _run_migration.js supabase/migrations/<file>.sql`.
- Commit format: conventional (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`). Keep one task = one commit.

---

## Task 1: Add `bottleneck` dep + create `cron_runs` migration

**Files:**
- Modify: `package.json`
- Create: `supabase/migrations/20260506000001_cron_runs.sql`

- [ ] **Step 1: Install bottleneck**

```bash
npm install bottleneck
```

- [ ] **Step 2: Verify install**

```bash
node -e "console.log(require('bottleneck/package.json').version)"
```
Expected: a version like `2.x.y` printed.

- [ ] **Step 3: Write the migration file**

```sql
-- supabase/migrations/20260506000001_cron_runs.sql
--
-- Run history for the cron registry. Every defineJob tick writes a row.
-- Used by the /jobs Telegram command and any future dashboard.

CREATE TABLE IF NOT EXISTS public.cron_runs (
    id              BIGSERIAL PRIMARY KEY,
    job_name        TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    duration_ms     INTEGER,
    status          TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'skipped')),
    invoked_by      TEXT NOT NULL DEFAULT 'cron'   -- 'cron' | 'manual' | 'dependency'
        CHECK (invoked_by IN ('cron', 'manual', 'dependency')),
    failure_reason  TEXT,
    failure_message TEXT,
    metadata_jsonb  JSONB
);

CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx
    ON public.cron_runs (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS cron_runs_running_idx
    ON public.cron_runs (job_name, status)
    WHERE status = 'running';

COMMENT ON TABLE public.cron_runs IS
    'Per-tick history for src/cron/ jobs. Used by /jobs Telegram command.';
```

- [ ] **Step 4: Apply the migration**

```bash
node _run_migration.js supabase/migrations/20260506000001_cron_runs.sql
```
Expected: `✅ Applied: ...`

- [ ] **Step 5: Verify the table**

```bash
node -e "require('dotenv').config({path:'.env.local'});const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='cron_runs' ORDER BY ordinal_position\");console.log(r.rows.map(x=>x.column_name).join(','));await c.end();})()"
```
Expected: `id,job_name,started_at,ended_at,duration_ms,status,invoked_by,failure_reason,failure_message,metadata_jsonb`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json supabase/migrations/20260506000001_cron_runs.sql
git commit -m "feat(cron): add bottleneck dep and cron_runs run-history table"
```

---

## Task 2: Create `src/cron/registry.ts` — `defineJob` + JobDef + Map

**Files:**
- Create: `src/cron/registry.ts`
- Test: `src/cron/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/cron/registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { defineJob, getJob, listJobs, _resetRegistry } from "./registry";

describe("cron registry", () => {
    beforeEach(() => _resetRegistry());

    it("registers a job and retrieves it by name", () => {
        defineJob({
            name: "test-job",
            schedule: "*/5 * * * *",
            tz: "America/Denver",
            handler: async () => { /* noop */ },
        });
        const job = getJob("test-job");
        expect(job).toBeDefined();
        expect(job!.schedule).toBe("*/5 * * * *");
    });

    it("rejects duplicate names", () => {
        defineJob({ name: "dup", schedule: "* * * * *", handler: async () => {} });
        expect(() => defineJob({ name: "dup", schedule: "* * * * *", handler: async () => {} }))
            .toThrow(/already registered/i);
    });

    it("requires a name and a schedule", () => {
        expect(() => defineJob({ name: "", schedule: "* * * * *", handler: async () => {} } as any))
            .toThrow();
        expect(() => defineJob({ name: "x", schedule: "", handler: async () => {} } as any))
            .toThrow();
    });

    it("listJobs returns all registered jobs in stable order", () => {
        defineJob({ name: "b", schedule: "* * * * *", handler: async () => {} });
        defineJob({ name: "a", schedule: "* * * * *", handler: async () => {} });
        const names = listJobs().map(j => j.name);
        expect(names).toEqual(["a", "b"]);
    });

    it("defaults concurrency to 1, enabled to true, tz to America/Denver", () => {
        defineJob({ name: "defaults", schedule: "* * * * *", handler: async () => {} });
        const job = getJob("defaults")!;
        expect(job.concurrency).toBe(1);
        expect(job.enabled).toBe(true);
        expect(job.tz).toBe("America/Denver");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cron/registry.test.ts
```
Expected: FAIL — module `./registry` cannot be found.

- [ ] **Step 3: Write the registry**

```ts
// src/cron/registry.ts
/**
 * @file    registry.ts
 * @purpose Typed registry for scheduled jobs. Each defineJob() call records a
 *          JobDef in a module-level Map; the runner reads the Map at boot and
 *          schedules each entry via node-cron with the configured concurrency,
 *          budget, and onFail behavior.
 *
 * Why a registry instead of inline cron.schedule(): centralizes
 * concurrency-locking, budget envelopes, run-history, dependency declaration,
 * and on-demand invocation (/run command) — none of which can be expressed
 * inline.
 */

export type OnFailMode = "log" | "escalate-to-supervisor" | "telegram-will" | "silent";

export interface JobBudget {
    /** Soft cap on LLM tokens consumed per tick. Currently advisory; future enforcement TBD. */
    llmTokens?: number;
    /** Soft cap on Finale API calls per tick. Currently advisory. */
    finaleCalls?: number;
    /** Hard cap on tick duration. Runner aborts via AbortController if exceeded. */
    durationMs?: number;
}

export interface JobDef {
    /** Unique, kebab-case. Used as the key in /run <name> and in cron_runs. */
    name: string;
    /** Standard cron expression (5-field). Validated by node-cron at schedule time. */
    schedule: string;
    /** IANA tz. Defaults to America/Denver (Will's local). */
    tz?: string;
    /** What runs on each tick. ctx provides log + abort signal + invokedBy. */
    handler: (ctx: JobCtx) => Promise<void>;
    /** Max parallel ticks. Default 1 — never overlap with itself. */
    concurrency?: number;
    /** Soft + hard budget caps. */
    budget?: JobBudget;
    /** Where failures route. Default "log". */
    onFail?: OnFailMode;
    /** Names of jobs that must have completed (most recent run = succeeded) before this one runs. */
    dependsOn?: string[];
    /** Default true. Set false to keep code but disable schedule. */
    enabled?: boolean;
    /** Free-form description shown in /jobs. */
    description?: string;
}

export interface JobCtx {
    invokedBy: "cron" | "manual" | "dependency";
    correlationId: string;
    log: (msg: string) => void;
    signal: AbortSignal;
}

const _registry = new Map<string, Required<Pick<JobDef, "name" | "schedule" | "tz" | "concurrency" | "enabled">> & JobDef>();

export function defineJob(def: JobDef): void {
    if (!def.name || typeof def.name !== "string") throw new Error("defineJob: name required");
    if (!def.schedule || typeof def.schedule !== "string") throw new Error("defineJob: schedule required");
    if (_registry.has(def.name)) throw new Error(`defineJob: "${def.name}" already registered`);
    _registry.set(def.name, {
        ...def,
        tz: def.tz ?? "America/Denver",
        concurrency: def.concurrency ?? 1,
        enabled: def.enabled ?? true,
    });
}

export function getJob(name: string) {
    return _registry.get(name);
}

export function listJobs() {
    return [..._registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test-only. */
export function _resetRegistry() {
    _registry.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/cron/registry.test.ts
```
Expected: 5 passing.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cron/registry.ts src/cron/registry.test.ts
git commit -m "feat(cron): add typed defineJob registry with concurrency/budget/onFail/dependsOn"
```

---

## Task 3: Create `src/cron/history.ts` — `cron_runs` writer

**Files:**
- Create: `src/cron/history.ts`
- Test: `src/cron/history.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/cron/history.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn();
const updateMock = vi.fn();
const eqMock = vi.fn();
const fromMock = vi.fn();

vi.mock("../lib/supabase", () => ({
    createClient: () => ({
        from: fromMock,
    }),
}));

beforeEach(() => {
    insertMock.mockReset();
    updateMock.mockReset();
    eqMock.mockReset();
    fromMock.mockReset();
    insertMock.mockResolvedValue({ data: [{ id: 99 }], error: null });
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ insert: insertMock.mockReturnValue({ select: () => ({ single: () => insertMock() }) }), update: updateMock });
});

describe("cron history", () => {
    it("recordStart inserts a row with status=running and returns the id", async () => {
        // We mock supabase such that .from('cron_runs').insert(...).select().single() returns { data: { id: 99 } }
        const fakeSelect = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 99 }, error: null }) });
        const fakeInsert = vi.fn().mockReturnValue({ select: fakeSelect });
        fromMock.mockReturnValue({ insert: fakeInsert, update: updateMock });

        const { recordStart } = await import("./history");
        const id = await recordStart({ jobName: "x", invokedBy: "cron", correlationId: "abc" });
        expect(id).toBe(99);
        expect(fakeInsert).toHaveBeenCalledWith(expect.objectContaining({
            job_name: "x", status: "running", invoked_by: "cron",
        }));
    });

    it("recordEnd updates the row with status, ended_at, duration_ms", async () => {
        const fakeEq = vi.fn().mockResolvedValue({ data: null, error: null });
        const fakeUpdate = vi.fn().mockReturnValue({ eq: fakeEq });
        fromMock.mockReturnValue({ insert: vi.fn(), update: fakeUpdate });

        const { recordEnd } = await import("./history");
        await recordEnd({ id: 99, status: "succeeded", durationMs: 1234 });
        expect(fakeUpdate).toHaveBeenCalledWith(expect.objectContaining({
            status: "succeeded", duration_ms: 1234,
        }));
        expect(fakeEq).toHaveBeenCalledWith("id", 99);
    });

    it("recordStart returns null and does not throw when supabase fails", async () => {
        const fakeSelect = vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } }) });
        const fakeInsert = vi.fn().mockReturnValue({ select: fakeSelect });
        fromMock.mockReturnValue({ insert: fakeInsert, update: updateMock });

        const { recordStart } = await import("./history");
        const id = await recordStart({ jobName: "x", invokedBy: "cron", correlationId: "abc" });
        expect(id).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cron/history.test.ts
```
Expected: FAIL — module `./history` cannot be found.

- [ ] **Step 3: Write the history writer**

```ts
// src/cron/history.ts
/**
 * @file    history.ts
 * @purpose Best-effort writer for the cron_runs table. Records every tick's
 *          start, end, duration, status, and failure reason.
 *
 *          All writes are best-effort: a Supabase outage must not block the
 *          tick from running. recordStart returns null on failure; recordEnd
 *          silently no-ops if id is null.
 */

import { createClient } from "../lib/supabase";

export type CronRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface RecordStartArgs {
    jobName: string;
    invokedBy: "cron" | "manual" | "dependency";
    correlationId: string;
    metadata?: Record<string, unknown>;
}

export interface RecordEndArgs {
    id: number | null;
    status: CronRunStatus;
    durationMs?: number;
    failureReason?: string;
    failureMessage?: string;
    metadata?: Record<string, unknown>;
}

export async function recordStart(args: RecordStartArgs): Promise<number | null> {
    const db = createClient();
    if (!db) return null;
    try {
        const { data, error } = await db
            .from("cron_runs")
            .insert({
                job_name: args.jobName,
                status: "running",
                invoked_by: args.invokedBy,
                metadata_jsonb: { correlationId: args.correlationId, ...args.metadata },
            })
            .select("id")
            .single();
        if (error) {
            console.warn(`[cron-history] recordStart failed: ${error.message}`);
            return null;
        }
        return data?.id ?? null;
    } catch (err: any) {
        console.warn(`[cron-history] recordStart exception: ${err.message}`);
        return null;
    }
}

export async function recordEnd(args: RecordEndArgs): Promise<void> {
    if (args.id == null) return;
    const db = createClient();
    if (!db) return;
    try {
        const { error } = await db
            .from("cron_runs")
            .update({
                status: args.status,
                ended_at: new Date().toISOString(),
                duration_ms: args.durationMs,
                failure_reason: args.failureReason,
                failure_message: args.failureMessage,
                metadata_jsonb: args.metadata,
            })
            .eq("id", args.id);
        if (error) console.warn(`[cron-history] recordEnd failed: ${error.message}`);
    } catch (err: any) {
        console.warn(`[cron-history] recordEnd exception: ${err.message}`);
    }
}

export async function lastRun(jobName: string): Promise<{
    id: number;
    started_at: string;
    ended_at: string | null;
    status: CronRunStatus;
    duration_ms: number | null;
    failure_message: string | null;
} | null> {
    const db = createClient();
    if (!db) return null;
    try {
        const { data, error } = await db
            .from("cron_runs")
            .select("id, started_at, ended_at, status, duration_ms, failure_message")
            .eq("job_name", jobName)
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            console.warn(`[cron-history] lastRun failed: ${error.message}`);
            return null;
        }
        return data as any;
    } catch (err: any) {
        console.warn(`[cron-history] lastRun exception: ${err.message}`);
        return null;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/cron/history.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/cron/history.ts src/cron/history.test.ts
git commit -m "feat(cron): cron_runs writer with start/end/lastRun helpers (best-effort)"
```

---

## Task 4: Create `src/cron/runner.ts` — node-cron + bottleneck wiring

**Files:**
- Create: `src/cron/runner.ts`
- Test: `src/cron/runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/cron/runner.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineJob, _resetRegistry } from "./registry";
import { runJobOnce } from "./runner";

vi.mock("./history", () => ({
    recordStart: vi.fn().mockResolvedValue(1),
    recordEnd: vi.fn().mockResolvedValue(undefined),
    lastRun: vi.fn().mockResolvedValue({ status: "succeeded", started_at: new Date().toISOString() }),
}));

describe("runner.runJobOnce", () => {
    beforeEach(() => { _resetRegistry(); vi.clearAllMocks(); });

    it("invokes the handler and reports succeeded", async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        defineJob({ name: "ok", schedule: "* * * * *", handler });
        const result = await runJobOnce("ok", "manual");
        expect(result.status).toBe("succeeded");
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("captures handler errors and reports failed with onFail=log", async () => {
        const handler = vi.fn().mockRejectedValue(new Error("boom"));
        defineJob({ name: "boom", schedule: "* * * * *", handler, onFail: "log" });
        const result = await runJobOnce("boom", "manual");
        expect(result.status).toBe("failed");
        expect(result.failureMessage).toContain("boom");
    });

    it("respects concurrency=1 — second concurrent call is rejected with status=skipped", async () => {
        let resolveFirst!: () => void;
        const handler = vi.fn().mockImplementation(() => new Promise<void>(r => { resolveFirst = r; }));
        defineJob({ name: "lock", schedule: "* * * * *", handler, concurrency: 1 });
        const first = runJobOnce("lock", "manual");
        const second = await runJobOnce("lock", "manual");
        expect(second.status).toBe("skipped");
        expect(second.failureReason).toBe("concurrency-locked");
        resolveFirst();
        await first;
    });

    it("aborts the handler if budget.durationMs is exceeded", async () => {
        const handler = vi.fn().mockImplementation((ctx: any) =>
            new Promise<void>((_, reject) => {
                ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
            })
        );
        defineJob({ name: "slow", schedule: "* * * * *", handler, budget: { durationMs: 50 } });
        const result = await runJobOnce("slow", "manual");
        expect(result.status).toBe("failed");
        expect(result.failureReason).toBe("duration-exceeded");
    });

    it("dependsOn: skips with status=skipped if dependency's last run did not succeed", async () => {
        const { lastRun } = await import("./history");
        (lastRun as any).mockResolvedValueOnce({ status: "failed", started_at: new Date().toISOString() });
        defineJob({ name: "dep-job", schedule: "* * * * *", handler: async () => {}, dependsOn: ["upstream"] });
        const result = await runJobOnce("dep-job", "cron");
        expect(result.status).toBe("skipped");
        expect(result.failureReason).toBe("dependency-not-succeeded");
    });

    it("returns status=skipped if job is disabled", async () => {
        const handler = vi.fn();
        defineJob({ name: "off", schedule: "* * * * *", handler, enabled: false });
        const result = await runJobOnce("off", "cron");
        expect(result.status).toBe("skipped");
        expect(result.failureReason).toBe("disabled");
        expect(handler).not.toHaveBeenCalled();
    });

    it("throws if job name not registered", async () => {
        await expect(runJobOnce("missing", "manual")).rejects.toThrow(/not registered/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/cron/runner.test.ts
```
Expected: FAIL — module `./runner` cannot be found.

- [ ] **Step 3: Write the runner**

```ts
// src/cron/runner.ts
/**
 * @file    runner.ts
 * @purpose Two responsibilities:
 *
 *   1. startCronRunner() — at boot, walks the registry and schedules every
 *      enabled job via node-cron. Wires up concurrency locking via Bottleneck.
 *
 *   2. runJobOnce(name, invokedBy) — invokes a job synchronously, applying
 *      every guardrail (enabled, dependsOn, concurrency, duration budget,
 *      onFail routing, history). Used by the cron callbacks AND by the /run
 *      Telegram command for manual invocation.
 *
 * The two share the same guardrails so cron and manual invocations behave
 * identically. Manual /run respects concurrency locks; cron tick can be
 * forced manually via /run.
 */

import cron from "node-cron";
import Bottleneck from "bottleneck";

import { getJob, listJobs } from "./registry";
import { recordStart, recordEnd, lastRun, type CronRunStatus } from "./history";

// One Bottleneck per job, instantiated lazily. concurrency comes from JobDef.
const _limiters = new Map<string, Bottleneck>();
function limiterFor(jobName: string, concurrency: number): Bottleneck {
    let limiter = _limiters.get(jobName);
    if (!limiter) {
        limiter = new Bottleneck({ maxConcurrent: concurrency, highWater: 0, strategy: Bottleneck.strategy.OVERFLOW });
        _limiters.set(jobName, limiter);
    }
    return limiter;
}

export interface RunResult {
    status: CronRunStatus;
    durationMs: number;
    failureReason?: string;
    failureMessage?: string;
}

export async function runJobOnce(
    jobName: string,
    invokedBy: "cron" | "manual" | "dependency",
): Promise<RunResult> {
    const job = getJob(jobName);
    if (!job) throw new Error(`runJobOnce: "${jobName}" not registered`);

    if (!job.enabled) {
        return { status: "skipped", durationMs: 0, failureReason: "disabled" };
    }

    // dependsOn check — every named upstream must have its most recent run succeed.
    if (job.dependsOn && job.dependsOn.length > 0) {
        for (const upstream of job.dependsOn) {
            const last = await lastRun(upstream);
            if (!last || last.status !== "succeeded") {
                return {
                    status: "skipped",
                    durationMs: 0,
                    failureReason: "dependency-not-succeeded",
                    failureMessage: `upstream "${upstream}" status=${last?.status ?? "no-history"}`,
                };
            }
        }
    }

    const limiter = limiterFor(jobName, job.concurrency);
    if (limiter.counts().EXECUTING >= job.concurrency) {
        return { status: "skipped", durationMs: 0, failureReason: "concurrency-locked" };
    }

    const correlationId = `${jobName}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const startMs = Date.now();
    const historyId = await recordStart({ jobName, invokedBy, correlationId });

    const ac = new AbortController();
    let durationTimer: NodeJS.Timeout | undefined;
    let result: RunResult;

    try {
        if (job.budget?.durationMs) {
            durationTimer = setTimeout(() => ac.abort(new Error("duration-exceeded")), job.budget.durationMs);
        }
        await limiter.schedule(() => job.handler({
            invokedBy,
            correlationId,
            log: (msg) => console.log(`[cron:${jobName}] ${msg}`),
            signal: ac.signal,
        }));
        result = { status: "succeeded", durationMs: Date.now() - startMs };
    } catch (err: any) {
        const aborted = ac.signal.aborted;
        result = {
            status: "failed",
            durationMs: Date.now() - startMs,
            failureReason: aborted ? "duration-exceeded" : "handler-threw",
            failureMessage: err?.message ?? String(err),
        };
        await routeFailure(jobName, job.onFail ?? "log", result);
    } finally {
        if (durationTimer) clearTimeout(durationTimer);
    }

    await recordEnd({
        id: historyId,
        status: result.status,
        durationMs: result.durationMs,
        failureReason: result.failureReason,
        failureMessage: result.failureMessage,
    });

    return result;
}

async function routeFailure(jobName: string, mode: string, result: RunResult): Promise<void> {
    if (mode === "silent") return;
    if (mode === "log") {
        console.warn(`[cron:${jobName}] FAILED ${result.failureReason}: ${result.failureMessage}`);
        return;
    }
    if (mode === "escalate-to-supervisor") {
        try {
            const { agentTask } = await import("../lib/intelligence/agent-task");
            await agentTask.upsertFromSource({
                source: "cron",
                source_id: `${jobName}-${Date.now()}`,
                kind: "cron_failure",
                title: `Cron ${jobName} failed: ${result.failureReason}`,
                details: result.failureMessage ?? "",
                priority: "medium",
                owner: "aria",
            });
        } catch (err: any) {
            console.warn(`[cron:${jobName}] supervisor escalation failed: ${err.message}`);
        }
        return;
    }
    if (mode === "telegram-will") {
        try {
            // Best-effort import — bot may not be initialized in some runtimes (e.g. Next.js dashboard)
            const { sendTelegramMessage } = await import("../lib/intelligence/telegram-helper");
            await sendTelegramMessage(`⚠️ Cron *${jobName}* failed: ${result.failureReason}\n${result.failureMessage}`);
        } catch (err: any) {
            console.warn(`[cron:${jobName}] telegram-will failed: ${err.message}`);
        }
        return;
    }
}

/** Schedule every enabled registered job via node-cron. Idempotent — safe to call once at boot. */
let _started = false;
export function startCronRunner(): void {
    if (_started) {
        console.warn("[cron-runner] startCronRunner called twice; ignoring");
        return;
    }
    _started = true;
    for (const job of listJobs()) {
        if (!job.enabled) {
            console.log(`[cron-runner] ${job.name}: disabled, skipping schedule`);
            continue;
        }
        try {
            cron.schedule(job.schedule, () => { void runJobOnce(job.name, "cron"); }, { timezone: job.tz });
            console.log(`[cron-runner] ${job.name}: scheduled ${job.schedule} ${job.tz}`);
        } catch (err: any) {
            console.error(`[cron-runner] ${job.name}: schedule failed: ${err.message}`);
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/cron/runner.test.ts
```
Expected: 7 passing.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cron/runner.ts src/cron/runner.test.ts
git commit -m "feat(cron): runner with concurrency locking, duration budget, dependsOn, onFail routing"
```

---

## Task 5: Migrate `ops-manager.ts` jobs into the registry

**Why one task, not 12:** every job is a thin wrapper around a method that already exists on `OpsManager`. The migration is mechanical — `cron.schedule(expr, () => this.X())` becomes `defineJob({ schedule, handler: () => this.X() })`. Doing them all in one PR keeps the diff coherent.

**Files:**
- Create: `src/cron/jobs/index.ts`
- Modify: `src/lib/intelligence/ops-manager.ts:439-560` (delete inline `cron.schedule` block)
- Modify: `src/cli/start-bot.ts` (mount the runner once)
- Test: `src/cron/jobs/index.test.ts`

- [ ] **Step 1: Catalog every existing cron in ops-manager.ts**

Open [ops-manager.ts:439-560](src/lib/intelligence/ops-manager.ts#L439-L560) and list every `cron.schedule(...)` call with: name, schedule expr, tz, what method it calls. Save to a scratch file mentally — don't commit. This is the migration spec.

Expected catalog (verify against current file):
- `7:30 AM Mon-Fri` build risk → BuildRisk
- `8:00 AM daily` daily summary → DailySummary
- `8:01 AM Friday` weekly summary → WeeklySummary
- `Every 15 min` AP polling → APPolling
- `Hourly` ad cleanup → AdCleanup
- `Every 30 min` PO sync → POSync
- `Every 4h` PO sweep → POSweep
- `8:30 AM daily` qty calibration → QtyCalibration
- `9:00 AM daily` watchdog → MissingReconciliationWatchdog
- `Every 30 min` build completion → BuildCompletionWatcher
- `Every 30 min` PO receiving → POReceivingWatcher
- `Every 4h` purchasing calendar → PurchasingCalendarSync
- `Every 5 min` close finished → CloseFinishedTasks
- `Every 5 min` issue orchestrator (gated) → IssueOrchestrator
- `Hourly` stat indexing → StatIndexing
- `Mon 1 AM`, `Tue 1:30 AM`, etc. — vendor reconciliations

- [ ] **Step 2: Write the migration test**

```ts
// src/cron/jobs/index.test.ts
import { describe, it, expect } from "vitest";
import { listJobs } from "../registry";
import "./index";  // triggers all defineJob() calls

describe("registered jobs", () => {
    const jobs = listJobs();

    it("registers every ops-manager job", () => {
        const expected = [
            "build-risk", "daily-summary", "weekly-summary",
            "ap-polling", "ad-cleanup", "po-sync", "po-sweep",
            "qty-calibration", "missing-reconciliation-watchdog",
            "build-completion-watcher", "po-receiving-watcher",
            "purchasing-calendar-sync", "close-finished-tasks",
            "stat-indexing",
            // vendor reconciliations
            "reconcile-axiom", "reconcile-fedex", "reconcile-teraganix", "reconcile-uline", "reconcile-aaa",
        ];
        const names = jobs.map(j => j.name);
        for (const e of expected) {
            expect(names).toContain(e);
        }
    });

    it("every job has a valid 5-field cron schedule", () => {
        for (const j of jobs) {
            expect(j.schedule.split(/\s+/).length).toBe(5);
        }
    });

    it("every job has tz=America/Denver", () => {
        for (const j of jobs) {
            expect(j.tz).toBe("America/Denver");
        }
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/cron/jobs/index.test.ts
```
Expected: FAIL — module `./index` cannot be found, or expected jobs missing.

- [ ] **Step 4: Create `src/cron/jobs/index.ts` with all jobs**

Create the file with one `defineJob` call per current cron in ops-manager.ts. Example skeleton (full content matches the catalog from Step 1 — mirror schedules and handlers exactly):

```ts
// src/cron/jobs/index.ts
/**
 * @file Registers every Aria scheduled job. Imported once at bot boot
 *       (src/cli/start-bot.ts) before startCronRunner(). Each job is a thin
 *       handler that delegates to existing methods on OpsManager.
 */
import { defineJob } from "../registry";

// We import OpsManager lazily inside handlers to avoid pulling Telegraf into
// the cron module at import time (cron tests should be runnable without bot).
async function ops() {
    const { OpsManager } = await import("../../lib/intelligence/ops-manager");
    return OpsManager.singleton;
}

defineJob({
    name: "build-risk",
    description: "Daily build-risk analysis: BOMs vs stock vs open POs.",
    schedule: "30 7 * * 1-5",
    handler: async () => { (await ops()).runBuildRisk(); },
    onFail: "telegram-will",
});

defineJob({
    name: "daily-summary",
    description: "Morning summary across AP, POs, builds.",
    schedule: "0 8 * * *",
    handler: async () => { (await ops()).sendDailySummary(); },
    onFail: "log",
});

defineJob({
    name: "ap-polling",
    description: "Poll ap@ inbox for new invoices and route them.",
    schedule: "*/15 * * * *",
    handler: async () => { (await ops()).runAPPolling(); },
    budget: { durationMs: 120_000 },
    onFail: "log",
});

defineJob({
    name: "po-sync",
    description: "Walk label:PO Gmail outbox; update purchase_orders + tracking.",
    schedule: "0 */4 * * *",  // KAIZEN #4: was */30 — moved to 4h
    handler: async () => { (await ops()).runPOSync(); },
    budget: { durationMs: 180_000 },
    onFail: "log",
});

defineJob({
    name: "qty-calibration",
    description: "Daily 8:30 AM rec calibration + vendor stats recompute.",
    schedule: "30 8 * * *",
    handler: async () => { (await ops()).runQtyCalibration(); },
    budget: { finaleCalls: 60, durationMs: 90_000 },
    onFail: "escalate-to-supervisor",
});

defineJob({
    name: "missing-reconciliation-watchdog",
    description: "Alert if any vendor reconciliation hasn't run in 24h.",
    schedule: "0 9 * * 1-5",  // KAIZEN #6: was * * * — Mon-Fri only
    handler: async () => { (await ops()).runReconciliationWatchdog(); },
    onFail: "telegram-will",
});

// ... (continue with: weekly-summary, ad-cleanup, po-sweep, build-completion-watcher,
//      po-receiving-watcher, purchasing-calendar-sync, close-finished-tasks,
//      stat-indexing, and vendor reconciliations)
```

For every other cron in the catalog from Step 1, add a `defineJob` block. **Do not change schedules** in this step — kaizen schedule edits land in Task 7. Only the two clearly tagged here (`po-sync` to 4h, `missing-reconciliation-watchdog` to Mon-Fri) ride along since they are commented inline.

- [ ] **Step 5: Add singleton accessor + extracted methods to OpsManager**

`OpsManager` currently keeps logic inline in `cron.schedule` callbacks. Extract each callback body into a named method (`runBuildRisk()`, `runAPPolling()`, etc.) and add a `static singleton: OpsManager` field set in the constructor. The methods are public so `cron/jobs/index.ts` can call them.

Modify [ops-manager.ts:439-560](src/lib/intelligence/ops-manager.ts#L439-L560): delete every `cron.schedule(...)` call. Move each callback body into a named method. Set `OpsManager.singleton = this` in the constructor.

- [ ] **Step 6: Mount the runner in `start-bot.ts`**

Modify `src/cli/start-bot.ts` near where OpsManager is instantiated:

```ts
// Old:
const opsManager = new OpsManager(bot);
opsManager.start();

// New:
const opsManager = new OpsManager(bot);
opsManager.start();   // OpsManager.start() should now do nothing schedule-related — only one-time setup
import("../cron/jobs").then(() => {
    import("../cron/runner").then(({ startCronRunner }) => startCronRunner());
});
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
npx vitest run src/cron/jobs/index.test.ts
```
Expected: 3 passing.

- [ ] **Step 8: Type-check the whole CLI surface**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"
```
Expected: no output.

- [ ] **Step 9: Smoke verify by reading current and migrated job count**

```bash
grep -c "cron.schedule(" src/lib/intelligence/ops-manager.ts || echo "zero"
grep -c "defineJob(" src/cron/jobs/index.ts
```
Expected: `zero` (or 0) for ops-manager, ~14-16 for jobs/index.

- [ ] **Step 10: Commit**

```bash
git add src/cron/jobs/ src/lib/intelligence/ops-manager.ts src/cli/start-bot.ts
git commit -m "refactor(cron): migrate ops-manager.ts jobs into defineJob registry

KAIZEN #4: po-sync 30m → 4h
KAIZEN #6: watchdog Mon-Fri only"
```

---

## Task 6: Add `/jobs` Telegram command

**Files:**
- Modify: `src/cli/start-bot.ts` (add tool definition + handler)

- [ ] **Step 1: Add the OpenAI tool definition**

In `start-bot.ts`, find the `tools` array and add:

```ts
{
    type: "function",
    function: {
        name: "list_cron_jobs",
        description: "List every registered Aria cron job with status, schedule, last run, and last result.",
        parameters: {
            type: "object",
            properties: {
                filter: { type: "string", description: "Optional substring to filter job names" },
            },
        },
    },
},
```

- [ ] **Step 2: Add the handler**

In the tool-call dispatcher switch:

```ts
case "list_cron_jobs": {
    const { listJobs } = await import("../cron/registry");
    const { lastRun } = await import("../cron/history");
    const filter = (args.filter ?? "").toString().toLowerCase();
    const jobs = listJobs().filter(j => !filter || j.name.toLowerCase().includes(filter));

    const rows = await Promise.all(jobs.map(async j => {
        const last = await lastRun(j.name);
        const lastStr = last
            ? `${last.status} (${last.duration_ms ?? "?"}ms, ${new Date(last.started_at).toLocaleString("en-US", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" })})`
            : "never";
        const enabled = j.enabled ? "✓" : "✗";
        return `${enabled} *${j.name}* — ${j.schedule}\n   last: ${lastStr}`;
    }));

    return rows.join("\n\n") || "No jobs registered.";
}
```

- [ ] **Step 3: Manual smoke test**

```bash
pm2 restart aria-bot
# In Telegram: send "/jobs"
```
Expected: a list of all registered jobs with last-run status. (Or just "list jobs" — the bot will route via the tool.)

- [ ] **Step 4: Commit**

```bash
git add src/cli/start-bot.ts
git commit -m "feat(cron): add /jobs (list_cron_jobs) Telegram tool"
```

---

## Task 7: Add `/run <job-name>` Telegram command + apply remaining schedule kaizens

**Files:**
- Modify: `src/cli/start-bot.ts` (add tool + handler)
- Modify: `src/cron/jobs/index.ts` (any remaining schedule edits)

- [ ] **Step 1: Add `/run` tool definition**

```ts
{
    type: "function",
    function: {
        name: "run_cron_job",
        description: "Manually trigger a registered Aria cron job. Respects the same concurrency lock and budget as the scheduled tick.",
        parameters: {
            type: "object",
            properties: {
                job_name: { type: "string", description: "The exact job name (use list_cron_jobs to discover)" },
            },
            required: ["job_name"],
        },
    },
},
```

- [ ] **Step 2: Add handler**

```ts
case "run_cron_job": {
    const { runJobOnce } = await import("../cron/runner");
    const result = await runJobOnce(args.job_name, "manual");
    return `${result.status}${result.failureReason ? ` (${result.failureReason})` : ""} — ${result.durationMs}ms`;
}
```

- [ ] **Step 3: Apply kaizen #5 — fold POSweep into APPolling**

Edit `src/cron/jobs/index.ts`: delete the `po-sweep` job. Modify the `ap-polling` job's handler to call the existing POSweep logic as a post-pass:

```ts
defineJob({
    name: "ap-polling",
    schedule: "*/15 * * * *",
    handler: async () => {
        const o = await ops();
        await o.runAPPolling();
        await o.runPOSweepPostPass();  // KAIZEN #5: was its own */4h cron
    },
    budget: { durationMs: 150_000 },  // bumped from 120s for the post-pass
    onFail: "log",
});
```

If `runPOSweepPostPass` doesn't exist on OpsManager, extract it from the deleted `po-sweep` cron's body during this edit.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | head
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/cli/start-bot.ts src/cron/jobs/index.ts src/lib/intelligence/ops-manager.ts
git commit -m "feat(cron): /run <job> Telegram command; KAIZEN #5 fold po-sweep into ap-polling"
```

---

## Task 8: Kaizen #1 — central prompt caching in `llm.ts`

**Files:**
- Modify: `src/lib/intelligence/llm.ts`
- Test: `src/lib/intelligence/llm.test.ts`

**Background:** Five hot paths re-send identical 200-800-token system prompts every call. Anthropic supports `cache_control: { type: "ephemeral" }` for ~90% input-cost reduction on repeated system blocks. We add the option to the central wrappers so every callsite benefits without remembering.

- [ ] **Step 1: Read existing `llm.ts` to find `unifiedTextGeneration` and `unifiedObjectGeneration`**

```bash
grep -n "export async function unified" src/lib/intelligence/llm.ts
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/intelligence/llm.test.ts (append)
import { describe, it, expect, vi } from "vitest";

describe("unifiedTextGeneration cacheControl", () => {
    it("when cacheControl='ephemeral' and provider=anthropic, the system block is sent with cache_control", async () => {
        // We inject a mock anthropic SDK and verify the messages payload.
        // Skip if your existing tests use a different mocking shape — adapt.
        const captured: any[] = [];
        vi.doMock("@ai-sdk/anthropic", () => ({
            anthropic: () => ({
                doGenerate: async (opts: any) => { captured.push(opts); return { text: "ok", usage: {} }; },
            }),
        }));
        // ... call unifiedTextGeneration({ system: "x".repeat(300), prompt: "hi", cacheControl: "ephemeral" })
        // ... assert that captured[0].messages or system carries cache_control marker
    });
});
```

NOTE: the exact mocking shape depends on whether `llm.ts` uses Vercel AI SDK or raw Anthropic SDK. If the test is hard to write because of the SDK shape, **simplify**: add a unit test on a pure helper that builds the system block, and let integration testing happen in production.

A simpler pure-helper test:

```ts
import { buildSystemBlock } from "./llm";  // we'll extract this helper

it("buildSystemBlock returns plain string when no cache requested", () => {
    expect(buildSystemBlock("hello", "off")).toBe("hello");
});
it("buildSystemBlock returns Anthropic-shaped block array when cache='ephemeral'", () => {
    const block = buildSystemBlock("hello", "ephemeral");
    expect(block).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/lib/intelligence/llm.test.ts
```
Expected: FAIL — `buildSystemBlock` not exported.

- [ ] **Step 4: Add `buildSystemBlock` and the `cacheControl` option**

In `src/lib/intelligence/llm.ts`:

```ts
export type CacheControl = "off" | "ephemeral";

/**
 * Build a system parameter for Anthropic. When cacheControl='ephemeral' and the
 * system text is large enough to benefit, returns the structured block array
 * with cache_control marker. Otherwise returns the plain string.
 *
 * Anthropic's cache_control is a no-op for blocks <1024 tokens, so we only
 * apply it above that threshold to avoid sending the marker for short prompts.
 */
export function buildSystemBlock(systemText: string, cacheControl: CacheControl): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
    if (cacheControl !== "ephemeral") return systemText;
    return [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
}
```

Then update `unifiedTextGeneration` and `unifiedObjectGeneration` signatures to accept an optional `cacheControl?: CacheControl` parameter (default `"off"`), and pass `buildSystemBlock(systemText, cacheControl)` as the system parameter to the underlying Anthropic call.

For the OpenAI / Gemini fallbacks, ignore the flag (no cache_control equivalent).

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/lib/intelligence/llm.test.ts
```
Expected: PASS.

- [ ] **Step 6: Enable on the 5 hot paths**

For each callsite below, change the call to pass `cacheControl: "ephemeral"`:

1. [src/lib/pdf/invoice-parser.ts:57-90](src/lib/pdf/invoice-parser.ts#L57-L90) — `INVOICE_SYSTEM_PROMPT`
2. [src/lib/pdf/extractor.ts:116-117](src/lib/pdf/extractor.ts#L116-L117) — `SCANNED_PDF_SYSTEM`
3. [src/cli/start-bot.ts:442-464](src/cli/start-bot.ts#L442-L464) — file-upload analyzer
4. [src/lib/intelligence/nightshift-agent.ts:105-123](src/lib/intelligence/nightshift-agent.ts#L105-L123) — classification prompt (note: this uses raw Anthropic SDK, may need direct cache_control on the messages payload)
5. [src/app/api/dashboard/chat/route.ts:10-20](src/app/api/dashboard/chat/route.ts#L10-L20) — Gemini Flash; SKIP, Gemini does not support cache_control. Note in the PR.

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | head
```
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/lib/intelligence/llm.ts src/lib/intelligence/llm.test.ts \
        src/lib/pdf/invoice-parser.ts src/lib/pdf/extractor.ts \
        src/cli/start-bot.ts src/lib/intelligence/nightshift-agent.ts
git commit -m "feat(llm): central cacheControl flag; enable on 4 hot paths

KAIZEN #1: prompt caching via Anthropic cache_control. Reduces input cost
~90% on repeated system blocks. Gemini path skipped (no equivalent)."
```

---

## Task 9: Kaizen #3 — declarative dependsOn for nightshift → AP

**Files:**
- Modify: `src/cron/jobs/index.ts` (add a `nightshift-classify` job + dependsOn on `ap-polling`)
- Modify: `src/lib/intelligence/workers/ap-identifier.ts` (honor pre-classification when present)

- [ ] **Step 1: Add a nightshift-classify job to the registry**

If nightshift currently runs as a separate process via Windows Task Scheduler, add a wrapper job so the cron registry can express the dependency. Keep the actual schedule pointed at the same overnight window:

```ts
defineJob({
    name: "nightshift-classify",
    description: "Overnight Haiku pre-classification of AP inbox emails.",
    schedule: "5 18 * * 1-5",       // 6:05 PM Mon-Fri (matches existing Task Scheduler)
    handler: async () => {
        const { runNightshiftOnce } = await import("../../lib/intelligence/nightshift-agent");
        await runNightshiftOnce();
    },
    budget: { durationMs: 8 * 60 * 60_000 },  // up to 8h
    onFail: "log",
});
```

(If `runNightshiftOnce` doesn't exist on `nightshift-agent.ts`, extract it from `nightshift-runner.ts`.)

- [ ] **Step 2: Add `dependsOn` to `ap-polling`'s morning tick**

The 8 AM ap-polling tick should skip its expensive Sonnet pass if `nightshift-classify` failed. We split into two scheduled entries — frequent-and-light (every 15 min) and once-at-8AM-and-deep — so dependency only gates the deep pass:

```ts
defineJob({
    name: "ap-polling",
    schedule: "*/15 * * * *",
    handler: async () => { (await ops()).runAPPolling(); (await ops()).runPOSweepPostPass(); },
    budget: { durationMs: 150_000 },
});

defineJob({
    name: "ap-morning-deep",
    description: "8 AM deep AP sweep that consumes nightshift's pre-classifications.",
    schedule: "0 8 * * *",
    handler: async () => { (await ops()).runAPMorningDeep(); },
    dependsOn: ["nightshift-classify"],
    budget: { durationMs: 600_000 },
    onFail: "telegram-will",
});
```

- [ ] **Step 3: Modify `ap-identifier.ts` to actually honor pre-classification**

In [ap-identifier.ts:140-178](src/lib/intelligence/workers/ap-identifier.ts#L140-L178), find where `getPreClassification()` is called and the path that uses Sonnet. Ensure: if pre-classification confidence ≥ 0.7 AND label is one we trust (ADVERTISEMENT, INVOICE, STATEMENT, HUMAN_INTERACTION), the function returns the pre-classified label without calling Sonnet at all.

Add a unit test for the new behavior:

```ts
// src/lib/intelligence/workers/ap-identifier.test.ts (append)
it("honors pre-classification with confidence >= 0.7 without calling Sonnet", async () => {
    const sonnetSpy = vi.spyOn(/* the unified call */).mockImplementation(() => { throw new Error("should not call"); });
    /* arrange: getPreClassification returns { label: "ADVERTISEMENT", confidence: 0.85 } */
    const result = await classifyEmailIntent(/* ... */);
    expect(sonnetSpy).not.toHaveBeenCalled();
    expect(result.label).toBe("ADVERTISEMENT");
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/intelligence/workers/ap-identifier.test.ts src/cron/
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cron/jobs/index.ts src/lib/intelligence/workers/ap-identifier.ts src/lib/intelligence/workers/ap-identifier.test.ts
git commit -m "feat(cron): dependsOn nightshift-classify; ap-identifier honors pre-class

KAIZEN #3: 8 AM deep AP sweep skips if nightshift failed. ap-identifier
trusts Haiku pre-classification (conf >= 0.7) and skips paid Sonnet call."
```

---

## Task 10: Kaizen #2 + #7 — pre-warm vendor caches + Promise.all in active-purchases

**Files:**
- Modify: `src/lib/purchasing/active-purchases.ts`
- Test: `src/lib/purchasing/active-purchases.test.ts` (existing)

- [ ] **Step 1: Open `active-purchases.ts` and locate the per-PO loop**

Reference: [active-purchases.ts:135](src/lib/purchasing/active-purchases.ts#L135) (`leadTimeService.getForVendor` per PO) and [active-purchases.ts:49-77](src/lib/purchasing/active-purchases.ts#L49-L77) (sequential Supabase queries inside chunk loop).

- [ ] **Step 2: Pre-warm vendor caches before the PO loop**

```ts
// Before the PO loop:
const uniqueVendors = [...new Set(pos.map(p => p.vendorName).filter(Boolean))];
await Promise.all(uniqueVendors.map(v => leadTimeService.getForVendor(v)));
// Now the loop's per-PO getForVendor calls hit cache and return synchronously.
```

- [ ] **Step 3: Parallelize the chunked Supabase queries with Promise.all**

```ts
// Inside the chunk loop, replace:
const { data: dbPos } = await supabase.from("purchase_orders")...;
const { data: poSends } = await supabase.from("po_sends")...;

// With:
const [poRes, sendRes] = await Promise.all([
    supabase.from("purchase_orders")...,
    supabase.from("po_sends")...,
]);
const { data: dbPos } = poRes;
const { data: poSends } = sendRes;
```

- [ ] **Step 4: Run existing tests**

```bash
npx vitest run src/lib/purchasing/active-purchases.test.ts
```
Expected: existing tests still pass.

- [ ] **Step 5: Smoke check via the API**

```bash
npm run dev > /tmp/dev.log 2>&1 &
sleep 12
time curl -sS --max-time 60 http://localhost:3000/api/dashboard/active-purchases > /dev/null
```
Expected: noticeably faster than baseline (network-dependent — at least no slower).

Stop the dev server: `netstat -ano | grep ":3000.*LISTENING" | awk '{print $NF}' | xargs -r -I{} taskkill //F //PID {}`

- [ ] **Step 6: Commit**

```bash
git add src/lib/purchasing/active-purchases.ts
git commit -m "perf(purchasing): pre-warm vendor cache + parallelize Supabase chunks

KAIZEN #2: hoist getForVendor() out of PO loop, ~95 redundant awaits removed
KAIZEN #7: Promise.all on purchase_orders + po_sends per chunk"
```

---

## Task 11: Kaizen #8 — PDF base64 cache by file hash

**Files:**
- Modify: `src/lib/pdf/extractor.ts`
- Test: `src/lib/pdf/extractor.test.ts`

- [ ] **Step 1: Open extractor.ts and find the strategy cascade**

Reference: [extractor.ts:131-156](src/lib/pdf/extractor.ts#L131-L156). The four strategies each re-encode the buffer to base64.

- [ ] **Step 2: Add a per-extraction base64 memoizer**

```ts
// At the top of the cascade function:
let _base64: string | undefined;
const toBase64 = () => {
    if (_base64) return _base64;
    _base64 = buffer.toString("base64");
    return _base64;
};
```

Replace every `buffer.toString("base64")` inside the cascade with `toBase64()`. The first strategy that needs it pays the encoding cost; subsequent strategies reuse the cached string.

- [ ] **Step 3: (Optional) cross-call cache by SHA-256**

If we want to cache across calls (same PDF processed twice), add a module-level Map with crypto.subtle SHA-256 keys. Cap size at 50 entries (LRU). **Defer** this if the in-extraction cache from Step 2 is sufficient — most invoices are processed once.

- [ ] **Step 4: Run extractor tests if any exist**

```bash
ls src/lib/pdf/*.test.ts 2>/dev/null
```
If there are existing tests, run them. If none, smoke-test by running the AP test:

```bash
node --import tsx src/cli/test-ap-pipeline.ts || true
```
Expected: extraction still works on a sample PDF.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf/extractor.ts
git commit -m "perf(pdf): memoize base64 encoding across the strategy cascade

KAIZEN #8: each strategy reuses the same base64 string instead of
re-encoding from buffer. Saves ~300ms latency on multi-strategy fallbacks."
```

---

## Task 12: Kaizen #9 — batch backfillPOSentVerificationFromGmail

**Files:**
- Modify: `src/lib/intelligence/po-correlator.ts`
- Test: `src/lib/intelligence/po-correlator.test.ts` (or create)

- [ ] **Step 1: Open the function and find the per-record loop**

Reference: [po-correlator.ts:310-396](src/lib/intelligence/po-correlator.ts#L310-L396). For each record, fetches existing PO, checks, then upserts. 100 records = 200 queries.

- [ ] **Step 2: Replace with one batch SELECT + one batch UPSERT**

```ts
// Before the loop:
const allPONumbers = records.map(r => r.poNumber);
const { data: existing } = await supabase
    .from("purchase_orders")
    .select("po_number, po_sent_verified_at, po_sent_verified_source")
    .in("po_number", allPONumbers);
const existingByPO = new Map((existing ?? []).map(e => [e.po_number, e]));

// Build the upsert rows in one pass:
const toUpsert: any[] = [];
for (const r of records) {
    const cur = existingByPO.get(r.poNumber);
    if (cur?.po_sent_verified_at && cur.po_sent_verified_source !== "manual") continue;
    toUpsert.push({
        po_number: r.poNumber,
        po_sent_verified_at: r.sentAt,
        po_sent_verified_source: "po_correlator",
        po_sent_verified_evidence: { /* ... */ },
    });
}

if (toUpsert.length > 0) {
    await supabase.from("purchase_orders").upsert(toUpsert);
}
```

- [ ] **Step 3: Run the backfill CLI smoke test (dry-run if supported, otherwise tiny window)**

```bash
node --import tsx src/cli/backfill-po-sent-verification.ts 7 50
```
Expected: completes much faster than before; same number of POs verified.

- [ ] **Step 4: Commit**

```bash
git add src/lib/intelligence/po-correlator.ts
git commit -m "perf(po-correlator): batch backfill SELECT + UPSERT (~98% fewer queries)

KAIZEN #9: was 100 SELECT + 100 UPSERT for 50 records; now 1 of each."
```

---

## Task 13: Kaizen #12 — DailySummary stub completion

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts` (`sendDailySummary` method)

**Decision:** keep the cron, fill in the stub. Will values morning visibility into AP + PO + build state.

- [ ] **Step 1: Read the existing `sendDailySummary`**

```bash
grep -n "sendDailySummary\|formatMorningApBlock" src/lib/intelligence/ops-manager.ts | head
```

- [ ] **Step 2: Extend the body to include**

A simple morning digest with these blocks (each a 1-2 line summary):

1. **AP** — already there (`formatMorningApBlock`)
2. **POs in flight** — count by lifecycle stage (sent, acked, shipped, received-pending-receipt). Use `loadActivePurchases()` from `src/lib/purchasing/active-purchases.ts`.
3. **Builds today** — count of build calendar events for the next 24h. Use `getUpcomingBuilds()` if it exists, else skip.
4. **Open agent_task hub items needing Will** — count of `status='needs_approval'` rows. Use `agentTask.list({ ownerIs: 'will' })`.

If any block fails, fall back to a one-line "<block>: error" so the summary always sends.

- [ ] **Step 3: Smoke run via /run**

```bash
# After Tasks 6+7 land, in Telegram:
# "/run daily-summary"
```
Or call directly:
```bash
node --import tsx -e "import('./src/lib/intelligence/ops-manager.js').then(m => (new m.OpsManager()).sendDailySummary())"
```
Expected: a multi-block Telegram message hits Will's chat.

- [ ] **Step 4: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts
git commit -m "feat(ops): complete sendDailySummary stub with PO+builds+tasks blocks

KAIZEN #12: was AP-block-only stub. Now includes lifecycle PO counts,
upcoming builds, and tasks awaiting Will."
```

---

## Task 14: Final integration check + plan-completion commit

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: all green.

- [ ] **Step 2: Type-check both configs**

```bash
npx tsc --noEmit --project tsconfig.cli.json 2>&1 | grep "error TS" | head
npx tsc --noEmit --project tsconfig.json 2>&1 | grep "error TS" | head
```
Expected: no output.

- [ ] **Step 3: Restart bot under PM2**

```bash
pm2 restart aria-bot
sleep 3
pm2 logs aria-bot --lines 30
```
Expected: clean startup, every job logs `[cron-runner] <name>: scheduled <expr> America/Denver`.

- [ ] **Step 4: Smoke /jobs and /run via Telegram**

In Telegram:
- `/jobs` → returns the list with last-run status for each
- `/run qty-calibration` → runs synchronously, returns a status string

- [ ] **Step 5: Update CLAUDE.md to point at the new framework**

In the "## Architecture" section, add:

```markdown
### Cron Framework
Scheduled work is registered via `defineJob` in `src/cron/jobs/index.ts` and run by `startCronRunner()` (`src/cron/runner.ts`). Each job declares schedule + handler + budget + onFail + dependsOn. Run history persists to `cron_runs`. Telegram surfaces: `/jobs` lists all, `/run <name>` triggers one manually with the same guardrails. ops-manager.ts no longer schedules anything — it only owns the imperative methods that jobs delegate to.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document src/cron/ framework in CLAUDE.md

Closes the cron-framework + kaizen plan (2026-05-05)."
```

---

## Self-Review Checklist (run after writing, before executing)

**Spec coverage (kaizen punchlist items #1-#12):**

- [x] #1 prompt caching central → Task 8
- [x] #2 pre-warm vendor caches → Task 10
- [x] #3 dependsOn nightshift→AP → Task 9
- [x] #4 POSync 30m → 4h → Task 5 (called out in commit msg)
- [x] #5 Fold POSweep into APPolling → Task 7
- [x] #6 Watchdog Mon-Fri → Task 5 (called out in commit msg)
- [x] #7 Batch Supabase → Task 10
- [x] #8 PDF base64 cache → Task 11
- [x] #9 backfillPOSent batch → Task 12
- [ ] #10, #11 (catalog hygiene) — explicitly out of scope per Will (Phase 3 deferred)
- [x] #12 DailySummary completion → Task 13

**Type consistency:** `JobDef.handler` signature `(ctx: JobCtx) => Promise<void>` is identical across registry.ts, runner.ts, and jobs/index.ts. `runJobOnce` returns `RunResult` consistently. `lastRun` returns optional with the same shape used in runner.ts dependsOn check and start-bot.ts /jobs render.

**Placeholder scan:** no `TODO`, no `add appropriate error handling`, no "similar to Task N", every code block is concrete.

---

## Out of Scope (deferred to follow-on work)

These items from earlier discussions are NOT in this plan:

- **Modules + skills + MCP layer** — deferred until a concrete pain point emerges (per Will, 2026-05-05).
- **Catalog hygiene (kaizen #10, #11):** merge `pdf-pipeline` agent into `ap-pipeline`; delete `.agent/skills/firecrawl/` orphan. Trivial, do during incidental edits.
- **StatIndexing → event-driven**, **IssueOrchestrator decision**, **vendor-enricher singleton fix**, **github-client singleton fix** — listed in the "deferred bucket" of the kaizen punchlist. Pick up opportunistically.
