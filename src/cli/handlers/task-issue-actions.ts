/**
 * @file    task-issue-actions.ts
 * @purpose Handles inline callback actions for tasks (paginated lists, approvals, rejections)
 *          and business issues ledger (approvals, pauses, run-next, manual resolutions).
 * @author  Will / Antigravity
 * @created 2026-05-26
 * @updated 2026-05-26
 * @deps    telegraf, command-board/task-actions, intelligence/agent-issue, command-board/service
 */

import type { Context } from 'telegraf';
import { Markup as TgMarkup } from 'telegraf';
import * as agentTask from '../../lib/intelligence/agent-task';
import * as agentIssue from '../../lib/intelligence/agent-issue';
import { approveTask, rejectTask, dismissTask } from '../../lib/command-board/task-actions';
import { getCommandBoardIssueDetail, getCommandBoardIssues } from '../../lib/command-board/service';

const TASKS_PAGE_SIZE = 5;
const TASK_STATUS_DOT: Record<string, string> = {
    NEEDS_APPROVAL: '🟡',
    FAILED: '🔴',
    PENDING: '🟢',
    RUNNING: '🟢',
    CLAIMED: '🟢',
};

type IssueRow = {
    id: string;
    title: string;
    lifecycle_state: string;
    autonomy_state: string | null;
    current_handler: string | null;
    blocker_reason: string | null;
    next_action: string | null;
    priority: number;
    owner: string;
};

function isHumanApprovalRow(i: IssueRow): boolean {
    return i.lifecycle_state === 'blocked' && i.blocker_reason === 'human_approval_required';
}

/**
 * Builds a formatted paginated message and inline buttons for agent tasks.
 */
export function renderTasksMessage(tasks: agentTask.AgentTask[], offset: number, totalOpen: number): { text: string; keyboard: any } {
    if (tasks.length === 0) {
        return {
            text: '📋 Nothing waiting. ✨',
            keyboard: TgMarkup.inlineKeyboard([[TgMarkup.button.callback('🔄 Refresh', 'tasks_page_0')]]),
        };
    }
    const lines: string[] = [`📋 ${totalOpen} open task${totalOpen === 1 ? '' : 's'} — showing ${offset + 1}–${offset + tasks.length}`, ''];
    const rows: any[][] = [];
    tasks.forEach((t, idx) => {
        const dot = TASK_STATUS_DOT[t.status] ?? '⚪';
        const num = offset + idx + 1;
        const goal = t.goal.length > 70 ? t.goal.slice(0, 67) + '...' : t.goal;
        lines.push(`${dot} ${num}. ${goal}`);
        if (t.type === 'approval' && t.requires_approval) {
            rows.push([
                TgMarkup.button.callback(`✅ ${num} Approve`, `task_approve_${t.id}`),
                TgMarkup.button.callback(`❌ ${num} Reject`, `task_reject_${t.id}`),
            ]);
        } else if (t.type === 'cron_failure' || t.status === 'FAILED') {
            rows.push([TgMarkup.button.callback(`✓ ${num} Dismiss`, `task_dismiss_${t.id}`)]);
        } else {
            rows.push([TgMarkup.button.callback(`✓ ${num} Done`, `task_dismiss_${t.id}`)]);
        }
    });
    const navRow: any[] = [];
    if (offset > 0) navRow.push(TgMarkup.button.callback('⏮ Prev', `tasks_page_${Math.max(0, offset - TASKS_PAGE_SIZE)}`));
    if (offset + tasks.length < totalOpen) navRow.push(TgMarkup.button.callback('Next ⏭', `tasks_page_${offset + TASKS_PAGE_SIZE}`));
    navRow.push(TgMarkup.button.callback('🔄', `tasks_page_${offset}`));
    rows.push(navRow);
    return { text: lines.join('\n'), keyboard: TgMarkup.inlineKeyboard(rows) };
}

/**
 * Retreives a specific page of sorted open tasks.
 */
export async function fetchTasksPage(offset: number): Promise<{ tasks: agentTask.AgentTask[]; total: number }> {
    const all = await agentTask.listTasks({
        limit: 500,
        includeRecentFailed: true,
    });
    const rank = (t: agentTask.AgentTask) =>
        (t.status === 'NEEDS_APPROVAL' && t.owner === 'will' ? 0 : t.status === 'NEEDS_APPROVAL' ? 1 : t.status === 'FAILED' ? 2 : 3) * 1000 +
        (t.priority ?? 2);
    const sorted = [...all].sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return { tasks: sorted.slice(offset, offset + TASKS_PAGE_SIZE), total: sorted.length };
}

