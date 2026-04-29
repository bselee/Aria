/**
 * @file    [id]/route.ts
 * @purpose GET /api/command-board/issues/:id — issue detail with merged
 *          (issue + linked-task) timeline.
 *
 *          All responses set Cache-Control: no-store including error
 *          paths.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCommandBoardIssueDetail } from "@/lib/command-board/service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const detail = await getCommandBoardIssueDetail(params.id);
        if (!detail) {
            return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
        }
        return NextResponse.json(detail, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues:id] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}
