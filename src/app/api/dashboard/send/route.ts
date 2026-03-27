/**
 * @file    route.ts
 * @purpose Dashboard chat API backed by the shared copilot adapter.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-03-26
 */

import { NextResponse } from 'next/server';
import { handleDashboardSend } from '@/lib/copilot/channels/dashboard';

export async function POST(req: Request) {
    let message = '';

    try {
        const body = await req.json();
        message = body.message || '';
        const threadId = typeof body.threadId === 'string' && body.threadId.trim()
            ? body.threadId
            : undefined;

        if (!message?.trim()) {
            return NextResponse.json({ error: 'message required' }, { status: 400 });
        }

        const result = await handleDashboardSend({ message, threadId });
        return NextResponse.json({ reply: result.reply });
    } catch (err: any) {
        console.error('Dashboard send error:', err.message);
        return NextResponse.json(
            { error: `Dashboard chat failed. ${err.message}` },
            { status: 500 },
        );
    }
}
