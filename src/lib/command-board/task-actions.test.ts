/**
 * @file    task-actions.test.ts
 * @purpose Snapshot tests for shared task action handlers used by both Telegram
 *          and the dashboard. Reply text strings MUST be byte-identical to the
 *          original inline strings in src/cli/start-bot.ts callbacks (lines
 *          909-960). These tests lock that contract in place.
 * @author  bot-safety worker
 * @created 2026-04-28
 * @deps    vitest
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the agent-task module so we can stub getById/decideApproval/complete
vi.mock('../intelligence/agent-task', () => ({
    getById: vi.fn(),
    decideApproval: vi.fn(),
    complete: vi.fn(),
}));

// Mock the reconciler module so we can stub the AP-source approval/reject path
vi.mock('../finale/reconciler', () => ({
    approvePendingReconciliation: vi.fn(),
    rejectPendingReconciliation: vi.fn(),
}));

import * as agentTask from '../intelligence/agent-task';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
} from '../finale/reconciler';
import { approveTask, rejectTask, dismissTask } from './task-actions';

beforeEach(() => {
    vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// approveTask
// ────────────────────────────────────────────────────────────────────────────

describe('approveTask', () => {
    it("returns the exact 'Task not found' reply when task is missing", async () => {
        vi.mocked(agentTask.getById).mockResolvedValue(null);
        const r = await approveTask('t1', 'will-telegram');
        expect(r.ok).toBe(false);
        expect(r.replyText).toBe('❓ Task not found.');
        expect(r.cbQueryText).toBe('Approving...');
    });

    it('AP source happy path: returns reconciler success message exactly', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't1',
            source_table: 'ap_pending_approvals',
            source_id: 'src1',
        } as any);
        vi.mocked(approvePendingReconciliation).mockResolvedValue({
            success: true,
            applied: [],
            errors: [],
            message: 'Applied 3 lines',
        });
        const r = await approveTask('t1', 'will-telegram');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('✅ Applied 3 lines');
        expect(r.cbQueryText).toBe('Approving...');
        expect(approvePendingReconciliation).toHaveBeenCalledWith('src1');
    });

    it('AP source unhappy path: prefixes warning glyph when reconciler reports failure', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't1',
            source_table: 'ap_pending_approvals',
            source_id: 'src1',
        } as any);
        vi.mocked(approvePendingReconciliation).mockResolvedValue({
            success: false,
            applied: [],
            errors: ['oops'],
            message: 'Approval not found or expired.',
        });
        const r = await approveTask('t1', 'will-telegram');
        // ok still true (call completed without throwing); content uses warn glyph
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('⚠️ Approval not found or expired.');
    });

    it('generic path: returns the exact Approved string', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't2',
            source_table: 'something_else',
            source_id: null,
        } as any);
        vi.mocked(agentTask.decideApproval).mockResolvedValue(undefined);
        const r = await approveTask('t2', 'will-telegram');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('✅ Approved.');
        expect(r.cbQueryText).toBe('Approving...');
        expect(agentTask.decideApproval).toHaveBeenCalledWith('t2', 'approve', 'will-telegram');
    });

    it('error path: surfaces the err.message in the failure string', async () => {
        vi.mocked(agentTask.getById).mockRejectedValue(new Error('boom'));
        const r = await approveTask('t3', 'will-telegram');
        expect(r.ok).toBe(false);
        expect(r.replyText).toBe('❌ Approve failed: boom');
        expect(r.cbQueryText).toBe('Approving...');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// rejectTask
// ────────────────────────────────────────────────────────────────────────────

describe('rejectTask', () => {
    it("returns the exact 'Task not found' reply when task is missing", async () => {
        vi.mocked(agentTask.getById).mockResolvedValue(null);
        const r = await rejectTask('t1', 'will-telegram');
        expect(r.ok).toBe(false);
        expect(r.replyText).toBe('❓ Task not found.');
        expect(r.cbQueryText).toBe('Rejecting...');
    });

    it('AP source happy path: prefixes the X glyph to the reconciler message', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't1',
            source_table: 'ap_pending_approvals',
            source_id: 'src1',
        } as any);
        vi.mocked(rejectPendingReconciliation).mockResolvedValue('Rejected approval src1');
        const r = await rejectTask('t1', 'will-telegram');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('❌ Rejected approval src1');
        expect(r.cbQueryText).toBe('Rejecting...');
        expect(rejectPendingReconciliation).toHaveBeenCalledWith('src1');
    });

    it('generic path: returns the exact Rejected string', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't2',
            source_table: 'something_else',
            source_id: null,
        } as any);
        vi.mocked(agentTask.decideApproval).mockResolvedValue(undefined);
        const r = await rejectTask('t2', 'will-telegram');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('❌ Rejected.');
        expect(r.cbQueryText).toBe('Rejecting...');
        expect(agentTask.decideApproval).toHaveBeenCalledWith('t2', 'reject', 'will-telegram');
    });

    it('error path: surfaces the err.message in the failure string', async () => {
        vi.mocked(agentTask.getById).mockRejectedValue(new Error('kaboom'));
        const r = await rejectTask('t3', 'will-telegram');
        expect(r.ok).toBe(false);
        expect(r.replyText).toBe('❌ Reject failed: kaboom');
        expect(r.cbQueryText).toBe('Rejecting...');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// dismissTask
// ────────────────────────────────────────────────────────────────────────────

describe('dismissTask', () => {
    it('happy path: returns the exact Dismissed string and forwards actor to complete()', async () => {
        vi.mocked(agentTask.complete).mockResolvedValue(undefined);
        const r = await dismissTask('t1', 'will-telegram');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('✓ Dismissed.');
        expect(r.cbQueryText).toBe('Dismissed');

        // assert the call shape: complete(taskId, { dismissed_by, dismissed_at: ISO })
        const callArgs = vi.mocked(agentTask.complete).mock.calls[0];
        expect(callArgs[0]).toBe('t1');
        const payload = callArgs[1] as Record<string, unknown>;
        expect(payload.dismissed_by).toBe('will-telegram');
        expect(typeof payload.dismissed_at).toBe('string');
        // ISO 8601 (with milliseconds + Z) sanity check
        expect(payload.dismissed_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('error path: surfaces the err.message in the failure string', async () => {
        vi.mocked(agentTask.complete).mockRejectedValue(new Error('nope'));
        const r = await dismissTask('t1', 'will-telegram');
        expect(r.ok).toBe(false);
        expect(r.replyText).toBe('❌ Dismiss failed: nope');
        expect(r.cbQueryText).toBe('Dismissed');
    });

    it('dashboard actor flows through to complete payload', async () => {
        vi.mocked(agentTask.complete).mockResolvedValue(undefined);
        await dismissTask('t9', 'will-dashboard');
        const callArgs = vi.mocked(agentTask.complete).mock.calls[0];
        const payload = callArgs[1] as Record<string, unknown>;
        expect(payload.dismissed_by).toBe('will-dashboard');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Telegram bridge: dashboard actions notify the bot chat; telegram actions do not
// ────────────────────────────────────────────────────────────────────────────

describe('Telegram bridge', () => {
    const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ORIGINAL_CHAT = process.env.TELEGRAM_CHAT_ID;

    beforeEach(() => {
        process.env.TELEGRAM_BOT_TOKEN = 'test-token';
        process.env.TELEGRAM_CHAT_ID = '12345';
        // global.fetch — task-actions uses the runtime fetch, not an injected one
        (globalThis as any).fetch = vi.fn(async () =>
            new Response('{"ok":true}', { status: 200 }),
        );
    });

    afterEach(() => {
        process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
        process.env.TELEGRAM_CHAT_ID = ORIGINAL_CHAT;
    });

    it('does NOT call telegram on will-telegram actor', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't1', source_table: null, source_id: null,
        } as any);
        vi.mocked(agentTask.decideApproval).mockResolvedValue(undefined);
        await approveTask('t1', 'will-telegram');
        expect((globalThis as any).fetch).not.toHaveBeenCalled();
    });

    it('calls telegram once on will-dashboard actor (generic approve)', async () => {
        vi.mocked(agentTask.getById).mockResolvedValue({
            id: 't1', source_table: null, source_id: null,
        } as any);
        vi.mocked(agentTask.decideApproval).mockResolvedValue(undefined);
        await approveTask('t1', 'will-dashboard');
        expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (globalThis as any).fetch.mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
        const body = JSON.parse(init.body);
        expect(body.chat_id).toBe('12345');
        expect(body.text).toContain('Approved via dashboard');
        expect(body.text).toContain('✅ Approved.');
    });

    it('does NOT call telegram when token is missing', async () => {
        delete process.env.TELEGRAM_BOT_TOKEN;
        vi.mocked(agentTask.complete).mockResolvedValue(undefined);
        await dismissTask('t9', 'will-dashboard');
        expect((globalThis as any).fetch).not.toHaveBeenCalled();
    });

    it('swallows telegram failure without breaking the action', async () => {
        (globalThis as any).fetch = vi.fn(async () => {
            throw new Error('network');
        });
        vi.mocked(agentTask.complete).mockResolvedValue(undefined);
        const r = await dismissTask('t9', 'will-dashboard');
        expect(r.ok).toBe(true);
        expect(r.replyText).toBe('✓ Dismissed.');
    });
});
