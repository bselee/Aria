/**
 * @file    src/lib/ops/bot-control-plane.ts
 * @purpose Bot-side ops control plane: heartbeats, control-request poll, health eval.
 *          DB readiness probes local PostgREST only (cloud Supabase removed 2026-07-01).
 *          Soft-fails when DB is COMING_UP / unreachable — no throw storms.
 * @author  Aria / Hermia
 * @created 2026-03 (rewritten 2026-07-13 for local PostgREST)
 * @deps    ../db, ./control-plane, ./control-plane-db, ./control-plane-runtime, ./postgrest-ready
 * @env     PGRST_URL | NEXT_PUBLIC_SUPABASE_URL — PostgREST base URL
 */

import { createClient } from "../db";
import {
    buildHeartbeatRecord,
    buildOpsHealthDecision,
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
import { probePostgrestReady } from "./postgrest-ready";

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

/**
 * Probe local PostgREST readiness.
 * ACTIVE only when a real table query succeeds (via probePostgrestReady).
 */
export async function getPostgrestProjectStatus(
    _fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
    const state = await probePostgrestReady(_fetchImpl);
    if (state === "MISSING_URL") return null;
    return state;
}

/** @deprecated Use getPostgrestProjectStatus — kept for external callers. */
export async function getSupabaseProjectStatus(
    fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
    return getPostgrestProjectStatus(fetchImpl);
}

function isReadyStatus(status: string | null | undefined): boolean {
    const s = (status || "").trim().toUpperCase();
    return s === "ACTIVE" || s === "ACTIVE_HEALTHY";
}

export async function recordBotHeartbeatOnce(
    logger: LoggerLike = console,
): Promise<string | null> {
    const projectStatus = await getPostgrestProjectStatus();

    if (!isReadyStatus(projectStatus)) {
        // Soft-fail: do not attempt upsert while schema cache / WSL is flapping
        logger.warn(
            `[ops-control] Local PostgREST not ready (${projectStatus || "UNKNOWN"}) — skip heartbeat write`,
        );
        return projectStatus;
    }

    const db = createClient();
    if (!db) {
        logger.warn("[ops-control] PostgREST client unavailable, skipping bot heartbeat");
        return null;
    }

    const heartbeat = buildHeartbeatRecord({
        agentName: "aria-bot",
        projectStatus,
        metadata: {
            pid: process.pid,
            cwd: process.cwd(),
            dbPlane: "local-postgrest",
        },
    });

    try {
        await upsertAgentHeartbeat(db, heartbeat);
    } catch (err: any) {
        logger.warn(
            `[ops-control] Heartbeat upsert soft-failed: ${err?.message || err}`,
        );
        return projectStatus;
    }

    return projectStatus;
}

export async function processBotControlRequestsOnce(
    ops: BotOpsSurface,
    logger: LoggerLike = console,
): Promise<void> {
    const projectStatus = await getPostgrestProjectStatus();
    if (!isReadyStatus(projectStatus)) {
        // Quiet skip — avoid "Control request poll failed: fetch failed" spam
        return;
    }

    const db = createClient();
    if (!db) return;

    let request: Awaited<ReturnType<typeof claimNextOpsControlRequest>> = null;
    try {
        request = await claimNextOpsControlRequest(db, {
            consumer: "aria-bot",
            targets: ["aria-bot", "all"],
        });
    } catch (err: any) {
        logger.warn(
            `[ops-control] Control claim soft-failed: ${err?.message || err}`,
        );
        return;
    }

    if (!request) return;

    try {
        if (request.command === "restart_bot") {
            throw new Error("restart_bot is reserved for the local watchdog");
        }

        const result = await executeBotControlCommand(
            request.command as Extract<
                OpsControlCommand,
                "run_ap_poll_now" | "run_nightshift_now" | "clear_stuck_processing"
            >,
            {
                pollAPInbox: () => ops.pollAPInbox(),
                runNightshiftLoop: () => runNightshiftLoop(),
                clearStuckProcessing: () => resetStuckProcessing(db),
            },
        );

        await completeOpsControlRequest(db, {
            id: request.id,
            consumer: "aria-bot",
            result: { result },
        });
        logger.log(`[ops-control] Completed ${request.command} (${request.id})`);
    } catch (err: any) {
        try {
            await failOpsControlRequest(db, {
                id: request.id,
                consumer: "aria-bot",
                errorMessage: err?.message || "unknown control-plane error",
                result: { command: request.command },
            });
        } catch {
            // DB may have dropped mid-fail — already logged below
        }
        logger.error(
            `[ops-control] Failed ${request.command} (${request.id}):`,
            err?.message || err,
        );
    }
}

export async function evaluateCurrentOpsHealth(logger: LoggerLike = console) {
    const projectStatus = await getPostgrestProjectStatus();
    if (!isReadyStatus(projectStatus)) {
        logger.warn(
            `[ops-control] Health eval skipped — PostgREST ${projectStatus || "UNKNOWN"}`,
        );
        return null;
    }

    const db = createClient();
    if (!db) return null;

    let summary: Awaited<ReturnType<typeof fetchOpsHealthSummary>> = null;
    try {
        summary = await fetchOpsHealthSummary(db);
    } catch (err: any) {
        logger.warn(
            `[ops-control] Health summary soft-failed: ${err?.message || err}`,
        );
        return null;
    }
    if (!summary) return null;

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
        logger.warn(
            `[ops-control] Current ops health degraded: ${decision.reasons.join(", ")}`,
        );
    }

    return { summary, projectStatus, decision };
}

export function startBotControlPlane(
    ops: BotOpsSurface,
    logger: LoggerLike = console,
) {
    const runHeartbeat = () =>
        void recordBotHeartbeatOnce(logger).catch((err) => {
            logger.warn(
                "[ops-control] Bot heartbeat soft-failed:",
                err?.message || err,
            );
        });
    const runControlPoll = () =>
        void processBotControlRequestsOnce(ops, logger).catch((err) => {
            logger.warn(
                "[ops-control] Control request poll soft-failed:",
                err?.message || err,
            );
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
