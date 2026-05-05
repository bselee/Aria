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
 * identically. Manual /run respects the same concurrency lock as the
 * scheduled tick — there's no escape hatch.
 */

import cron from "node-cron";
import Bottleneck from "bottleneck";

import { getJob, listJobs } from "./registry";
import { recordStart, recordEnd, lastRun, isSuccessStatus, type CronRunStatus } from "./history";

// One Bottleneck per job. concurrency comes from JobDef.
const _limiters = new Map<string, Bottleneck>();
function limiterFor(jobName: string, concurrency: number): Bottleneck {
    let limiter = _limiters.get(jobName);
    if (!limiter) {
        limiter = new Bottleneck({ maxConcurrent: concurrency });
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

    // dependsOn check — every named upstream must have its most recent run
    // be a success (modern 'succeeded' or legacy 'success').
    if (job.dependsOn && job.dependsOn.length > 0) {
        for (const upstream of job.dependsOn) {
            const last = await lastRun(upstream);
            if (!last || !isSuccessStatus(last.status)) {
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
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let result: RunResult;

    try {
        if (job.budget?.durationMs) {
            durationTimer = setTimeout(
                () => ac.abort(new Error("duration-exceeded")),
                job.budget.durationMs,
            );
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
            const { sendTelegramMessage } = await import("../lib/intelligence/telegram-helper");
            await sendTelegramMessage(
                `⚠️ Cron *${jobName}* failed: ${result.failureReason}\n${result.failureMessage}`,
            );
        } catch (err: any) {
            console.warn(`[cron:${jobName}] telegram-will failed: ${err.message}`);
        }
        return;
    }
}

let _started = false;

/** Schedule every enabled registered job via node-cron. Idempotent. */
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
            cron.schedule(
                job.schedule,
                () => { void runJobOnce(job.name, "cron"); },
                { timezone: job.tz },
            );
            console.log(`[cron-runner] ${job.name}: scheduled "${job.schedule}" ${job.tz}`);
        } catch (err: any) {
            console.error(`[cron-runner] ${job.name}: schedule failed: ${err.message}`);
        }
    }
}
