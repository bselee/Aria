/**
 * @file    src/app/api/dashboard/tracking/accuracy/route.ts
 * @purpose Read the latest tracking-accuracy snapshot so the dashboard can
 *          surface the number Bill asked to be confident in (2026-10-28).
 *          Single cheap read — the heavy board path is untouched.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
    try {
        const db = createClient();
        if (!db) return NextResponse.json({ error: "DB unavailable" }, { status: 500 });

        const { data } = await db
            .from("ap_activity_log")
            .select("created_at, metadata")
            .eq("intent", "TRACKING_ACCURACY_REPORT")
            .order("created_at", { ascending: false })
            .limit(1);

        const row = (data || [])[0] as { created_at?: string; metadata?: unknown } | undefined;
        if (!row) return NextResponse.json({ latest: null });

        const meta = (row.metadata || {}) as Record<string, unknown>;
        return NextResponse.json({
            latest: {
                summary: meta.summary ?? null,
                etaCoveragePct: meta.etaCoveragePct ?? null,
                onTimePct: meta.onTimePct ?? null,
                stalePct: meta.stalePct ?? null,
                created_at: row.created_at ?? null,
            },
        });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
}
