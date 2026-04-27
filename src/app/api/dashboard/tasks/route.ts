/**
 * @file    route.ts
 * @purpose Dashboard Tasks API — returns the unified Aria control-plane queue
 *          backed by the `agent_task` table. Read-only in phase 1.
 *
 *          GET  /api/dashboard/tasks              → all open tasks
 *          GET  /api/dashboard/tasks?status=…     → filter by status (CSV)
 *          GET  /api/dashboard/tasks?type=…       → filter by type (CSV)
 *          GET  /api/dashboard/tasks?owner=…      → filter by owner
 *          GET  /api/dashboard/tasks?bust=1       → bypass module cache
 *
 *          Cache: 30-second module cache, busted by ?bust=1 or POST.
 *          Phase 2 will add POST handlers for approve/reject; phase 1 is read-only.
 *
 *          See .agents/plans/control-plane.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { listTasks, type AgentTask } from "@/lib/intelligence/agent-task";

// ── Types ────────────────────────────────────────────────────────────────────

export type TasksResponse = {
    tasks: AgentTask[];
    counts: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        byOwner: Record<string, number>;
    };
    cachedAt: string;
};

// ── Module-level cache ───────────────────────────────────────────────────────

const CACHE_TTL = 30 * 1000;
type CacheEntry = { result: TasksResponse; at: number };
const cacheByKey = new Map<string, CacheEntry>();

function cacheKey(req: NextRequest): string {
    const sp = req.nextUrl.searchParams;
    return JSON.stringify({
        status: sp.get("status") ?? "",
        type: sp.get("type") ?? "",
        owner: sp.get("owner") ?? "",
        limit: sp.get("limit") ?? "",
    });
}

const OPEN_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "NEEDS_APPROVAL"];

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams;
    const bust = sp.has("bust");
    const key = cacheKey(req);

    if (!bust) {
        const cached = cacheByKey.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL) {
            return NextResponse.json(cached.result, { headers: { "Cache-Control": "no-store" } });
        }
    }

    try {
        const statusFilter = sp.get("status");
        const statusList = statusFilter
            ? statusFilter.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
            : undefined;

        const typeFilter = sp.get("type");
        const typeList = typeFilter
            ? typeFilter.split(",").map(s => s.trim()).filter(Boolean)
            : undefined;

        const limit = Math.min(parseInt(sp.get("limit") ?? "200", 10) || 200, 500);
        const tasks = await listTasks({
            status: statusList,
            type: typeList,
            owner: sp.get("owner") ?? undefined,
            limit,
            includeRecentFailed: !statusFilter,
        }) as AgentTask[];

        const counts = {
            total: tasks.length,
            byStatus: {} as Record<string, number>,
            byType: {} as Record<string, number>,
            byOwner: {} as Record<string, number>,
        };
        for (const t of tasks) {
            counts.byStatus[t.status] = (counts.byStatus[t.status] ?? 0) + 1;
            counts.byType[t.type] = (counts.byType[t.type] ?? 0) + 1;
            counts.byOwner[t.owner] = (counts.byOwner[t.owner] ?? 0) + 1;
        }

        const result: TasksResponse = {
            tasks,
            counts,
            cachedAt: new Date().toISOString(),
        };

        cacheByKey.set(key, { result, at: Date.now() });

        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (err: any) {
        console.error("[tasks] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── POST — bust cache (phase 2 will add approve/reject) ─────────────────────

export async function POST(_req: NextRequest) {
    cacheByKey.clear();
    return NextResponse.json({ ok: true });
}
