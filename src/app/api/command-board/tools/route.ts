/**
 * @file    /api/command-board/tools/route.ts
 * @purpose Returns the live Aria tool catalog (Phase 2 / Day 3).
 *          Joins registered tools (currently the 8 copilot reads) with
 *          metadata so the dashboard can show "what can Aria actually
 *          do" alongside skills and workflows.
 */

import { NextRequest, NextResponse } from "next/server";
import { listTools, type ListToolsFilter, type ToolCategory, type ToolScope } from "@/lib/agents/tool-registry";
import { ensureCopilotToolsRegistered } from "@/lib/agents/register-copilot-tools";
import { ensureFinaleToolsRegistered } from "@/lib/agents/register-finale-tools";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
    try {
        // Make sure the copilot read tools are present in the registry. Other
        // tool sources (bot inline tools, finale write helpers) will register
        // themselves from their own modules as they're migrated.
        ensureCopilotToolsRegistered();
        ensureFinaleToolsRegistered();

        const url = new URL(req.url);
        const filter: ListToolsFilter = {};
        const cat = url.searchParams.get("category");
        const scope = url.searchParams.get("scope");
        const agent = url.searchParams.get("agent");
        if (cat) filter.category = cat as ToolCategory;
        if (scope) filter.scope = scope as ToolScope;
        if (agent) filter.agentScope = agent;

        const tools = listTools(filter);

        // Group by category for the dashboard's accordion render.
        const byCategory: Record<string, typeof tools> = {};
        for (const t of tools) {
            (byCategory[t.category] ??= []).push(t);
        }

        return NextResponse.json(
            {
                generatedAt: new Date().toISOString(),
                total: tools.length,
                byCategory,
                tools,
            },
            { headers: NO_STORE },
        );
    } catch (err: any) {
        console.error("[command-board] tools error:", err);
        return NextResponse.json(
            { error: err?.message ?? "tools failed" },
            { status: 500, headers: NO_STORE },
        );
    }
}
