/**
 * @file    /api/command-board/tasks/route.ts
 * @purpose Lane-ready task list with `lane`, `owner`, `sourceTable`, `limit`
 *          filters. Returns CommandBoardTaskCard rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardTaskList } from "@/lib/command-board/service";
import type { CommandBoardLane } from "@/lib/command-board/types";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const VALID_LANES: CommandBoardLane[] = [
    "needs-will",
    "running",
    "blocked-failed",
    "autonomous",
    "recently-closed",
];

export async function GET(req: NextRequest) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const sp = req.nextUrl.searchParams;
        const laneRaw = sp.get("lane");
        const lane =
            laneRaw && VALID_LANES.includes(laneRaw as CommandBoardLane)
                ? (laneRaw as CommandBoardLane)
                : undefined;

        const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "100", 10) || 100, 1), 500);
        const owner = sp.get("owner") ?? undefined;
        const sourceTable = sp.get("sourceTable") ?? sp.get("source_table") ?? undefined;

        const out = await getCommandBoardTaskList({
            lane,
            owner,
            sourceTable: sourceTable ?? undefined,
            limit,
        });

        return NextResponse.json(out, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] tasks error:", err);
        return NextResponse.json(
            { error: err?.message ?? "tasks failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
