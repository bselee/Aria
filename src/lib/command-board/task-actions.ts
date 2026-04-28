/**
 * @file    task-actions.ts
 * @purpose Shared task action handlers (approve / reject / dismiss) for the
 *          command board. Both the Telegram bot (src/cli/start-bot.ts) and the
 *          dashboard route (src/app/api/command-board/tasks/[id]/actions) call
 *          into this module so they cannot diverge.
 *
 *          Reply text strings are byte-identical to the legacy inline strings
 *          that lived in start-bot.ts:909-960 — see task-actions.test.ts for
 *          the snapshot lock.
 *
 *          The Telegram caller passes actor='will-telegram'; the dashboard
 *          caller passes actor='will-dashboard'.
 *
 * @author  bot-safety worker
 * @created 2026-04-28
 * @deps    agent-task, finale/reconciler
 */

import * as agentTask from '../intelligence/agent-task';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
} from '../finale/reconciler';

export type TaskActionResult =
    | { ok: true; replyText: string; cbQueryText: string; data?: unknown }
    | { ok: false; replyText: string; cbQueryText: string; error: string };

/** Reply string used when getById returns null. Shared by approve + reject. */
const NOT_FOUND_REPLY = '❓ Task not found.';

/**
 * Approve a task. AP-source tasks (`source_table === 'ap_pending_approvals'`
 * with a non-null `source_id`) route through the reconciler; everything else
 * goes through `agentTask.decideApproval`.
 */
export async function approveTask(taskId: string, actor: string): Promise<TaskActionResult> {
    const cbQueryText = 'Approving...';
    try {
        const task = await agentTask.getById(taskId);
        if (!task) {
            return { ok: false, replyText: NOT_FOUND_REPLY, cbQueryText, error: 'not_found' };
        }
        if (task.source_table === 'ap_pending_approvals' && task.source_id) {
            const result = await approvePendingReconciliation(task.source_id);
            return {
                ok: true,
                replyText: `${result.success ? '✅' : '⚠️'} ${result.message}`,
                cbQueryText,
                data: result,
            };
        }
        await agentTask.decideApproval(taskId, 'approve', actor);
        return { ok: true, replyText: '✅ Approved.', cbQueryText };
    } catch (err: any) {
        return {
            ok: false,
            replyText: `❌ Approve failed: ${err.message}`,
            cbQueryText,
            error: err?.message ?? String(err),
        };
    }
}

/**
 * Reject a task. AP-source tasks route through the reconciler; everything else
 * goes through `agentTask.decideApproval`.
 */
export async function rejectTask(taskId: string, actor: string): Promise<TaskActionResult> {
    const cbQueryText = 'Rejecting...';
    try {
        const task = await agentTask.getById(taskId);
        if (!task) {
            return { ok: false, replyText: NOT_FOUND_REPLY, cbQueryText, error: 'not_found' };
        }
        if (task.source_table === 'ap_pending_approvals' && task.source_id) {
            const message = await rejectPendingReconciliation(task.source_id);
            return {
                ok: true,
                replyText: `❌ ${message}`,
                cbQueryText,
                data: { message },
            };
        }
        await agentTask.decideApproval(taskId, 'reject', actor);
        return { ok: true, replyText: '❌ Rejected.', cbQueryText };
    } catch (err: any) {
        return {
            ok: false,
            replyText: `❌ Reject failed: ${err.message}`,
            cbQueryText,
            error: err?.message ?? String(err),
        };
    }
}

/**
 * Dismiss / mark-done a task. Writes hub status SUCCEEDED with audit metadata.
 */
export async function dismissTask(taskId: string, actor: string): Promise<TaskActionResult> {
    const cbQueryText = 'Dismissed';
    try {
        await agentTask.complete(taskId, {
            dismissed_by: actor,
            dismissed_at: new Date().toISOString(),
        });
        return { ok: true, replyText: '✓ Dismissed.', cbQueryText };
    } catch (err: any) {
        return {
            ok: false,
            replyText: `❌ Dismiss failed: ${err.message}`,
            cbQueryText,
            error: err?.message ?? String(err),
        };
    }
}

/**
 * Helper for the dashboard route to detect a "not found" failure (so it can
 * return 404 instead of 500). Uses the exact reply text the bot relies on.
 */
export function isNotFoundResult(result: TaskActionResult): boolean {
    return !result.ok && result.replyText === NOT_FOUND_REPLY;
}
