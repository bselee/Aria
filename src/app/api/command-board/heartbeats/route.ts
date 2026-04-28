/**
 * @file    /api/command-board/heartbeats/route.ts
 * @purpose Returns the current `agent_heartbeats` rows annotated with a
 *          fresh/stale/degraded staleness bucket.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardHeartbeats } from "@/lib/command-board/service";
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
        const heartbeats = await getCommandBoardHeartbeats();
        return NextResponse.json({ heartbeats }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] heartbeats error:", err);
        return NextResponse.json(
            { error: err?.message ?? "heartbeats failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
