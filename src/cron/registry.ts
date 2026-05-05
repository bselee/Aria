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
    /** Soft cap on LLM tokens per tick. Currently advisory; future enforcement TBD. */
    llmTokens?: number;
    /** Soft cap on Finale API calls per tick. Currently advisory. */
    finaleCalls?: number;
    /** Hard cap on tick duration. Runner aborts via AbortController if exceeded. */
    durationMs?: number;
}

export interface JobCtx {
    invokedBy: "cron" | "manual" | "dependency";
    correlationId: string;
    log: (msg: string) => void;
    signal: AbortSignal;
}

export interface JobDef {
    /** Unique, kebab-case. Used as the key in /run <name> and in cron_runs.task_name. */
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
    /** Names of jobs whose most recent run must be 'succeeded' before this tick proceeds. */
    dependsOn?: string[];
    /** Default true. Set false to keep the registration but disable the schedule. */
    enabled?: boolean;
    /** Free-form description shown in /jobs. Keep to one short sentence. */
    description?: string;
}

/** Internal: every field has a concrete value (defaults applied). */
type RegisteredJob = JobDef & Required<Pick<JobDef, "tz" | "concurrency" | "enabled">>;

const _registry = new Map<string, RegisteredJob>();

export function defineJob(def: JobDef): void {
    if (!def.name || typeof def.name !== "string") {
        throw new Error("defineJob: name required (non-empty string)");
    }
    if (!def.schedule || typeof def.schedule !== "string") {
        throw new Error(`defineJob(${def.name}): schedule required (non-empty string)`);
    }
    if (_registry.has(def.name)) {
        throw new Error(`defineJob: "${def.name}" already registered`);
    }
    _registry.set(def.name, {
        ...def,
        tz: def.tz ?? "America/Denver",
        concurrency: def.concurrency ?? 1,
        enabled: def.enabled ?? true,
    });
}

export function getJob(name: string): RegisteredJob | undefined {
    return _registry.get(name);
}

export function listJobs(): RegisteredJob[] {
    return [..._registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test-only helper. Do not call from production code. */
export function _resetRegistry(): void {
    _registry.clear();
}
