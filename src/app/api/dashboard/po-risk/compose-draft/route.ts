import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";
import { composeAndSaveDraftFromActivity } from "@/lib/intelligence/po-eta-draft";

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

    const { data: row, error } = await supabase
        .from("ap_activity_log")
        .select("id, intent, metadata")
        .eq("id", activityId)
        .single();
    if (error || !row) {
        return NextResponse.json({ error: error?.message ?? "row not found" }, { status: 404 });
    }
    if (row.intent !== "PO_ARRIVAL_AT_RISK") {
        return NextResponse.json({ error: "activity row is not PO_ARRIVAL_AT_RISK" }, { status: 400 });
    }

    const result = await composeAndSaveDraftFromActivity(row.id, row.metadata);
    if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ success: true, ...result });
}
