import { createClient } from '@/lib/supabase';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

    const { data: existing } = await supabase
      .from('agent_heartbeats')
      .select('id')
      .eq('agent_name', agentName)
      .maybeSingle();

    await supabase.from('agent_heartbeats').upsert({
      id: existing?.id ?? randomUUID(),
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

    const { data: heartbeats } = await supabase.from('agent_heartbeats').select('*');
    if (!heartbeats) return;

    const now = new Date();

    for (const hb of heartbeats) {
      const elapsed = now.getTime() - new Date(hb.last_heartbeat_at).getTime();

      if (elapsed > this.heartbeatTimeout && hb.status !== 'DOWN') {
        await this.updateStatus(hb.agent_name, 'DOWN');
        await this.handleDownAgent(hb.agent_name);
      } else if (elapsed > this.heartbeatTimeout / 2 && hb.status === 'HEALTHY') {
        await this.updateStatus(hb.agent_name, 'DEGRADED');
      }
    }
  }

  private async updateStatus(agentName: string, status: AgentStatus): Promise<void> {
    const supabase = createClient();
    if (!supabase) return;

    await supabase
      .from('agent_heartbeats')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('agent_name', agentName);
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

  private async attemptRetry(agentName: string): Promise<RecoveryAction> {
    try {
      const supabase = createClient();
      if (!supabase) {
        return { action: 'retry', description: 'Supabase unavailable', success: false };
      }

      await supabase
        .from('agent_heartbeats')
        .update({ last_heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('agent_name', agentName);

      return { action: 'retry', description: `Heartbeat reset for ${agentName}`, success: true };
    } catch (e: any) {
      return { action: 'retry', description: `Retry failed: ${e.message}`, success: false };
    }
  }

  private async restartProcess(agentName: string): Promise<RecoveryAction> {
    try {
      const pm2Name = this.agentToPm2Name(agentName);
      await execAsync(`pm2 restart ${pm2Name}`);
      return { action: 'restart_process', description: `PM2 restart issued for ${pm2Name}`, success: true };
    } catch (e: any) {
      return { action: 'restart_process', description: `Restart failed: ${e.message}`, success: false };
    }
  }

  private async resetState(agentName: string): Promise<RecoveryAction> {
    try {
      const supabase = createClient();
      if (!supabase) {
        return { action: 'reset_state', description: 'Supabase unavailable', success: false };
      }

      await supabase
        .from('agent_heartbeats')
        .update({
          status: 'UNKNOWN',
          current_task: null,
          metrics: {},
          updated_at: new Date().toISOString(),
        })
        .eq('agent_name', agentName);

      return { action: 'reset_state', description: `State reset for ${agentName}`, success: true };
    } catch (e: any) {
      return { action: 'reset_state', description: `Reset failed: ${e.message}`, success: false };
    }
  }

  private async escalate(agentName: string, actions: RecoveryAction[]): Promise<void> {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      console.warn('[Oversight] TELEGRAM_CHAT_ID missing; cannot escalate.');
      return;
    }

    const attempts = actions
      .map(a => `• ${a.action}: ${a.description} (${a.success ? 'OK' : 'FAIL'})`)
      .join('\n');

    try {
      await execAsync(
        `pm2 describe ${this.agentToPm2Name(agentName)} --quiet`,
        { timeout: 5000 }
      );
    } catch {
      // PM2 process not found — don't send Telegram message for unknown agents
      return;
    }

    try {
      await execAsync(
        `curl -s -X POST https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage ` +
        `-d "chat_id=${chatId}" ` +
        `-d "text=🚨 <b>Agent DOWN — All Recovery Attempts Failed</b> 🚨\n\n<b>Agent:</b> ${agentName}\n<b>Recovery Actions:</b>\n${attempts}" ` +
        `-d "parse_mode=HTML"`,
        { timeout: 10000 }
      );
    } catch (e: any) {
      console.error(`[Oversight] Failed to send escalation via Telegram: ${e.message}`);
    }
  }

  private agentToPm2Name(agentName: string): string {
    const map: Record<string, string> = {
      'ap-agent': 'aria-bot',
      'slack-watchdog': 'aria-bot',
      'ops-manager': 'aria-bot',
      'nightshift-agent': 'aria-bot',
      'reconciler': 'aria-bot',
    };
    return map[agentName] ?? 'aria-bot';
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
