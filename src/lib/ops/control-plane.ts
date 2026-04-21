export type OpsControlCommand =
    | "restart_bot"
    | "run_ap_poll_now"
    | "run_nightshift_now"
    | "clear_stuck_processing";

export type OpsControlTarget = "aria-bot" | "watchdog";
export type OpsProjectStatus = "ACTIVE" | "COMING_UP" | "INACTIVE" | "UNKNOWN";
export type AgentHeartbeatStatus = "healthy" | "degraded" | "starting" | "stopped";

export interface OpsHealthSnapshot {
    projectStatus: string | null;
    staleCrons: string[];
    botHeartbeatAgeMinutes: number | null;
    apQueueBacklogAgeMinutes: number | null;
    apProcessingStuckCount: number;
    nightshiftBacklogAgeMinutes: number | null;
    nightshiftProcessingStuckCount: number;
    pendingExceptionCount: number;
    lastApForwardAgeMinutes: number | null;
    lastNightshiftCompletionAgeMinutes: number | null;
}

export interface OpsDecisionOptions {
    hasRecentRestartRequest?: boolean;
    heartbeatStaleMinutes?: number;
    apBacklogAlertMinutes?: number;
    nightshiftBacklogAlertMinutes?: number;
}

export interface OpsHealthDecision {
    degraded: boolean;
    shouldAlert: boolean;
    shouldRestart: boolean;
    reasons: string[];
}

export interface AgentHeartbeatRecord {
    agentName: string;
    status: AgentHeartbeatStatus;
    heartbeatAt: string;
    metadata: Record<string, unknown>;
}

const DEFAULT_HEARTBEAT_STALE_MINUTES = 10;
const DEFAULT_AP_BACKLOG_ALERT_MINUTES = 30;
const DEFAULT_NIGHTSHIFT_BACKLOG_ALERT_MINUTES = 60;
const RESTART_WORTHY_STALE_CRONS = new Set([
    "APPolling",
    "POSync",
    "BuildCompletionWatcher",
    "POReceivingWatcher",
    "StatIndexing",
]);

export function normalizeProjectStatus(status: string | null | undefined): OpsProjectStatus {
    switch ((status || "").toUpperCase()) {
        case "ACTIVE":
        case "ACTIVE_HEALTHY":
            return "ACTIVE";
        case "COMING_UP":
            return "COMING_UP";
        case "INACTIVE":
            return "INACTIVE";
        default:
            return "UNKNOWN";
    }
}

export function isSupabaseProjectReady(status: string | null | undefined): boolean {
    return normalizeProjectStatus(status) === "ACTIVE";
}

export function defaultTargetForCommand(command: OpsControlCommand): OpsControlTarget {
    if (command === "restart_bot") return "watchdog";
    return "aria-bot";
}

export function buildHeartbeatRecord(opts: {
    agentName: string;
    projectStatus?: string | null;
    metadata?: Record<string, unknown>;
    heartbeatAt?: Date;
}): AgentHeartbeatRecord {
    const normalizedStatus = normalizeProjectStatus(opts.projectStatus);
    const metadata = {
        ...(opts.metadata || {}),
        projectStatus: normalizedStatus,
    };

    return {
        agentName: opts.agentName,
        status: isSupabaseProjectReady(normalizedStatus) ? "healthy" : "degraded",
        heartbeatAt: (opts.heartbeatAt || new Date()).toISOString(),
        metadata,
    };
}

export function buildOpsHealthDecision(
    snapshot: OpsHealthSnapshot,
    options: OpsDecisionOptions = {},
): OpsHealthDecision {
    const reasons: string[] = [];
    const heartbeatStaleMinutes = options.heartbeatStaleMinutes ?? DEFAULT_HEARTBEAT_STALE_MINUTES;
    const apBacklogAlertMinutes = options.apBacklogAlertMinutes ?? DEFAULT_AP_BACKLOG_ALERT_MINUTES;
    const nightshiftBacklogAlertMinutes = options.nightshiftBacklogAlertMinutes ?? DEFAULT_NIGHTSHIFT_BACKLOG_ALERT_MINUTES;

    const projectStatus = normalizeProjectStatus(snapshot.projectStatus);
    if (!isSupabaseProjectReady(projectStatus)) {
        reasons.push(`project_not_ready:${projectStatus}`);
    }

    for (const staleCron of snapshot.staleCrons) {
        reasons.push(`stale_cron:${staleCron}`);
    }

    if ((snapshot.botHeartbeatAgeMinutes ?? Infinity) > heartbeatStaleMinutes) {
        reasons.push("bot_heartbeat_stale");
    }

    if ((snapshot.apQueueBacklogAgeMinutes ?? 0) >= apBacklogAlertMinutes) {
        reasons.push("ap_queue_backlog");
    }

    if ((snapshot.nightshiftBacklogAgeMinutes ?? 0) >= nightshiftBacklogAlertMinutes) {
        reasons.push("nightshift_queue_backlog");
    }

    if (snapshot.apProcessingStuckCount > 0) {
        reasons.push("ap_processing_stuck");
    }

    if (snapshot.nightshiftProcessingStuckCount > 0) {
        reasons.push("nightshift_processing_stuck");
    }

    if (snapshot.pendingExceptionCount > 0) {
        reasons.push("pending_ops_exceptions");
    }

    let shouldRestart = reasons.some((reason) => {
        if (reason === "bot_heartbeat_stale" || reason === "ap_processing_stuck" || reason === "nightshift_processing_stuck") {
            return true;
        }

        if (!reason.startsWith("stale_cron:")) {
            return false;
        }

        const taskName = reason.slice("stale_cron:".length);
        return RESTART_WORTHY_STALE_CRONS.has(taskName);
    });

    if (!isSupabaseProjectReady(projectStatus)) {
        shouldRestart = false;
    }

    if (options.hasRecentRestartRequest) {
        reasons.push("recent_restart_request");
        shouldRestart = false;
    }

    return {
        degraded: reasons.length > 0,
        shouldAlert: reasons.length > 0,
        shouldRestart,
        reasons,
    };
}
