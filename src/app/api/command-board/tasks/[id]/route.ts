/**
 * @file    /api/command-board/tasks/[id]/route.ts
 * @purpose Single-task drill-in for the Command Board. Returns the row plus
 *          its event ledger and parent/children info.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardTaskDetail } from "@/lib/command-board/service";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const { id } = await params;
        if (!id) {
            return NextResponse.json(
                { error: "missing task id" },
                { status: 400, headers: NO_STORE },
            );
        }
        const detail = await getCommandBoardTaskDetail(id);
        if (!detail) {
            return NextResponse.json(
                { error: "task not found" },
                { status: 404, headers: NO_STORE },
            );
        }
        return NextResponse.json(detail, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] task detail error:", err);
        return NextResponse.json(
            { error: err?.message ?? "task detail failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
