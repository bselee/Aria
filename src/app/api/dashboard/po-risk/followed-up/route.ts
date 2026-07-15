import { NextResponse } from "next/server";
import { createClient } from "@/lib/db";

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

    const { error } = await supabase
        .from("ap_activity_log")
        .update({
            reviewed_at: new Date().toISOString(),
            reviewed_action: "followed_up",
        })
        .eq("id", activityId);
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
}
