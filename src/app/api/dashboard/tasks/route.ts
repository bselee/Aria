/**
 * @file    route.ts
 * @purpose Dashboard Tasks API — compatibility wrapper around the
 *          command-board task service.
 *
 *          GET  /api/dashboard/tasks              → all open tasks
 *          GET  /api/dashboard/tasks?status=…     → filter by status (CSV)
 *          GET  /api/dashboard/tasks?type=…       → filter by type (CSV)
 *          GET  /api/dashboard/tasks?owner=…      → filter by owner
 *          GET  /api/dashboard/tasks?bust=1       → bypass module cache
 *
 *          Cache: 30-second module cache, busted by ?bust=1 or POST.
 *
 *          DECISION(2026-04-28): Delegated to `getDashboardTasks` in
 *          src/lib/command-board/service.ts so that the standalone
 *          /dashboard/tasks page and the new /dashboard command-board
 *          read the same task source. This route is a thin compat
 *          wrapper — its existence is preserved only so older clients
 *          that fetch it (the standalone tasks page) keep working
 *          without changes.
 */

import { NextRequest, NextResponse } from "next/server";
import {
    getDashboardTasks,
    type DashboardTasksResult,
} from "@/lib/command-board/service";

// ── Module-level cache ───────────────────────────────────────────────────────

const CACHE_TTL = 30 * 1000;
type CacheEntry = { result: DashboardTasksResult; at: number };
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

        const result = await getDashboardTasks({
            status: statusList,
            type: typeList,
            owner: sp.get("owner") ?? undefined,
            limit,
            includeRecentFailed: !statusFilter,
        });

        cacheByKey.set(key, { result, at: Date.now() });

        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (err: any) {
        console.error("[tasks] GET error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── POST — bust cache ───────────────────────────────────────────────────────

export async function POST(_req: NextRequest) {
    cacheByKey.clear();
    return NextResponse.json({ ok: true });
}
