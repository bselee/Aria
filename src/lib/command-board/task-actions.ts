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
import * as agentIssue from '../intelligence/agent-issue';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
} from '../finale/reconciler';

import {
    createDraftPOTaskAfterApproval,
    type DraftPOTaskPayload,
} from './po-approval-task';

export type TaskActionResult =
    | { ok: true; replyText: string; cbQueryText: string; data?: unknown }
    | { ok: false; replyText: string; cbQueryText: string; error: string };

/** Reply string used when getById returns null. Shared by approve + reject. */
const NOT_FOUND_REPLY = '❓ Task not found.';

const DASHBOARD_ACTOR_PREFIX = 'will-dashboard';

/**
 * Cross-cutting: when a task action runs and the task has a linked
 * agent_issue (via `issue_id`, set by Phase 2 producers like ap-issue.ts
 * linkApTask), advance the parent issue to terminal state too.
 *
 * Without this, dismissing a dropship_forward task in /tasks would close
 * the task but leave the issue blocked on `source_unavailable` forever —
 * Will's manual forward is the resolution, the dismiss IS the signal that
 * it's done.
 *
 * The AP-source approve/reject path is intentionally skipped here: the
 * reconciler's approvePendingReconciliation / rejectPendingReconciliation
 * already drives the issue lifecycle (see commits 0401c33 + 8db1e43).
 * Calling complete() again here would be a duplicate event in the timeline.
 *
 * Best-effort: a missing issue or a hub failure must never block the task
 * action's reply to the user.
 */
async function resolveLinkedIssueFromTaskAction(
    taskId: string,
    action: 'approved' | 'rejected' | 'dismissed',
    actor: string,
): Promise<void> {
    try {
        const task = await agentTask.getById(taskId);
        if (!task?.issue_id) return;
        const issue = await agentIssue.getById(task.issue_id);
        if (!issue) return;
        // Already terminal — don't double-complete.
        if (issue.lifecycle_state === 'complete') return;
        // If blocked, clear the blocker first so the timeline shows a
        // coherent blocker_cleared → complete sequence (same pattern as
        // reconciler approve/reject paths).
        if (issue.lifecycle_state === 'blocked') {
            await agentIssue.clearBlocker(task.issue_id, 'working');
        }
        await agentIssue.complete(task.issue_id, {
            resolution: `task_${action}`,
            resolved_by: actor,
            via: 'task_action',
            task_id: taskId,
        });
    } catch (err) {
        console.warn('[task-actions] resolveLinkedIssue failed:', err);
    }
}

/**
 * Cross-surface bridge: when a task action runs from the dashboard, nudge
 * Telegram so Will sees a record of it in his chat. Best-effort — failures
 * are swallowed because the action itself already succeeded.
 *
 * We don't store the original Telegram message_id, so we can't edit out the
 * buttons on the original; a fresh notification is the v1 contract.
 */
async function notifyTelegramOfDashboardAction(
    actor: string,
    actionLabel: string,
    taskId: string,
    replyText: string,
): Promise<void> {
    if (!actor.startsWith(DASHBOARD_ACTOR_PREFIX)) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        const summary = `📋 ${actionLabel} via dashboard (task ${taskId.slice(0, 8)})\n${replyText}`;
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: summary }),
        });
    } catch (err) {
        console.warn('[task-actions] telegram bridge failed:', err);
    }
}

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
            const replyText = `${result.success ? '✅' : '⚠️'} ${result.message}`;
            await notifyTelegramOfDashboardAction(actor, 'Approved', taskId, replyText);
            return {
                ok: true,
                replyText,
                cbQueryText,
                data: result,
            };
        }
        if (task.source_table === 'po_pending_approval') {
            // Mark approved in the hub first so the audit trail is intact even
            // if the Finale create call fails (createDraftPOTaskAfterApproval
            // logs and returns success=false in that case).
            await agentTask.decideApproval(taskId, 'approve', actor);
            const result = await createDraftPOTaskAfterApproval(taskId, actor);
            const replyText = result.message;
            await resolveLinkedIssueFromTaskAction(taskId, 'approved', actor);
            await notifyTelegramOfDashboardAction(actor, 'Approved', taskId, replyText);
            return {
                ok: result.success,
                replyText,
                cbQueryText,
                data: result,
            };
        }
        await agentTask.decideApproval(taskId, 'approve', actor);
        await resolveLinkedIssueFromTaskAction(taskId, 'approved', actor);
        await notifyTelegramOfDashboardAction(actor, 'Approved', taskId, '✅ Approved.');
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
            const replyText = `❌ ${message}`;
            await notifyTelegramOfDashboardAction(actor, 'Rejected', taskId, replyText);
            return {
                ok: true,
                replyText,
                cbQueryText,
                data: { message },
            };
        }
        await agentTask.decideApproval(taskId, 'reject', actor);
        await resolveLinkedIssueFromTaskAction(taskId, 'rejected', actor);
        await notifyTelegramOfDashboardAction(actor, 'Rejected', taskId, '❌ Rejected.');
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
        await resolveLinkedIssueFromTaskAction(taskId, 'dismissed', actor);
        await notifyTelegramOfDashboardAction(actor, 'Dismissed', taskId, '✓ Dismissed.');
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
