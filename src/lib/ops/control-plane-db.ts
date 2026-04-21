import {
    defaultTargetForCommand,
    type AgentHeartbeatRecord,
    type OpsControlCommand,
    type OpsControlTarget,
} from "./control-plane";
import type { ClearStuckProcessingResult } from "./control-plane-runtime";

export interface OpsControlRequestRow {
    id: string;
    command: OpsControlCommand;
    target: OpsControlTarget | "all";
    status: "pending" | "claimed" | "completed" | "failed" | "cancelled";
    reason: string | null;
    payload: Record<string, unknown> | null;
    claimed_by: string | null;
    created_at: string;
}

export async function upsertAgentHeartbeat(supabase: any, heartbeat: AgentHeartbeatRecord): Promise<void> {
    await supabase.from("agent_heartbeats").upsert({
        agent_name: heartbeat.agentName,
        status: heartbeat.status,
        heartbeat_at: heartbeat.heartbeatAt,
        metadata: heartbeat.metadata,
        updated_at: heartbeat.heartbeatAt,
    }, { onConflict: "agent_name" });
}

export async function fetchOpsHealthSummary(supabase: any): Promise<any | null> {
    const { data, error } = await supabase
        .from("ops_health_summary")
        .select("*")
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

export async function createOpsControlRequest(
    supabase: any,
    request: {
        command: OpsControlCommand;
        target?: OpsControlTarget | "all";
        requestedBy: string;
        reason?: string;
        payload?: Record<string, unknown>;
    },
): Promise<OpsControlRequestRow> {
    const { data, error } = await supabase
        .from("ops_control_requests")
        .insert({
            command: request.command,
            target: request.target ?? defaultTargetForCommand(request.command),
            requested_by: request.requestedBy,
            reason: request.reason ?? null,
            payload: request.payload ?? {},
        })
        .select("*")
        .single();

    if (error) throw error;
    return data;
}

export async function claimNextOpsControlRequest(
    supabase: any,
    opts: { consumer: string; targets: Array<OpsControlTarget | "all"> },
): Promise<OpsControlRequestRow | null> {
    const { data: candidates, error } = await supabase
        .from("ops_control_requests")
        .select("*")
        .eq("status", "pending")
        .in("target", opts.targets)
        .order("created_at", { ascending: true })
        .limit(1);

    if (error) throw error;

    const candidate = candidates?.[0];
    if (!candidate) return null;

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
        .from("ops_control_requests")
        .update({
            status: "claimed",
            claimed_by: opts.consumer,
            claimed_at: claimedAt,
            updated_at: claimedAt,
        })
        .eq("id", candidate.id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();

    if (claimError) throw claimError;
    return claimed;
}

export async function completeOpsControlRequest(
    supabase: any,
    opts: {
        id: string;
        consumer: string;
        result?: Record<string, unknown>;
    },
): Promise<void> {
    const completedAt = new Date().toISOString();
    const { error } = await supabase
        .from("ops_control_requests")
        .update({
            status: "completed",
            completed_at: completedAt,
            result: opts.result ?? {},
            updated_at: completedAt,
        })
        .eq("id", opts.id)
        .eq("claimed_by", opts.consumer);

    if (error) throw error;
}

export async function failOpsControlRequest(
    supabase: any,
    opts: {
        id: string;
        consumer: string;
        errorMessage: string;
        result?: Record<string, unknown>;
    },
): Promise<void> {
    const completedAt = new Date().toISOString();
    const { error } = await supabase
        .from("ops_control_requests")
        .update({
            status: "failed",
            completed_at: completedAt,
            error_message: opts.errorMessage,
            result: opts.result ?? {},
            updated_at: completedAt,
        })
        .eq("id", opts.id)
        .eq("claimed_by", opts.consumer);

    if (error) throw error;
}

export async function resetStuckProcessing(supabase: any): Promise<ClearStuckProcessingResult> {
    const now = Date.now();
    const emailCutoff = new Date(now - 30 * 60 * 1000).toISOString();
    const apCutoff = new Date(now - 20 * 60 * 1000).toISOString();
    const nightshiftCutoff = new Date(now - 10 * 60 * 1000).toISOString();

    const [emailResult, apResult, nightshiftResult] = await Promise.all([
        supabase
            .from("email_inbox_queue")
            .update({
                status: "unprocessed",
                processed_by: null,
                updated_at: new Date().toISOString(),
                error_message: "Reset by ops control plane after stale processing lease",
            })
            .eq("status", "processing")
            .lt("updated_at", emailCutoff)
            .select("id"),
        supabase
            .from("ap_inbox_queue")
            .update({
                status: "PENDING_FORWARD",
                updated_at: new Date().toISOString(),
                error_message: "Reset by ops control plane after stale processing lease",
            })
            .eq("status", "PROCESSING_FORWARD")
            .lt("updated_at", apCutoff)
            .select("id"),
        supabase
            .from("nightshift_queue")
            .update({
                status: "pending",
                updated_at: new Date().toISOString(),
                error: "Reset by ops control plane after stale processing lease",
            })
            .eq("status", "processing")
            .lt("updated_at", nightshiftCutoff)
            .select("id"),
    ]);

    if (emailResult.error) throw emailResult.error;
    if (apResult.error) throw apResult.error;
    if (nightshiftResult.error) throw nightshiftResult.error;

    return {
        emailQueue: emailResult.data?.length ?? 0,
        apQueue: apResult.data?.length ?? 0,
        nightshiftQueue: nightshiftResult.data?.length ?? 0,
    };
}

export async function hasRecentOpsAlert(
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

export async function recordOpsAlertEvent(
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
