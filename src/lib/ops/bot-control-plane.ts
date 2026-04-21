import { createClient } from "../supabase";
import {
    buildHeartbeatRecord,
    buildOpsHealthDecision,
    isSupabaseProjectReady,
    type OpsControlCommand,
} from "./control-plane";
import {
    claimNextOpsControlRequest,
    completeOpsControlRequest,
    failOpsControlRequest,
    fetchOpsHealthSummary,
    resetStuckProcessing,
    upsertAgentHeartbeat,
} from "./control-plane-db";
import { executeBotControlCommand } from "./control-plane-runtime";
import { runNightshiftLoop } from "../intelligence/nightshift-agent";

const BOT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const BOT_CONTROL_POLL_INTERVAL_MS = 2 * 60 * 1000;

export interface BotOpsSurface {
    pollAPInbox: () => Promise<void>;
}

export interface LoggerLike {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

function extractProjectRef(projectUrl: string | null | undefined): string | null {
    const match = projectUrl?.match(/^https:\/\/([^.]+)\.supabase\.co/i);
    return match?.[1] ?? null;
}

export async function getSupabaseProjectStatus(
    fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
    const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    const projectRef = extractProjectRef(projectUrl);

    if (!projectRef) return null;

    if (accessToken) {
        try {
            const response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (response.ok) {
                const data = await response.json() as { status?: string };
                return data.status || null;
            }
        } catch {
            // Fall back to REST probe below.
        }
    }

    if (!projectUrl) return null;

    try {
        const response = await fetchImpl(`${projectUrl}/rest/v1/`, {
            method: "HEAD",
        });
        return response.status === 401 || response.ok ? "ACTIVE" : "UNKNOWN";
    } catch {
        return "UNKNOWN";
    }
}

export async function recordBotHeartbeatOnce(
    logger: LoggerLike = console,
): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) {
        logger.warn("[ops-control] Supabase unavailable, skipping bot heartbeat");
        return null;
    }

    const projectStatus = await getSupabaseProjectStatus();
    const heartbeat = buildHeartbeatRecord({
        agentName: "aria-bot",
        projectStatus,
        metadata: {
            pid: process.pid,
            cwd: process.cwd(),
        },
    });

    await upsertAgentHeartbeat(supabase, heartbeat);

    if (!isSupabaseProjectReady(projectStatus)) {
        logger.warn(`[ops-control] Supabase project not fully ready (${projectStatus || "UNKNOWN"})`);
    }

    return projectStatus;
}

export async function processBotControlRequestsOnce(
    ops: BotOpsSurface,
    logger: LoggerLike = console,
): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const request = await claimNextOpsControlRequest(supabase, {
        consumer: "aria-bot",
        targets: ["aria-bot", "all"],
    });

    if (!request) return;

    try {
        if (request.command === "restart_bot") {
            throw new Error("restart_bot is reserved for the local watchdog");
        }

        const result = await executeBotControlCommand(request.command as Extract<OpsControlCommand, "run_ap_poll_now" | "run_nightshift_now" | "clear_stuck_processing">, {
            pollAPInbox: () => ops.pollAPInbox(),
            runNightshiftLoop: () => runNightshiftLoop(),
            clearStuckProcessing: () => resetStuckProcessing(supabase),
        });

        await completeOpsControlRequest(supabase, {
            id: request.id,
            consumer: "aria-bot",
            result: { result },
        });
        logger.log(`[ops-control] Completed ${request.command} (${request.id})`);
    } catch (err: any) {
        await failOpsControlRequest(supabase, {
            id: request.id,
            consumer: "aria-bot",
            errorMessage: err?.message || "unknown control-plane error",
            result: { command: request.command },
        });
        logger.error(`[ops-control] Failed ${request.command} (${request.id}):`, err?.message || err);
    }
}

export async function evaluateCurrentOpsHealth(logger: LoggerLike = console) {
    const supabase = createClient();
    if (!supabase) return null;

    const summary = await fetchOpsHealthSummary(supabase);
    if (!summary) return null;

    const projectStatus = await getSupabaseProjectStatus();
    const decision = buildOpsHealthDecision({
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
    });

    if (decision.degraded) {
        logger.warn(`[ops-control] Current ops health degraded: ${decision.reasons.join(", ")}`);
    }

    return { summary, projectStatus, decision };
}

export function startBotControlPlane(
    ops: BotOpsSurface,
    logger: LoggerLike = console,
) {
    const runHeartbeat = () => void recordBotHeartbeatOnce(logger).catch((err) => {
        logger.error("[ops-control] Bot heartbeat failed:", err?.message || err);
    });
    const runControlPoll = () => void processBotControlRequestsOnce(ops, logger).catch((err) => {
        logger.error("[ops-control] Control request poll failed:", err?.message || err);
    });

    runHeartbeat();
    void evaluateCurrentOpsHealth(logger).catch(() => undefined);
    runControlPoll();

    const heartbeatTimer = setInterval(runHeartbeat, BOT_HEARTBEAT_INTERVAL_MS);
    const controlTimer = setInterval(runControlPoll, BOT_CONTROL_POLL_INTERVAL_MS);

    return {
        stop() {
            clearInterval(heartbeatTimer);
            clearInterval(controlTimer);
        },
    };
}
