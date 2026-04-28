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
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(_req: NextRequest) {
    try {
        const catalog = await buildCatalog();

        let heartbeats: Awaited<ReturnType<typeof getCommandBoardHeartbeats>> = [];
        const heartbeatByAgent = new Map<string, (typeof heartbeats)[number]>();
        const activeByAgent: Record<string, number> = {};

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
        }

        const agents = catalog.agents.map((a) => ({
            ...a,
            heartbeat: heartbeatByAgent.get(a.id) ?? null,
            activeTaskCount: activeByAgent[a.id.toLowerCase()] ?? 0,
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
