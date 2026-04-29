/**
 * @file    /api/command-board/issues/[id]/actions/route.ts
 * @purpose Issue-level action API for the dashboard. Mirrors the Telegram
 *          inline buttons (Approve / Reject / Resolve) so Will can act on
 *          a blocking issue without opening the task detail panel first.
 *
 *          Approve/Reject route through the linked open task when one
 *          exists (so the AP-pipeline reconciler stays the single source
 *          of truth for ap_pending_approvals decisions). Resolve closes
 *          the issue directly via clearBlocker + complete — used for
 *          non-approval blockers that Will fixed manually.
 */

import { NextRequest, NextResponse } from "next/server";
import * as agentIssue from "@/lib/intelligence/agent-issue";
import { approveTask, rejectTask } from "@/lib/command-board/task-actions";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ActionRequest = {
    action: "approve" | "reject" | "resolve";
};

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        if (!id) {
            return NextResponse.json({ error: "missing issue id" }, { status: 400, headers: NO_STORE });
        }
        const body = (await req.json()) as ActionRequest;
        const action = body.action;
        if (action !== "approve" && action !== "reject" && action !== "resolve") {
            return NextResponse.json({ error: "invalid action" }, { status: 400, headers: NO_STORE });
        }

        const issue = await agentIssue.getById(id);
        if (!issue) {
            return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
        }
        if (issue.lifecycle_state === "complete") {
            return NextResponse.json({ ok: true, message: "Already complete." }, { headers: NO_STORE });
        }

        const actor = "will-dashboard";

        // Approve / Reject route through the linked task when one exists so the
        // AP reconciler's decideApprovalBySource path runs. The Day 1.6 wiring
        // in task-actions.ts then closes the issue automatically.
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
            // No linked task → fall through to direct issue resolution.
        }

        // Direct resolve path: clearBlocker (if blocked) + complete with the
        // appropriate resolution string. Used for non-approval blockers and
        // for the explicit "Resolve" button.
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
    } catch (err: any) {
        console.error("[issues:actions] POST error:", err);
        return NextResponse.json(
            { error: err?.message ?? "action failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
