/**
 * @file    src/app/api/dashboard/cognitive-rounds/route.ts
 * @purpose GET endpoint for cognitive round decision history.
 *          Returns the last N hours of adaptive priority decisions.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/intelligence/cognitive-round
 */

import { NextResponse } from "next/server";
import { getRecentDecisions } from "@/lib/intelligence/cognitive-round";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const hours = parseInt(searchParams.get("hours") || "24", 10);

    try {
        const rounds = getRecentDecisions(hours);
        return NextResponse.json({ rounds });
    } catch (err: any) {
        return NextResponse.json(
            { error: err.message || "Failed to read cognitive rounds" },
            { status: 500 },
        );
    }
}
