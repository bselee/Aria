/**
 * @file    route.ts
 * @purpose Bot health status endpoint. Allows the dashboard to detect
 *          whether the aria-bot PM2 process is alive, which makes shutdown/
 *          restart events visible in the UI rather than silently losing state.
 * @author  Hermia
 * @created 2026-06-16
 * @deps    supabase/createClient
 * @env     N/A (public endpoint)
 *
 * GET /api/bot-health
 *
 * Returns:
 *   {
 *     alive: boolean,
 *     pid: number | null,
 *     uptime: number | null,    // seconds since bot started (or null)
 *     lastHeartbeat: string | null,  // ISO timestamp (or null)
 *     status: 'alive' | 'dead' | 'unknown',
 *   }
 *
 * The dashboard can poll this to show a "Bot offline" indicator when
 * the PM2 process has crashed or been stopped.
 */

import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
    const startTime = Date.now();

    try {
        const db = createClient();
        let lastHeartbeat: string | null = null;
        let pid: number | null = null;

        if (db) {
            // Read the latest heartbeat from agent_heartbeats
            const { data } = await db
                .from('agent_heartbeats')
                .select('last_seen, metadata')
                .eq('agent_name', 'aria-bot')
                .single();

            if (data) {
                lastHeartbeat = data.last_seen || null;
                pid = data.metadata?.pid ?? null;
            }
        }

        // Determine if bot is alive: heartbeat within last 10 minutes
        let alive = false;
        if (lastHeartbeat) {
            const ageMs = Date.now() - new Date(lastHeartbeat).getTime();
            alive = ageMs < 10 * 60 * 1000; // 10-minute heartbeat threshold
        }

        const uptime = pid !== null
            ? Math.round((Date.now() - startTime) / 1000)
            : null;

        const status = alive ? 'alive' : (lastHeartbeat ? 'dead' : 'unknown');

        return NextResponse.json({
            alive,
            pid,
            uptime,
            lastHeartbeat,
            status,
        });
    } catch {
        return NextResponse.json({
            alive: false,
            pid: null,
            uptime: null,
            lastHeartbeat: null,
            status: 'unknown',
        });
    }
}
