/**
 * @file    /api/command-board/issues/[id]/actions/route.ts
 * @purpose Issue-level action API. Originally just approve/reject/resolve
 *          (Phase 2). Now also accepts the typed control actions
 *          (set_control_mode / assign_handler / pause / resume /
 *          set_blocker / clear_blocker / run_next_step / complete) per
 *          plan task 5. Telegram + dashboard converge on this single
 *          handler so behavior never diverges.
 *
 *          Legacy actions (approve/reject/resolve) keep their existing
 *          contract and route through the AP reconciler path when a
 *          linked task exists, so Phase 2 issue-ledger lifecycle is
 *          preserved.
 */

import { NextRequest, NextResponse } from "next/server";
import * as agentIssue from "@/lib/intelligence/agent-issue";
import { approveTask, rejectTask } from "@/lib/command-board/task-actions";
import { applyIssueControlAction, type IssueControlActionInput } from "@/lib/intelligence/issue-control-actions";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type LegacyActionRequest = { action: "approve" | "reject" | "resolve" };

const LEGACY_ACTIONS = new Set(["approve", "reject", "resolve"]);
const CONTROL_ACTIONS = new Set([
    "set_control_mode",
    "assign_handler",
    "pause",
    "resume",
    "set_blocker",
    "clear_blocker",
    "run_next_step",
    "complete",
]);

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        if (!id) {
            return NextResponse.json({ error: "missing issue id" }, { status: 400, headers: NO_STORE });
        }

        const body = (await req.json()) as { action?: string } & Record<string, unknown>;
        const action = body?.action;

        if (typeof action !== "string") {
            return NextResponse.json({ error: "missing action" }, { status: 400, headers: NO_STORE });
        }

        // Legacy: approve / reject / resolve preserved exactly as before.
        if (LEGACY_ACTIONS.has(action)) {
            return handleLegacyAction(id, action as LegacyActionRequest["action"]);
        }

        // New: control-action surface from Plan task 5.
        if (CONTROL_ACTIONS.has(action)) {
            const actor = (typeof body.actor === "string" ? body.actor : null) ?? "will-dashboard";
            const controlInput = { ...body, actor } as IssueControlActionInput;
            const result = await applyIssueControlAction(id, controlInput);
            const status = result.ok ? 200 : 400;
            return NextResponse.json(result, { status, headers: NO_STORE });
        }

        return NextResponse.json({ error: `invalid action: ${action}` }, { status: 400, headers: NO_STORE });
    } catch (err: any) {
        console.error("[issues:actions] POST error:", err);
        return NextResponse.json(
            { error: err?.message ?? "action failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}

async function handleLegacyAction(
    id: string,
    action: "approve" | "reject" | "resolve",
): Promise<NextResponse> {
    const issue = await agentIssue.getById(id);
    if (!issue) {
        return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
    }
    if (issue.lifecycle_state === "complete") {
        return NextResponse.json({ ok: true, message: "Already complete." }, { headers: NO_STORE });
    }

    const actor = "will-dashboard";

    if (action === "approve" || action === "reject") {
        const linked = await agentIssue.findLinkedOpenTask(id);
        if (linked) {
            const result = action === "approve"
                ? await approveTask(linked.id, actor)
                : await rejectTask(linked.id, actor);
            if (!result.ok) {
                return NextResponse.json(
                    { error: result.replyText, detail: result.error },
                    { status: 500, headers: NO_STORE },
                );
            }
            return NextResponse.json(
                { ok: true, message: result.replyText, via: "task" },
                { headers: NO_STORE },
            );
        }
    }

    // Direct resolve path: clearBlocker + complete.
    if (issue.lifecycle_state === "blocked") {
        await agentIssue.clearBlocker(id, "working");
    }
    const resolution = action === "approve" ? "approved"
        : action === "reject" ? "rejected"
            : "manually_resolved";
    await agentIssue.complete(id, {
        resolution,
        resolved_by: actor,
        via: "issue_action",
    });

    return NextResponse.json(
        { ok: true, message: `Issue ${resolution}.`, via: "issue" },
        { headers: NO_STORE },
    );
}
