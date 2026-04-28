/**
 * @file    /api/command-board/crons/[name]/runs/route.ts
 * @purpose Returns the recent cron_runs history for a named cron job. Used
 *          by the dashboard to render a per-cron timeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardCronRuns } from "@/lib/command-board/service";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const { name } = await params;
        if (!name) {
            return NextResponse.json(
                { error: "missing cron name" },
                { status: 400, headers: NO_STORE },
            );
        }
        const limit = Math.min(
            Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50, 1),
            500,
        );
        const runs = await getCommandBoardCronRuns(name, limit);
        return NextResponse.json({ name, runs }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] cron runs error:", err);
        return NextResponse.json(
            { error: err?.message ?? "cron runs failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
