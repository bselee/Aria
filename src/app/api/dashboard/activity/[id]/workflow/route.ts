import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

const VALID_PROCESS_STATES = new Set([
    "new",
    "opened",
    "waiting_on_vendor",
    "handled",
    "learned",
]);

type RouteContext = {
    params: Promise<{ id: string }> | { id: string };
};

async function getParams(context: RouteContext): Promise<{ id: string }> {
    return await context.params;
}

export async function PATCH(req: Request, context: RouteContext) {
    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
    }

    const { id } = await getParams(context);
    if (!id) {
        return NextResponse.json({ error: "missing activity id" }, { status: 400 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid json body" }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(body, "note")) {
        const note = String(body.note ?? "").trim();
        patch.human_note = note.length > 0 ? note : null;
        patch.human_note_by = "will";
        patch.human_note_at = new Date().toISOString();
    }

    if (Object.prototype.hasOwnProperty.call(body, "processState")) {
        const processState = String(body.processState ?? "");
        if (!VALID_PROCESS_STATES.has(processState)) {
            return NextResponse.json({ error: "unsupported process state" }, { status: 400 });
        }
        patch.process_state = processState;
    }

    if (Object.prototype.hasOwnProperty.call(body, "resolution")) {
        const resolution = String(body.resolution ?? "").trim();
        patch.resolution = resolution.length > 0 ? resolution : null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "learningCandidate")) {
        patch.learning_candidate = Boolean(body.learningCandidate);
    }

    if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: "no supported workflow fields" }, { status: 400 });
    }

    const { data, error } = await supabase
        .from("ap_activity_log")
        .update(patch)
        .eq("id", id)
        .select("id, human_note, process_state, resolution, learning_candidate")
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ activity: data });
}
