import { createClient } from "@/lib/supabase";
import type { OpsControlCommand } from "@/lib/ops/control-plane";
import { createOpsControlRequest } from "@/lib/ops/control-plane-db";
import * as agentTask from "./agent-task";

export type AgentStatus = "healthy" | "degraded" | "starting" | "stopped";

export interface AgentHeartbeat {
  id: string;
  agent_name: string;
  heartbeat_at: Date;
  status: AgentStatus;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

export interface RecoveryAction {
  action: "retry" | "restart_process" | "reset_state" | "escalate";
  description: string;
  success: boolean;
}

interface RecoveryContext {
  agentName: string;
  currentTask: string | null;
  metrics: Record<string, unknown>;
  heartbeat: AgentHeartbeat | null;
}

interface RecoveryRegistration {
  retry?: (context: RecoveryContext) => Promise<boolean | void>;
  resetState?: (context: RecoveryContext) => Promise<boolean | void>;
  controlCommand?: OpsControlCommand;
}

export class OversightAgent {
  private checkInterval: number;
  private heartbeatTimeout: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private recoveries = new Map<string, RecoveryRegistration>();

  constructor(checkIntervalMs = 5 * 60 * 1000, heartbeatTimeoutMs = 15 * 60 * 1000) {
    this.checkInterval = checkIntervalMs;
    this.heartbeatTimeout = heartbeatTimeoutMs;
  }

  registerRecovery(agentName: string, recovery: RecoveryRegistration): void {
    this.recoveries.set(agentName, recovery);
  }

  async registerHeartbeat(agentName: string, currentTask?: string, metrics?: Record<string, unknown>): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    await supabase.from("agent_heartbeats").upsert({
      agent_name: agentName,
      heartbeat_at: new Date().toISOString(),
      status: "healthy",
      metadata: {
        currentTask: currentTask ?? null,
        metrics: metrics ?? {},
      },
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "agent_name",
    });
  }

  async checkAllHeartbeats(): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const { data: heartbeats } = await supabase.from("agent_heartbeats").select("*");
    if (!heartbeats) return;

    const now = Date.now();

