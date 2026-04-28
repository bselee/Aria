/**
 * @file    /api/command-board/crons/route.ts
 * @purpose Returns the static CRON_JOBS definition list joined with the
 *          latest cron_runs row per name (for last-run timestamp + status).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardCrons } from "@/lib/command-board/service";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_req: NextRequest) {
    try {
        const crons = await getCommandBoardCrons();
        return NextResponse.json({ crons }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] crons error:", err);
        return NextResponse.json(
            { error: err?.message ?? "crons failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
