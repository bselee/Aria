/**
 * @file    /api/command-board/control-requests/route.ts
 * @purpose GET — recent ops_control_requests rows for the Command Board.
 *          POST — create a new control request (restart_bot, run_ap_poll_now,
 *          run_nightshift_now, clear_stuck_processing). Dedup is enforced by
 *          createOpsControlRequest at the DB layer.
 */

import { NextRequest, NextResponse } from "next/server";
import {
    createCommandBoardControlRequest,
    getCommandBoardControlRequests,
} from "@/lib/command-board/service";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const ALLOWED_COMMANDS = new Set([
    "restart_bot",
    "run_ap_poll_now",
    "run_nightshift_now",
    "clear_stuck_processing",
]);

const ALLOWED_TARGETS = new Set(["aria-bot", "watchdog", "all"]);

export async function GET(req: NextRequest) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    try {
        const limit = Math.min(
            Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "100", 10) || 100, 1),
            500,
        );
        const requests = await getCommandBoardControlRequests(limit);
        return NextResponse.json({ requests }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] control-requests GET error:", err);
        return NextResponse.json(
            { error: err?.message ?? "control-requests failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}

export async function POST(req: NextRequest) {
    if (!createClient()) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }
    let body: any = {};
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: "invalid JSON body" },
            { status: 400, headers: NO_STORE },
        );
    }

    const command = String(body?.command ?? "");
    if (!ALLOWED_COMMANDS.has(command)) {
        return NextResponse.json(
            { error: `unknown command: ${command}` },
            { status: 400, headers: NO_STORE },
        );
    }
    const target = body?.target != null ? String(body.target) : undefined;
    if (target && !ALLOWED_TARGETS.has(target)) {
        return NextResponse.json(
            { error: `unknown target: ${target}` },
            { status: 400, headers: NO_STORE },
        );
    }

    try {
        const created = await createCommandBoardControlRequest({
            command,
            target,
            reason: typeof body?.reason === "string" ? body.reason : undefined,
            payload: typeof body?.payload === "object" && body?.payload ? body.payload : undefined,
            requestedBy:
                typeof body?.requestedBy === "string" ? body.requestedBy : "command-board",
        });
        if (!created) {
            return NextResponse.json(
                { error: "supabase unavailable" },
                { status: 503, headers: NO_STORE },
            );
        }
        return NextResponse.json({ request: created }, { status: 201, headers: NO_STORE });
    } catch (err: any) {
        console.error("[command-board] control-requests POST error:", err);
        return NextResponse.json(
            { error: err?.message ?? "control-requests POST failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
