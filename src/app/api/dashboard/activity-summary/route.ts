/**
 * @file    activity-summary/route.ts
 * @purpose API route for the auto-apply audit summary banner.
 *          Queries ap_activity_log for the last 24h and returns
 *          counts grouped by the new auto-apply / vendor-discrepancy intents.
 * @author  Hermia
 * @created 2026-06-19
 * @deps    @/lib/db
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";

export const dynamic = "force-dynamic";

export const revalidate = 60; // 1-minute cache

export async function GET() {
    const db = createClient();
    if (!db) {
        return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from("ap_activity_log")
        .select("intent")
        .gte("created_at", since);

    if (error) {
        console.error("[activity-summary] query failed:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const logs: { intent: string }[] = data ?? [];

    const autoApplied = logs.filter(l => l.intent === "RECONCILIATION_AUTO_APPLIED").length;
    const blocked = logs.filter(l => l.intent === "RECONCILIATION_BLOCKED").length;
    const errors = logs.filter(l => l.intent === "RECONCILIATION_ERROR").length;
    const emailed = logs.filter(l => l.intent === "VENDOR_QTY_DISCREPANCY_EMAILED").length;
    const resolved = logs.filter(l => l.intent === "VENDOR_QTY_DISCREPANCY_RESOLVED").length;
    const escalated = logs.filter(l => l.intent === "VENDOR_QTY_DISCREPANCY_ESCALATED").length;

    return NextResponse.json({
        autoApplied,
        blocked,
        errors,
        emailed,
        resolved,
        escalated,
        total: logs.length,
    });
}