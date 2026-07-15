/**
 * @file    history.ts
 * @purpose Best-effort writer + reader for the cron_runs table. Each tick
 *          records start, end, duration, status, failure reason.
 *
 *          Best-effort means: a Supabase outage must not block the tick
 *          from running. recordStart returns null on failure; recordEnd
 *          silently no-ops if id is null.
 *
 *          Schema note: cron_runs predates this framework. We use the
 *          existing column names (task_name / finished_at / error_message)
 *          and the three columns added by 20260506000001_cron_runs.sql
 *          (invoked_by, failure_reason, metadata_jsonb).
 */

import { createClient } from "../lib/db";

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
                task_name: args.jobName,
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
        const update: Record<string, unknown> = {
            status: args.status,
            finished_at: new Date().toISOString(),
        };
        if (args.durationMs !== undefined) update.duration_ms = args.durationMs;
        if (args.failureReason !== undefined) update.failure_reason = args.failureReason;
        if (args.failureMessage !== undefined) update.error_message = args.failureMessage;
        if (args.metadata !== undefined) update.metadata_jsonb = args.metadata;

        const { error } = await db
            .from("cron_runs")
            .update(update)
            .eq("id", args.id);
        if (error) console.warn(`[cron-history] recordEnd failed: ${error.message}`);
    } catch (err: any) {
        console.warn(`[cron-history] recordEnd exception: ${err.message}`);
    }
}

export interface LastRunRow {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: CronRunStatus | "success" | "error";  // legacy values still possible
    duration_ms: number | null;
    error_message: string | null;
}

/** Returns the most recent cron_runs row for the named job, or null. */
export async function lastRun(jobName: string): Promise<LastRunRow | null> {
    const db = createClient();
    if (!db) return null;
    try {
        const { data, error } = await db
            .from("cron_runs")
            .select("id, started_at, finished_at, status, duration_ms, error_message")
            .eq("task_name", jobName)
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            console.warn(`[cron-history] lastRun failed: ${error.message}`);
            return null;
        }
        return (data as LastRunRow | null) ?? null;
    } catch (err: any) {
        console.warn(`[cron-history] lastRun exception: ${err.message}`);
        return null;
    }
}

/**
 * Returns true if the named job's most recent run is the modern 'succeeded'
 * status OR the legacy 'success' status. Used by runner's dependsOn check.
 */
export function isSuccessStatus(status: string | null | undefined): boolean {
    return status === "succeeded" || status === "success";
}
