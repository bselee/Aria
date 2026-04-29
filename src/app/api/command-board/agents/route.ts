/**
 * @file    /api/command-board/agents/route.ts
 * @purpose Returns the v1 hardcoded agent hierarchy joined with the live
 *          .agents/** catalog, current heartbeats, and per-node active task
 *          counts. Frontend renders the org chart + drill-in metadata from
 *          this single payload.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildCatalog } from "@/lib/command-board/catalog";
import {
    getCommandBoardHeartbeats,
    getCommandBoardTaskList,
} from "@/lib/command-board/service";
import { getCurrentlyHandlingCounts, type IssueHandlerCounts } from "@/lib/intelligence/agent-issue";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// Handler-string → catalog-agent-id alias map. The Phase 2 issue ledger uses
// finer-grained handler identifiers (ap-reconciler, ap-agent, …) than the
// agent catalog (reconciliation, ap-agent, …). When a handler string isn't
// already a catalog id, route it to its umbrella agent so the dashboard
// rolls counts up to the right tree node.
const HANDLER_ALIAS: Record<string, string> = {
    "ap-reconciler": "reconciliation",
};

const EMPTY_COUNTS: IssueHandlerCounts = { working: 0, waitingExternal: 0, blocked: 0, total: 0 };

function addCounts(a: IssueHandlerCounts, b: IssueHandlerCounts): IssueHandlerCounts {
    return {
        working: a.working + b.working,
        waitingExternal: a.waitingExternal + b.waitingExternal,
        blocked: a.blocked + b.blocked,
        total: a.total + b.total,
    };
}

export async function GET(_req: NextRequest) {
    try {
        const catalog = await buildCatalog();

        let heartbeats: Awaited<ReturnType<typeof getCommandBoardHeartbeats>> = [];
        const heartbeatByAgent = new Map<string, (typeof heartbeats)[number]>();
        const activeByAgent: Record<string, number> = {};
        // Per-agent issue ledger counts (Phase 2). Same shape regardless of
        // whether the underlying query succeeded — empty map = zero overlay,
        // never breaks the page.
        let handlerCounts: Record<string, IssueHandlerCounts> = {};

        if (createClient()) {
            try {
                heartbeats = await getCommandBoardHeartbeats();
                for (const h of heartbeats) heartbeatByAgent.set(h.agent_name, h);
            } catch {
                /* best-effort */
            }
            // Active task counts: pull running + needs-will + autonomous
            // tallies once.
            try {
                const list = await getCommandBoardTaskList({ limit: 500 });
                for (const t of list.tasks) {
                    if (t.lane === "recently-closed") continue;
                    const owner = (t.owner ?? "").toLowerCase();
                    if (!owner) continue;
                    activeByAgent[owner] = (activeByAgent[owner] ?? 0) + 1;
                }
            } catch {
                /* best-effort */
            }
            try {
                handlerCounts = await getCurrentlyHandlingCounts();
            } catch {
                /* best-effort — render dashboard without the overlay */
            }
        }

        // Aliasing: collapse fine-grained handler strings (ap-reconciler) into
        // their catalog umbrella (reconciliation) so the tree node sees the
        // sum. Handlers that already match a catalog id pass through.
        const aliasedCounts: Record<string, IssueHandlerCounts> = {};
        for (const [handler, counts] of Object.entries(handlerCounts)) {
            const target = HANDLER_ALIAS[handler] ?? handler;
            aliasedCounts[target] = aliasedCounts[target]
                ? addCounts(aliasedCounts[target], counts)
                : counts;
        }

        const agents = catalog.agents.map((a) => ({
            ...a,
            heartbeat: heartbeatByAgent.get(a.id) ?? null,
            activeTaskCount: activeByAgent[a.id.toLowerCase()] ?? 0,
            currentlyHandling: aliasedCounts[a.id] ?? EMPTY_COUNTS,
        }));

        return NextResponse.json(
            {
                generatedAt: catalog.generatedAt,
                agents,
                agentFiles: catalog.agentFiles,
                skills: catalog.skills,
                workflows: catalog.workflows,
                references: catalog.references,
                heartbeats,
            },
            { headers: NO_STORE },
        );
    } catch (err: any) {
        console.error("[command-board] agents error:", err);
        return NextResponse.json(
            { error: err?.message ?? "agents failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
