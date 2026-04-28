/**
 * @file    /api/command-board/route.ts
 * @purpose Top-level summary for the Command Board: lane counts + agent
 *          health rollup + cron health rollup. Read-fresh per request.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardSummary } from "@/lib/command-board/service";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_req: NextRequest) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const summary = await getCommandBoardSummary();
        return NextResponse.json(summary, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] summary error:", err);
        return NextResponse.json(
            { error: err?.message ?? "summary failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