    for (const hb of heartbeats as any[]) {
      const elapsed = now - new Date(hb.heartbeat_at).getTime();

      if (elapsed > this.heartbeatTimeout && hb.status !== "stopped") {
        await this.updateStatus(hb.agent_name, "stopped");
        await this.handleDownAgent(hb.agent_name);
      } else if (elapsed > this.heartbeatTimeout / 2 && hb.status === "healthy") {
        await this.updateStatus(hb.agent_name, "degraded");
      }
    }
  }

  private async updateStatus(agentName: string, status: AgentStatus): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    await supabase
      .from("agent_heartbeats")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("agent_name", agentName);
  }

  async handleDownAgent(agentName: string): Promise<RecoveryAction[]> {
    const actions: RecoveryAction[] = [];

    const retry = await this.attemptRetry(agentName);
    actions.push(retry);
    if (retry.success) return actions;

    const restart = await this.restartProcess(agentName);
    actions.push(restart);
    if (restart.success) return actions;

    const reset = await this.resetState(agentName);
    actions.push(reset);
    if (reset.success) return actions;

    await this.escalate(agentName, actions);
    return actions;
  }

  private async buildContext(agentName: string): Promise<RecoveryContext> {
    const supabase = createClient();
    if (!supabase) {
      return {
        agentName,
        currentTask: null,
        metrics: {},
        heartbeat: null,
      };
    }

    try {
      const { data } = await supabase
        .from("agent_heartbeats")
        .select("*")
        .eq("agent_name", agentName)
        .maybeSingle();

      const metadata = (data?.metadata as Record<string, unknown> | undefined) ?? {};
      return {
        agentName,
        currentTask: (metadata.currentTask as string | null | undefined) ?? null,
        metrics: (metadata.metrics as Record<string, unknown> | undefined) ?? {},
        heartbeat: (data as AgentHeartbeat | null) ?? null,
      };
    } catch {
      return {
        agentName,
        currentTask: null,
        metrics: {},
        heartbeat: null,
      };
    }
  }

  private async attemptRetry(agentName: string): Promise<RecoveryAction> {
    try {
      const recovery = this.recoveries.get(agentName);
      if (!recovery?.retry) {
        return { action: "retry", description: `No retry hook registered for ${agentName}`, success: false };
      }

      const outcome = await recovery.retry(await this.buildContext(agentName));
      if (outcome === false) {
        return { action: "retry", description: `Retry hook returned false for ${agentName}`, success: false };
      }

      try {
        await this.registerHeartbeat(agentName, "recovered via retry", { recovered: true });
      } catch {
        // Recovery success is more important than heartbeat refresh.
      }
      return { action: "retry", description: `Retry hook completed for ${agentName}`, success: true };
    } catch (e: any) {
      return { action: "retry", description: `Retry failed: ${e.message}`, success: false };
    }
  }

  private async restartProcess(agentName: string): Promise<RecoveryAction> {
    try {
      const recovery = this.recoveries.get(agentName);
      if (!recovery?.controlCommand) {
        return { action: "restart_process", description: `No control-plane command registered for ${agentName}`, success: false };
      }

      const supabase = createClient();
      if (!supabase) {
        return { action: "restart_process", description: "Supabase unavailable", success: false };
      }

      await createOpsControlRequest(supabase, {
        command: recovery.controlCommand,
        requestedBy: "oversight-agent",
        reason: `Automatic recovery for ${agentName}`,
        payload: { agentName },
      });

      return { action: "restart_process", description: `Requested ${recovery.controlCommand} for ${agentName}`, success: true };
    } catch (e: any) {
      return { action: "restart_process", description: `Restart failed: ${e.message}`, success: false };
    }
  }

  private async resetState(agentName: string): Promise<RecoveryAction> {
    try {
      const recovery = this.recoveries.get(agentName);
      if (!recovery?.resetState) {
        return { action: "reset_state", description: `No reset hook registered for ${agentName}`, success: false };
      }

      const outcome = await recovery.resetState(await this.buildContext(agentName));
      if (outcome === false) {
        return { action: "reset_state", description: `Reset hook returned false for ${agentName}`, success: false };
      }

      try {
        await this.registerHeartbeat(agentName, "state reset", { reset: true });
      } catch {
        // Recovery success is more important than heartbeat refresh.
      }
      return { action: "reset_state", description: `Reset hook completed for ${agentName}`, success: true };
    } catch (e: any) {
      return { action: "reset_state", description: `Reset failed: ${e.message}`, success: false };
    }
  }

  private async escalate(agentName: string, actions: RecoveryAction[]): Promise<void> {
    const supabase = createClient();
    if (!supabase) {
      console.error(`[Oversight] Escalation needed for ${agentName}`, actions);
      return;
    }

    try {
      const requestRow = await createOpsControlRequest(supabase, {
        command: "restart_bot",
        requestedBy: "oversight-agent",
        reason: `Escalation after failed recovery for ${agentName}`,
        payload: { agentName, actions },
      });

      // Mirror to control-plane hub. Best-effort; never block the runbook.
      try {
        const taskId = await agentTask.upsertFromSource({
          sourceTable: "ops_control_requests",
          sourceId: String(requestRow.id),
          type: "control_command",
          goal: `Restart bot — escalation for ${agentName} after failed recovery`,
          status: "PENDING",
          owner: "aria",
          priority: 0,
          inputs: {
            agent_name: agentName,
            command: "restart_bot",
            actions,
          },
        });
        if (taskId) {
          await supabase.from("ops_control_requests")
            .update({ task_id: taskId })
            .eq("id", requestRow.id);
        }
      } catch { /* hub write is best-effort */ }
    } catch (err: any) {
      console.error(`[Oversight] Failed to escalate ${agentName}: ${err.message}`);
    }
  }

  async start(): Promise<void> {
    this.intervalHandle = setInterval(() => {
      this.checkAllHeartbeats().catch(console.error);
    }, this.checkInterval);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
