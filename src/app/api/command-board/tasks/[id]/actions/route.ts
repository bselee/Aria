/**
 * @file    src/app/api/command-board/tasks/[id]/actions/route.ts
 * @purpose Dashboard endpoint for approve/reject/dismiss on a single task. Calls
 *          the same shared module the Telegram bot uses
 *          (src/lib/command-board/task-actions.ts) so reply text cannot diverge.
 *
 * @author  bot-safety worker
 * @created 2026-04-28
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
    approveTask,
    rejectTask,
    dismissTask,
    isNotFoundResult,
    type TaskActionResult,
} from '@/lib/command-board/task-actions';

export const dynamic = 'force-dynamic';

const VALID_ACTIONS = ['approve', 'reject', 'dismiss'] as const;
type Action = typeof VALID_ACTIONS[number];

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> | { id: string } },
) {
    const { id } = await Promise.resolve(params);

    if (!id || typeof id !== 'string') {
        return NextResponse.json(
            { ok: false, replyText: 'Invalid task id.', error: 'invalid_id' },
            { status: 400, headers: NO_STORE_HEADERS },
        );
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { ok: false, replyText: 'Invalid JSON body.', error: 'invalid_body' },
            { status: 400, headers: NO_STORE_HEADERS },
        );
    }

    const action = (body as { action?: unknown })?.action;
    if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as Action)) {
        return NextResponse.json(
            {
                ok: false,
                replyText: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}.`,
                error: 'invalid_action',
            },
            { status: 400, headers: NO_STORE_HEADERS },
        );
    }

    const actor = 'will-dashboard';
    let result: TaskActionResult;
    switch (action as Action) {
        case 'approve':
            result = await approveTask(id, actor);
            break;
        case 'reject':
            result = await rejectTask(id, actor);
            break;
        case 'dismiss':
            result = await dismissTask(id, actor);
            break;
    }

    // 404 only when the failure is specifically "task not found" — lets the
    // dashboard distinguish stale ids from generic errors.
    if (!result.ok && isNotFoundResult(result)) {
        return NextResponse.json(
            { ok: false, replyText: result.replyText },
            { status: 404, headers: NO_STORE_HEADERS },
        );
    }

    if (!result.ok) {
        return NextResponse.json(
            { ok: false, replyText: result.replyText },
            { status: 500, headers: NO_STORE_HEADERS },
        );
    }

    return NextResponse.json(
        { ok: true, replyText: result.replyText },
        { status: 200, headers: NO_STORE_HEADERS },
    );
}
