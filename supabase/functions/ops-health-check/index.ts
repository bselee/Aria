import { createClient } from "npm:@supabase/supabase-js@2";

type OpsProjectStatus = "ACTIVE" | "COMING_UP" | "INACTIVE" | "UNKNOWN";

interface OpsHealthSnapshot {
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

interface OpsHealthDecision {
    degraded: boolean;
    shouldAlert: boolean;
    shouldRestart: boolean;
    reasons: string[];
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function normalizeProjectStatus(status: string | null | undefined): OpsProjectStatus {
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

function isSupabaseProjectReady(status: string | null | undefined): boolean {
    return normalizeProjectStatus(status) === "ACTIVE";
}

function buildOpsHealthDecision(snapshot: OpsHealthSnapshot): OpsHealthDecision {
    const reasons: string[] = [];
    const projectStatus = normalizeProjectStatus(snapshot.projectStatus);

    if (!isSupabaseProjectReady(projectStatus)) {
        reasons.push(`project_not_ready:${projectStatus}`);
    }

    for (const staleCron of snapshot.staleCrons) {
        reasons.push(`stale_cron:${staleCron}`);
    }

    if ((snapshot.botHeartbeatAgeMinutes ?? Infinity) > 10) {
        reasons.push("bot_heartbeat_stale");
    }

    if ((snapshot.apQueueBacklogAgeMinutes ?? 0) >= 30) {
        reasons.push("ap_queue_backlog");
    }

    if ((snapshot.nightshiftBacklogAgeMinutes ?? 0) >= 60) {
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

    let shouldRestart = reasons.some((reason) =>
        reason.startsWith("stale_cron:")
        || reason === "bot_heartbeat_stale"
        || reason === "ap_processing_stuck"
        || reason === "nightshift_processing_stuck"
    );

    if (!isSupabaseProjectReady(projectStatus)) {
        shouldRestart = false;
    }

    return {
        degraded: reasons.length > 0,
        shouldAlert: reasons.length > 0,
        shouldRestart,
        reasons,
    };
}

async function fetchOpsHealthSummary(supabase: any): Promise<any | null> {
    const { data, error } = await supabase
        .from("ops_health_summary")
        .select("*")
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

async function hasRecentOpsAlert(
    supabase: any,
    opts: { alertKey: string; lookbackMinutes: number },
): Promise<boolean> {
    const cutoff = new Date(Date.now() - opts.lookbackMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from("ops_alert_events")
        .select("id")
        .eq("alert_key", opts.alertKey)
        .gte("created_at", cutoff)
        .limit(1);

    if (error) throw error;
    return Boolean(data?.length);
}

async function recordOpsAlertEvent(
    supabase: any,
    opts: {
        alertKey: string;
        alertType: string;
        status: "sent" | "suppressed" | "failed";
        payload?: Record<string, unknown>;
    },
): Promise<void> {
    const { error } = await supabase
        .from("ops_alert_events")
        .insert({
            alert_key: opts.alertKey,
            alert_type: opts.alertType,
            status: opts.status,
            payload: opts.payload ?? {},
        });

    if (error) throw error;
}

async function createOpsControlRequest(
    supabase: any,
    request: {
        command: "restart_bot";
        target: "watchdog";
        requestedBy: string;
        reason?: string;
        payload?: Record<string, unknown>;
    },
): Promise<{ id: string }> {
    const { data, error } = await supabase
        .from("ops_control_requests")
        .insert({
            command: request.command,
            target: request.target,
            requested_by: request.requestedBy,
            reason: request.reason ?? null,
            payload: request.payload ?? {},
        })
        .select("id")
        .single();

    if (error) throw error;
    return data;
}

async function sendTelegramAlert(message: string): Promise<boolean> {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (!token || !chatId) return false;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
        }),
    });

    return response.ok;
}

async function sendSlackWebhook(message: string): Promise<boolean> {
    const webhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
    if (!webhookUrl) return false;

    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message.replace(/<[^>]+>/g, "") }),
    });

    return response.ok;
}

function buildAlertMessage(decision: OpsHealthDecision, summary: any): string {
    const reasons = decision.reasons.map((reason) => `- ${reason}`).join("\n");
    return [
        "ARIA Ops Health Degraded",
        "",
        `Health status: ${summary.health_status || "unknown"}`,
        `Stale crons: ${(summary.stale_crons || []).join(", ") || "none"}`,
        `AP backlog age: ${summary.ap_queue_backlog_age_minutes ?? "n/a"} min`,
        `Nightshift backlog age: ${summary.nightshift_queue_backlog_age_minutes ?? "n/a"} min`,
        `Pending exceptions: ${summary.pending_exception_count ?? 0}`,
        "",
        "Reasons:",
        reasons,
    ].join("\n");
}

Deno.serve(async () => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("NEXT_PUBLIC_SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
        return json({ error: "Missing Supabase function environment" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const summary = await fetchOpsHealthSummary(supabase);
    if (!summary) {
        return json({ degraded: false, reason: "no_health_summary" });
    }

    const projectStatus = Deno.env.get("SUPABASE_PROJECT_STATUS") || "ACTIVE";
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

    if (!decision.degraded) {
        return json({ degraded: false, summary });
    }

    const alertLookbackMinutes = Number(Deno.env.get("OPS_ALERT_LOOKBACK_MINUTES") || "60");
    const alertKey = `ops-health:${decision.reasons.slice().sort().join("|") || "generic"}`;
    const recentlyAlerted = await hasRecentOpsAlert(supabase, {
        alertKey,
        lookbackMinutes: alertLookbackMinutes,
    });

    let telegramSent = false;
    let slackSent = false;
    if (!recentlyAlerted && decision.shouldAlert) {
        const message = buildAlertMessage(decision, summary);
        try {
            [telegramSent, slackSent] = await Promise.all([
                sendTelegramAlert(message),
                sendSlackWebhook(message),
            ]);
            await recordOpsAlertEvent(supabase, {
                alertKey,
                alertType: "ops_health_degraded",
                status: telegramSent || slackSent ? "sent" : "failed",
                payload: {
                    reasons: decision.reasons,
                    summary,
                    telegramSent,
                    slackSent,
                },
            });
        } catch (err) {
            console.error("[ops-health-check] alert dispatch failed", err);
            await recordOpsAlertEvent(supabase, {
                alertKey,
                alertType: "ops_health_degraded",
                status: "failed",
                payload: {
                    reasons: decision.reasons,
                    summary,
                },
            });
        }
    } else if (recentlyAlerted) {
        await recordOpsAlertEvent(supabase, {
            alertKey,
            alertType: "ops_health_degraded",
            status: "suppressed",
            payload: { reasons: decision.reasons },
        });
    }

    let controlRequestId: string | null = null;
    if (decision.shouldRestart) {
        const restartKey = "ops-health:restart-bot";
        const recentRestart = await hasRecentOpsAlert(supabase, {
            alertKey: restartKey,
            lookbackMinutes: alertLookbackMinutes,
        });

        if (!recentRestart) {
            const request = await createOpsControlRequest(supabase, {
                command: "restart_bot",
                target: "watchdog",
                requestedBy: "supabase-edge-function",
                reason: decision.reasons.join(", "),
                payload: { summary },
            });
            controlRequestId = request.id;
            await recordOpsAlertEvent(supabase, {
                alertKey: restartKey,
                alertType: "restart_requested",
                status: "sent",
                payload: {
                    requestId: request.id,
                    reasons: decision.reasons,
                },
            });
        }
    }

    return json({
        degraded: true,
        decision,
        summary,
        controlRequestId,
        telegramSent,
        slackSent,
    });
});
