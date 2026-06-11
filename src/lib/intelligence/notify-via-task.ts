/**
 * @file    src/lib/intelligence/notify-via-task.ts
 * @purpose Task-first notification pattern. Replaces fire-and-forget Telegram
 *          sends: every alert creates/dedups an `agent_task` row FIRST, then
 *          Telegram becomes a VIEW of all open tasks of that type — one summary
 *          message, not one ping per alert. The task is the source of truth;
 *          Telegram is downstream.
 */

import { incrementOrCreate, listTasks, type IncrementOrCreateArgs, type AgentTask } from "./agent-task";
import { sendCriticalTelegramNotify, sendTelegramNotify } from "./telegram-notify";

/** Fixed spoke table for all task-first cron notifications. */
const SOURCE_TABLE = "cron_notify";

export type NotifyViaTaskArgs = {
    /** Unique source identifier for dedup (e.g. "jit:EM108:2026-06-18") */
    sourceId: string;
    /** Task type from AgentTaskType union */
    type: IncrementOrCreateArgs["type"];
    /** Human-readable goal (e.g. "Order EM108 by 2026-06-18") */
    goal: string;
    /** Structured inputs for the task */
    inputs: Record<string, unknown>;
    /** Owner - defaults to "will" */
    owner?: string;
    /** Priority 0-5 (0=highest) */
    priority?: number;
    /** Whether this should bypass biz-hours gate */
    critical?: boolean;
    /** Custom summary prefix for the Telegram message */
    summaryLabel?: string;
};

/**
 * Create/increment an agent_task row, then send a summary Telegram of all
 * open tasks of the same type. Returns the task id.
 *
 * Pattern: task-first notification. The task is the source of truth;
 * Telegram is a view. If the task already exists (same source_id + hash),
 * only dedup_count increments — no duplicate Telegram noise.
 */
export async function notifyViaTask(args: NotifyViaTaskArgs): Promise<string | null> {
    // 1. incrementOrCreate — task row is the source of truth.
    let taskId: string | null = null;
    try {
        const task = await incrementOrCreate({
            sourceTable: SOURCE_TABLE,
            sourceId: args.sourceId,
            type: args.type,
            goal: args.goal,
            owner: args.owner ?? "will",
            priority: args.priority ?? 2,
            inputs: args.inputs,
        });
        taskId = task?.id ?? null;
    } catch (err: any) {
        console.warn(`[notify-via-task] incrementOrCreate failed: ${err?.message ?? err}`);
        return null;
    }

    // 2. Query open tasks of the same type — the view.
    let openTasks: AgentTask[] = [];
    try {
        openTasks = await listTasks({ type: [args.type], includeRecentFailed: false });
    } catch (err: any) {
        console.warn(`[notify-via-task] listTasks failed: ${err?.message ?? err}`);
    }

    // 3. Compact summary: one line per open task (goal + dedup + age).
    const label = args.summaryLabel ?? args.type;
    const lines: string[] = [`🗂 *${label}* — ${openTasks.length} open task(s)`];
    for (const t of openTasks.slice(0, 20)) {
        const ageH = Math.round((Date.now() - new Date(t.created_at).getTime()) / 3_600_000);
        const dedup = (t.dedup_count ?? 1) > 1 ? ` ×${t.dedup_count}` : "";
        lines.push(`• ${t.goal}${dedup} _(${ageH}h)_`);
    }
    const message = lines.join("\n");

    // 4. Send — critical bypasses biz-hours gate, otherwise gated.
    if (args.critical) {
        await sendCriticalTelegramNotify(message);
    } else {
        await sendTelegramNotify(message);
    }

    // 5. Return the task id.
    return taskId;
}
