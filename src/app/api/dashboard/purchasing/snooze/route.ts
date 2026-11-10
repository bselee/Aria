/**
 * @file route.ts
 * @purpose Server-side persistence for purchasing-panel snoozes, so the Friday
 *          EOW report hides exactly what the dashboard hides.
 * @author Hermia
 * @created 2026-11-10
 * @deps next/server, @/lib/purchasing/snoozes
 *
 * GET    /api/dashboard/purchasing/snooze            → { snoozes: [...] }
 * POST   /api/dashboard/purchasing/snooze {key,days} → upsert
 * DELETE /api/dashboard/purchasing/snooze {key}      → remove
 */

import { NextRequest, NextResponse } from "next/server";
import { listActiveSnoozes, setSnooze, clearSnooze } from "@/lib/purchasing/snoozes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
    try {
        return NextResponse.json({ snoozes: listActiveSnoozes() });
    } catch (e: unknown) {
        return NextResponse.json(
            { snoozes: [], error: e instanceof Error ? e.message : String(e) },
            { status: 200 }
        );
    }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const body = await req.json().catch(() => null);
    const key = String(body?.key || "").trim();
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

    const raw = body?.until ?? body?.days;
    const until = raw === "forever"
        ? "forever"
        : new Date(Date.now() + (Number(raw) || 0) * 86_400_000).toISOString();

    if (until !== "forever" && Number.isNaN(Date.parse(until))) {
        return NextResponse.json({ error: "bad until" }, { status: 400 });
    }

    setSnooze(key, until);
    return NextResponse.json({ ok: true, key, until });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    const body = await req.json().catch(() => null);
    const key = String(body?.key || "").trim();
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
    clearSnooze(key);
    return NextResponse.json({ ok: true, key });
}
