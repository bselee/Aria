import { createClient } from '@/lib/supabase';

export type AgentStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface AgentHeartbeat {
  id: string;
  agent_name: string;
  last_heartbeat_at: Date;
  status: AgentStatus;
  current_task: string | null;
  metrics: Record<string, unknown>;
  updated_at: Date;
}

export interface RecoveryAction {
  action: 'retry' | 'restart_process' | 'reset_state' | 'escalate';
  description: string;
  success: boolean;
}

export class OversightAgent {
  private checkInterval: number;
  private heartbeatTimeout: number;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(checkIntervalMs = 5 * 60 * 1000, heartbeatTimeoutMs = 15 * 60 * 1000) {
    this.checkInterval = checkIntervalMs;
    this.heartbeatTimeout = heartbeatTimeoutMs;
  }

  async registerHeartbeat(agentName: string, currentTask?: string, metrics?: Record<string, unknown>): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    await supabase.from('agent_heartbeats').upsert({
      agent_name: agentName,
      last_heartbeat_at: new Date().toISOString(),
      status: 'HEALTHY',
      current_task: currentTask ?? null,
      metrics: metrics ?? {},
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'agent_name',
    });
  }

  async checkAllHeartbeats(): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    const cutoff = new Date(Date.now() - this.heartbeatTimeout).toISOString();

    const { data: heartbeats } = await supabase
      .from('agent_heartbeats')
      .select('*')
      .lt('last_heartbeat_at', cutoff);

    if (!heartbeats || heartbeats.length === 0) return;

    for (const hb of heartbeats) {
      await this.handleDownAgent(hb.agent_name);
    }
  }

  async handleDownAgent(agentName: string): Promise<RecoveryAction[]> {
    return [];
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
