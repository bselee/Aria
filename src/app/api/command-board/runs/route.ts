/**
 * @file    /api/command-board/runs/route.ts
 * @purpose Unified feed of `task_history` (event ledger) and `cron_runs`
 *          rows, normalized into a single CommandBoardRun shape sorted by
 *          most recent first. Filter via ?source=task_history|cron_runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardRuns } from "@/lib/command-board/service";
import type { CommandBoardRunFilters } from "@/lib/command-board/types";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const sp = req.nextUrl.searchParams;
        const sourceRaw = sp.get("source");
        const source: CommandBoardRunFilters["source"] =
            sourceRaw === "task_history" || sourceRaw === "cron_runs" ? sourceRaw : undefined;
        const limit = Math.min(
            Math.max(parseInt(sp.get("limit") ?? "100", 10) || 100, 1),
            500,
        );
        const runs = await getCommandBoardRuns({ source, limit });
        return NextResponse.json({ runs }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] runs error:", err);
        return NextResponse.json(
            { error: err?.message ?? "runs failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
