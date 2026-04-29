/**
 * @file    route.ts
 * @purpose GET /api/command-board/issues — list current issues.
 *          POST /api/command-board/issues — manual issue creation
 *          (source_table = NULL, created_by carried in inputs).
 *
 *          All responses set Cache-Control: no-store, including error
 *          paths. Manual POST returns 503 when createOrAdvance fails so
 *          the user-facing UX gets a clear error instead of {issue: null}.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCommandBoardIssues } from "@/lib/command-board/service";
import { createOrAdvance } from "@/lib/intelligence/agent-issue";

const NO_STORE = { "Cache-Control": "no-store" };

type LifecycleFilter =
    | "detected"
    | "triaging"
    | "working"
    | "waiting_external"
    | "blocked"
    | "complete";

const VALID_LIFECYCLES: LifecycleFilter[] = [
    "detected", "triaging", "working", "waiting_external", "blocked", "complete",
];

export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams;
    const stateParam = sp.get("lifecycleState");
    const states = stateParam
        ? stateParam.split(",")
            .map(s => s.trim())
            .filter((s): s is LifecycleFilter => VALID_LIFECYCLES.includes(s as LifecycleFilter))
        : undefined;
    const owner = sp.get("owner") ?? undefined;
    const limit = Math.min(parseInt(sp.get("limit") ?? "200", 10) || 200, 500);

    try {
        const result = await getCommandBoardIssues({ lifecycleState: states, owner, limit });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}

export async function POST(req: NextRequest) {
    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid json" }, { status: 400, headers: NO_STORE });
    }
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) {
        return NextResponse.json({ error: "title required" }, { status: 400, headers: NO_STORE });
    }
    const owner = typeof body?.owner === "string" ? body.owner : "aria";
    const priority = Number.isFinite(body?.priority)
        ? Math.max(0, Math.min(9, body.priority))
        : 2;
    const businessFlowKey = `manual:${randomUUID()}`;

    try {
        const issue = await createOrAdvance({
            businessFlowKey,
            title,
            sourceTable: null,
            sourceId: null,
            lifecycleState: "triaging",
            autonomyState: "working",
            owner,
            priority,
            inputs: {
                created_by: typeof body?.created_by === "string" ? body.created_by : "will-dashboard",
                manual: true,
                ...(body?.notes ? { notes: body.notes } : {}),
            },
        });
        if (!issue) {
            return NextResponse.json(
                { error: "issue creation unavailable (hub disabled or Supabase down)" },
                { status: 503, headers: NO_STORE },
            );
        }
        return NextResponse.json({ issue }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues] POST error:", err);
        return NextResponse.json({ error: err.message }, { status: 500, headers: NO_STORE });
    }
}
