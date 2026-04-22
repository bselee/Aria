import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/supabase";
import {
    claimNextOpsControlRequest,
    completeOpsControlRequest,
    failOpsControlRequest,
    fetchOpsHealthSummary,
} from "../lib/ops/control-plane-db";
import { buildOpsHealthDecision } from "../lib/ops/control-plane";
import { getSupabaseProjectStatus } from "../lib/ops/bot-control-plane";

function getArg(flag: string): string | null {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

async function main(): Promise<void> {
    const command = process.argv[2];
    const supabase = createClient();

    if (!supabase) {
        throw new Error("Supabase client not available");
    }

    if (command === "lease") {
        const consumer = getArg("--consumer") || "watchdog";
        const targets = (getArg("--targets") || "watchdog,all")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean) as Array<"watchdog" | "aria-bot" | "all">;
        const leased = await claimNextOpsControlRequest(supabase, { consumer, targets });
        console.log(JSON.stringify(leased ?? null));
        return;
    }

    if (command === "complete") {
        const id = getArg("--id");
        const consumer = getArg("--consumer") || "watchdog";
        const result = getArg("--result");
        if (!id) throw new Error("--id is required");
        await completeOpsControlRequest(supabase, {
            id,
            consumer,
            result: result ? { result } : {},
        });
        console.log(JSON.stringify({ ok: true, id }));
        return;
    }

    if (command === "fail") {
        const id = getArg("--id");
        const consumer = getArg("--consumer") || "watchdog";
        const errorMessage = getArg("--error") || "unknown failure";
        if (!id) throw new Error("--id is required");
        await failOpsControlRequest(supabase, {
            id,
            consumer,
            errorMessage,
            result: {},
        });
        console.log(JSON.stringify({ ok: true, id }));
        return;
    }

    if (command === "health") {
        const summary = await fetchOpsHealthSummary(supabase);
        const projectStatus = await getSupabaseProjectStatus();
        const decision = summary ? buildOpsHealthDecision({
            projectStatus,
            staleCrons: summary.stale_crons || [],
            botHeartbeatAgeMinutes: summary.bot_heartbeat_age_minutes,
            apQueueBacklogAgeMinutes: summary.ap_queue_backlog_age_minutes,
            apProcessingStuckCount: summary.ap_processing_stuck_count || 0,
            nightshiftBacklogAgeMinutes: summary.nightshift_queue_backlog_age_minutes,
            nightshiftProcessingStuckCount: summary.nightshift_processing_stuck_count || 0,
            pendingExceptionCount: summary.pending_exception_count || 0,
            lastApForwardAgeMinutes: summary.last_ap_forward_age_minutes,
            lastNightshiftCompletionAgeMinutes: summary.last_nightshift_completion_age_minutes,
        }) : null;
        console.log(JSON.stringify({ projectStatus, summary, decision }, null, 2));
        return;
    }

    throw new Error(`Unknown ops-control command: ${command || "(missing)"}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
