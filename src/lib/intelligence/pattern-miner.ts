/**
 * @file    src/lib/intelligence/pattern-miner.ts
 * @purpose Weekly closed-loop metrics from agent_task. Computes per-type:
 *          time-to-close (median hours), drop-rate (% that expire rather
 *          than succeed), and volume. The only data source a pattern miner
 *          can learn from is CLOSED LOOPS — so this waits until tasks
 *          have actually been resolved or expired before counting.
 */
import { createClient } from "@/lib/db";
import { complete, listTasks } from "./agent-task";
import { notifyViaTask } from "./notify-via-task";

const supabase = createClient();

export type TypeMetrics = {
  type: string;
  total: number;
  succeeded: number;
  expired: number;
  failed: number;
  droppedRate: number;        // expired / (succeeded + expired)
  medianCloseHours: number;   // median of (completed_at - created_at) for succeeded
};

export type PatternMinerResult = {
  weekStart: string;
  weekEnd: string;
  metrics: TypeMetrics[];
  totalTasks: number;
  worstDropType: string | null;
};

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}

/**
 * Aggregate closed-loop metrics for tasks completed/expired in the last 7 days.
 */
export async function mineTaskPatterns(): Promise<PatternMinerResult> {
  const db = createClient();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const weekStart = weekAgo.toISOString();
  const weekEnd = now.toISOString();

  if (!db) {
    return { weekStart, weekEnd, metrics: [], totalTasks: 0, worstDropType: null };
  }

  const { data, error } = await supabase
    .from("agent_task")
    .select("type, status, created_at, completed_at")
    .in("status", ["SUCCEEDED", "EXPIRED", "FAILED"])
    .gte("completed_at", weekStart)
    .lt("completed_at", weekEnd);

  if (error || !data || data.length === 0) {
    return { weekStart, weekEnd, metrics: [], totalTasks: 0, worstDropType: null };
  }

  // Group by type
  const buckets: Record<string, { succeeded: number; expired: number; failed: number; closeHours: number[] }> = {};
  for (const row of data as any[]) {
    const t: string = row.type;
    if (!buckets[t]) buckets[t] = { succeeded: 0, expired: 0, failed: 0, closeHours: [] };
    if (row.status === "SUCCEEDED") buckets[t].succeeded++;
    else if (row.status === "EXPIRED") buckets[t].expired++;
    else if (row.status === "FAILED") buckets[t].failed++;

    if (row.status === "SUCCEEDED" && row.created_at && row.completed_at) {
      const hours = (new Date(row.completed_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000;
      if (hours > 0 && hours < 720) buckets[t].closeHours.push(hours); // cap at 30d
    }
  }

  const metrics: TypeMetrics[] = Object.entries(buckets).map(([type, b]) => {
    const total = b.succeeded + b.expired + b.failed;
    const closed = b.succeeded + b.expired;
    const droppedRate = closed > 0 ? b.expired / closed : 0;
    const medianCloseHours = median(b.closeHours);
    return { type, total, succeeded: b.succeeded, expired: b.expired, failed: b.failed, droppedRate, medianCloseHours };
  });

  // Find worst drop-rate type (min 3 tasks to avoid division noise)
  const worst = metrics
    .filter(m => m.total >= 3)
    .sort((a, b) => b.droppedRate - a.droppedRate)[0];

  return {
    weekStart,
    weekEnd,
    metrics,
    totalTasks: data.length,
    worstDropType: worst?.type ?? null,
  };
}

/**
 * Mark prior open insights SUCCEEDED so each week's report supersedes the last.
 * Best-effort; supersession failure never blocks the new report.
 */
async function supersedePriorReports(type: string, keepTaskId: string | null): Promise<void> {
  try {
    const open = await listTasks({ type: [type], includeRecentFailed: false });
    for (const t of open) {
      if (t.id === keepTaskId) continue;
      await complete(t.id, { superseded_by: keepTaskId, summary: "superseded by newer weekly report" });
    }
  } catch (err: any) {
    console.warn(`[pattern-miner] supersede failed: ${err?.message ?? err}`);
  }
}

/**
 * Weekly entrypoint: mines patterns and surfaces a summary via notifyViaTask.
 * Called from cron every Monday at 8 AM.
 */
export async function surfacePatternInsight(): Promise<void> {
  const result = await mineTaskPatterns();

  if (result.totalTasks === 0) {
    console.log("[pattern-miner] No closed-loop tasks in the last 7d — skipping.");
    return;
  }

  // Build compact summary
  const lines = result.metrics
    .filter(m => m.total >= 2)
    .sort((a, b) => b.droppedRate - a.droppedRate)
    .map(m => {
      const dropPct = Math.round(m.droppedRate * 100);
      const close = m.medianCloseHours ? `${m.medianCloseHours}h` : "—";
      return `${m.type}: ${m.total} tasks, ${dropPct}% expire, ${close} median close`;
    });

  const goal = [
    `Weekly task metrics: ${result.totalTasks} closed in 7d`,
    result.worstDropType ? `⚠️ Highest drop-rate: ${result.worstDropType}` : "—",
    ...lines,
  ].join("\n");

  const weekLabel = new Date(result.weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const taskId = await notifyViaTask({
    sourceId: `patterns:${weekLabel}`,
    type: "pattern_miner_insight",
    goal,
    inputs: {
      totalTasks: result.totalTasks,
      metrics: result.metrics,
      worstDropType: result.worstDropType,
    },
    priority: 3,
    summaryLabel: "Weekly Pattern Report",
  });

  // Supersession closure: retire last week's insight once this one lands.
  await supersedePriorReports("pattern_miner_insight", taskId);

  console.log(`[pattern-miner] Surfaced ${result.metrics.length} type metric rows (${result.totalTasks} tasks).`);
}
