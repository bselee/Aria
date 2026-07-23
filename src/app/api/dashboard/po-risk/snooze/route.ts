import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";

const DEFAULT_HOURS = 48;
const MAX_HOURS = 24 * 14; // 2 weeks

export async function POST(req: Request) {
    const db = createClient();
    if (!db) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }
    const activityId: string | undefined = body?.activityId;
    if (!activityId) {
        return NextResponse.json({ error: "activityId required" }, { status: 400 });
    }
    let hours = Number(body?.hours ?? DEFAULT_HOURS);
    if (!isFinite(hours) || hours <= 0) hours = DEFAULT_HOURS;
    if (hours > MAX_HOURS) hours = MAX_HOURS;

    const { data: row, error: readErr } = await db
        .from("ap_activity_log")
        .select("id, intent, metadata")
        .eq("id", activityId)
        .single();
    if (readErr || !row) {
        return NextResponse.json({ error: readErr?.message ?? "row not found" }, { status: 404 });
    }
    if (row.intent !== "PO_ARRIVAL_AT_RISK") {
        return NextResponse.json({ error: "activity row is not PO_ARRIVAL_AT_RISK" }, { status: 400 });
    }

    const snoozedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const nextMetadata = { ...(row.metadata ?? {}), snoozed_until: snoozedUntil, snooze_hours: hours };

    const { error: writeErr } = await db
        .from("ap_activity_log")
        .update({
            metadata: nextMetadata,
            reviewed_at: new Date().toISOString(),
            reviewed_action: "paused",
        })
        .eq("id", activityId);
    if (writeErr) {
        return NextResponse.json({ error: writeErr.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, snoozedUntil, hours });
}