/**
 * Builds formatted lines and control keys for an individual issue.
 */
export function renderIssueRow(i: IssueRow): { line: string; buttons: any[] } {
    const handler = i.current_handler ? ` · ${i.current_handler}` : '';
    const blocker = i.blocker_reason ? `  🚫 ${i.blocker_reason}` : '';
    const next = i.next_action ? `\n    → ${i.next_action}` : '';
    const tag = isHumanApprovalRow(i) ? '👀'
        : i.lifecycle_state === 'blocked' ? '🚫'
            : i.lifecycle_state === 'waiting_external' ? '⏳'
                : '▶';
    const ctrl = (i as any).inputs?.control as { mode?: string; paused?: boolean } | undefined;
    const modeTag = ctrl?.mode ? `  · ${ctrl.mode}` : '';
    const pausedTag = ctrl?.paused === true ? '  · ⏸ paused' : '';
    const line = `${tag} [${i.lifecycle_state}${handler}${modeTag}${pausedTag}${blocker}] ${i.title}${next}`;
    const buttons: any[] = [];
    if (isHumanApprovalRow(i)) {
        buttons.push(TgMarkup.button.callback('✅ Approve', `issue_approve_${i.id}`));
        buttons.push(TgMarkup.button.callback('❌ Reject', `issue_reject_${i.id}`));
    } else if (i.lifecycle_state === 'blocked') {
        buttons.push(TgMarkup.button.callback('✓ Resolve', `issue_resolve_${i.id}`));
    } else {
        buttons.push(TgMarkup.button.callback('✓ Mark done', `issue_resolve_${i.id}`));
    }
    if (ctrl?.paused === true) {
        buttons.push(TgMarkup.button.callback('▶ Resume', `issue_resume_${i.id}`));
    } else if (i.lifecycle_state !== 'complete') {
        buttons.push(TgMarkup.button.callback('⏸ Pause', `issue_pause_${i.id}`));
    }
    if (i.lifecycle_state !== 'complete') {
        buttons.push(TgMarkup.button.callback('⚙ Run next', `issue_run_${i.id}`));
    }
    buttons.push(TgMarkup.button.callback('🔍 Detail', `issue_detail_${i.id}`));
    return { line, buttons };
}

/**
 * Handles 'tasks_page_{offset}' callback queries.
 */
