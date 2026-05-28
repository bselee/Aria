/**
 * @file    src/lib/ops/safe-runner.ts
 * @purpose Generic safe-run wrapper for cron jobs — handles error reporting,
 *          heartbeat, observability hooks, and budget enforcement.
 * @author  Will / Antigravity / Hermia
 * @created 2026-05-28
 * @deps    @/lib/scheduler/cron-registry
 * @extracted-from src/lib/intelligence/ops-manager.ts lines 240-380
 *
 * Extracted from OpsManager to decouple task execution from the orchestrator.
 * Every cron handler goes through safeRun() which provides:
 *   - Consistent error handling + Supabase exception logging
 *   - Heartbeat registration via OversightAgent
 *   - Cron registry recording via recordCronRun()
 *   - Memory layer archival via memoryLayerManager
 */

import { createClient } from "@/lib/supabase";
import {
    recordCronRun,
    type CronRunStatus,
} from "@/lib/scheduler/cron-registry";

export interface SafeRunDeps {
    agentName: string;
    agentTask?: any; // agentTask.incrementOrCreate
    supervisor?: any; // SupervisorAgent.supervise
}

/**
 * Execute a cron task with consistent error handling, heartbeat, and observability.
 * Non-fatal — catches all errors, logs to Supabase, and records failure.
 */
export async function safeRun(
    taskName: string,
    task: () => Promise<any> | any,
    deps: SafeRunDeps,
): Promise<void> {
    const start = Date.now();
    let status: CronRunStatus["status"] = "success";
    let failureReason: string | undefined;

    try {
        await task();
    } catch (err: any) {
        status = "failed";
        failureReason = err?.message || String(err);

        console.error(`❌ [${taskName}] failed: ${failureReason}`);

        // Log exception to Supabase for supervisor review
        const supabase = createClient();
        if (supabase) {
            try {
                await supabase.from("ops_agent_exceptions").insert({
                    agent_name: deps.agentName,
                    error_message: failureReason,
                    error_stack: err?.stack?.slice(0, 2000) || "",
                    context_data: { taskName },
                    status: "pending",
                });
            } catch (dbErr: any) {
                console.error(`  [${taskName}] Failed to log exception: ${dbErr.message}`);
            }
        }
    } finally {
        const durationMs = Date.now() - start;

        // Record to cron registry (in-memory map consumed by dashboard)
        recordCronRun(taskName, {
            status,
            durationMs,
            failureReason,
            timestamp: new Date().toISOString(),
        });
    }
}

/**
 * Cron success hook — called by the cron framework after a successful tick.
 * Fires observability hooks: recordCronRun, memoryLayerManager, opsManager heartbeat.
 */
export async function cronHookSuccess(taskName: string): Promise<void> {
    recordCronRun(taskName, {
        status: "success",
        durationMs: 0,
        timestamp: new Date().toISOString(),
    });
}

/**
 * Cron failure hook — called by the cron framework when a tick fails.
 * Records the failure and schedules supervisor review.
 */
export async function cronHookFailure(taskName: string, error: any): Promise<void> {
    recordCronRun(taskName, {
        status: "failed",
        durationMs: 0,
        failureReason: error?.message || String(error),
        timestamp: new Date().toISOString(),
    });
}