export async function handleTasksPage(ctx: Context, offset: number): Promise<void> {
    await ctx.answerCbQuery('Refreshing...');
    try {
        const { tasks, total } = await fetchTasksPage(offset);
        const { text, keyboard } = renderTasksMessage(tasks, offset, total);
        await ctx.editMessageText(text, keyboard);
    } catch (err: any) {
        await ctx.reply(`⚠️ Task queue unavailable: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'task_approve_{taskId}' callback queries.
 */
export async function handleTaskApprove(ctx: Context, taskId: string): Promise<void> {
    const result = await approveTask(taskId, 'will-telegram');
    await ctx.answerCbQuery(result.cbQueryText);
    await ctx.reply(result.replyText);
}

/**
 * Handles 'task_reject_{taskId}' callback queries.
 */
export async function handleTaskReject(ctx: Context, taskId: string): Promise<void> {
    const result = await rejectTask(taskId, 'will-telegram');
    await ctx.answerCbQuery(result.cbQueryText);
    await ctx.reply(result.replyText);
}

/**
 * Handles 'task_dismiss_{taskId}' callback queries.
 */
export async function handleTaskDismiss(ctx: Context, taskId: string): Promise<void> {
    const result = await dismissTask(taskId, 'will-telegram');
    await ctx.answerCbQuery(result.cbQueryText);
    await ctx.reply(result.replyText);
}

/**
 * Handles 'issue_approve_{issueId}' callback queries.
 */
export async function handleIssueApprove(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Approving...');
    try {
        const linked = await agentIssue.findLinkedOpenTask(issueId);
        if (!linked) {
            await ctx.reply('⚠️ No linked task — use ✓ Resolve instead.');
            return;
        }
        const result = await approveTask(linked.id, 'will-telegram');
        await ctx.reply(result.replyText);
    } catch (err: any) {
        await ctx.reply(`❌ Approve failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_reject_{issueId}' callback queries.
 */
export async function handleIssueReject(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Rejecting...');
    try {
        const linked = await agentIssue.findLinkedOpenTask(issueId);
        if (!linked) {
            await ctx.reply('⚠️ No linked task — use ✓ Resolve instead.');
            return;
        }
        const result = await rejectTask(linked.id, 'will-telegram');
        await ctx.reply(result.replyText);
    } catch (err: any) {
        await ctx.reply(`❌ Reject failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_resolve_{issueId}' callback queries.
 */
export async function handleIssueResolve(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Resolving...');
    try {
        const issue = await agentIssue.getById(issueId);
        if (!issue) { await ctx.reply('❓ Issue not found.'); return; }
        if (issue.lifecycle_state === 'complete') { await ctx.reply('Already complete.'); return; }
        if (issue.lifecycle_state === 'blocked') {
            await agentIssue.clearBlocker(issueId, 'working');
        }
        await agentIssue.complete(issueId, {
            resolution: 'manually_resolved',
            resolved_by: 'will-telegram',
            via: 'issue_button',
        });
        await ctx.reply(`✓ Resolved: ${issue.title}`);
    } catch (err: any) {
        await ctx.reply(`❌ Resolve failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_pause_{issueId}' callback queries.
 */
export async function handleIssuePause(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Pausing...');
    try {
        const { applyIssueControlAction } = await import('../../lib/intelligence/issue-control-actions');
        const result = await applyIssueControlAction(issueId, { action: 'pause', actor: 'will-telegram' });
        await ctx.reply(result.ok ? `⏸ ${result.message}` : `❌ ${result.message}`);
    } catch (err: any) {
        await ctx.reply(`❌ Pause failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_resume_{issueId}' callback queries.
 */
export async function handleIssueResume(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Resuming...');
    try {
        const { applyIssueControlAction } = await import('../../lib/intelligence/issue-control-actions');
        const result = await applyIssueControlAction(issueId, { action: 'resume', actor: 'will-telegram' });
        await ctx.reply(result.ok ? `▶ ${result.message}` : `❌ ${result.message}`);
    } catch (err: any) {
        await ctx.reply(`❌ Resume failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_run_{issueId}' callback queries.
 */
export async function handleIssueRun(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery('Running orchestrator...');
    try {
        const { applyIssueControlAction } = await import('../../lib/intelligence/issue-control-actions');
        const result = await applyIssueControlAction(issueId, { action: 'run_next_step', actor: 'will-telegram' });
        await ctx.reply(result.ok ? `⚙ ${result.message}` : `❌ ${result.message}`);
    } catch (err: any) {
        await ctx.reply(`❌ Run-next failed: ${err.message ?? String(err)}`);
    }
}

/**
 * Handles 'issue_detail_{issueId}' callback queries.
 */
export async function handleIssueDetail(ctx: Context, issueId: string): Promise<void> {
    await ctx.answerCbQuery();
    try {
        const detail = await getCommandBoardIssueDetail(issueId);
        if (!detail) { await ctx.reply('❓ Issue not found.'); return; }
        const i = detail.issue as IssueRow & { created_at: string; updated_at: string };
        const events = (detail.events ?? []) as Array<{ event_type: string; output_summary?: string; created_at: string }>;
        const tasks = (detail.linkedTasks ?? []) as Array<{ id: string; status: string; goal?: string }>;
        const headline = `${isHumanApprovalRow(i as any) ? '👀' : i.lifecycle_state === 'blocked' ? '🚫' : '▶'} ${i.title}`;
        const meta = `state: ${i.lifecycle_state}${i.current_handler ? ` · ${i.current_handler}` : ''}${i.blocker_reason ? `\nblocker: ${i.blocker_reason}` : ''}${i.next_action ? `\nnext: ${i.next_action}` : ''}`;
        const eventLines = events.slice(-8).map(e => `  ${e.created_at.slice(11, 16)}  ${e.event_type}${e.output_summary ? '  — ' + e.output_summary.slice(0, 80) : ''}`).join('\n') || '  (no events yet)';
        const taskLines = tasks.length > 0 ? tasks.map(t => `  · ${t.status}  ${t.goal ?? t.id}`).join('\n') : '  (no linked tasks)';
        await ctx.reply(`${headline}\n\n${meta}\n\nrecent events:\n${eventLines}\n\nlinked tasks:\n${taskLines}`);
    } catch (err: any) {
        await ctx.reply(`⚠️ /issue failed: ${err.message ?? String(err)}`);
    }
}
