/**
 * @file    src/lib/intelligence/drop-detector.ts
 * @purpose Weekly "ball dropped" detector. Finds open agent_task rows older
 *          than 24h with no recent activity — items the system flagged that
 *          nobody acted on. Surfaces as a single summary report via the
 *          agent_task hub (drop_detect_report type, owner: will).
 */
import { createClient } from "@/lib/db";
import { complete, listTasks } from "./agent-task";
import { notifyViaTask } from "./notify-via-task";

const supabase = createClient();

export type DropDetectorResult = {
  droppedCount: number;
  dropped: Array<{
    id: string;
    type: string;
    goal: string;
    ageHours: number;
    owner: string;
    dedupCount: number;
  }>;
};

/**
 * Run drop detection: find open tasks >24h old. Returns result without
 * sending anything (caller decides whether to surface).
 */
export async function detectDroppedTasks(): Promise<DropDetectorResult> {
  const db = createClient();
  if (!db) return { droppedCount: 0, dropped: [] };

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("agent_task")
    .select("id, type, goal, created_at, owner, dedup_count")
    .in("status", ["PENDING", "NEEDS_APPROVAL", "CLAIMED"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error || !data) return { droppedCount: 0, dropped: [] };

  const dropped = data
    // Don't count our own prior reports as dropped balls.
    .filter((r: any) => r.type !== "drop_detect_report")
    .map((r: any) => ({
      id: r.id,
      type: r.type,
      goal: r.goal,
      ageHours: Math.round((Date.now() - new Date(r.created_at).getTime()) / 3_600_000),
      owner: r.owner,
      dedupCount: r.dedup_count ?? 1,
    }));

  return { droppedCount: dropped.length, dropped };
}

/**
 * Mark prior open reports of the same type SUCCEEDED so each week's report
 * supersedes the last one — keeps the hub from accumulating stale weekly rows.
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
    console.warn(`[drop-detector] supersede failed: ${err?.message ?? err}`);
  }
}

/**
 * Weekly entrypoint: detects drops and routes a summary report through
 * notifyViaTask. One task row, one Telegram summary. Called from cron.
 */
export async function surfaceDropReport(): Promise<void> {
  const result = await detectDroppedTasks();

  if (result.droppedCount === 0) {
    console.log("[drop-detector] No unactioned tasks in the last 24h+ — clean week.");
    return;
  }

  // Group by type for a compact summary
  const byType: Record<string, number> = {};
  for (const d of result.dropped) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
  }

  // Build goal: the summary text that becomes the task row goal
  const oldest = result.dropped[0];
  const typeBreakdown = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}: ${c}`)
    .join(" · ");

  const goal = [
    `${result.droppedCount} task(s) flagged but unactioned (>24h old)`,
    `Oldest: ${oldest.ageHours}h — ${oldest.goal}`,
    `By type: ${typeBreakdown}`,
  ].join("\n");

  const taskId = await notifyViaTask({
    sourceId: `drop-report:${new Date().toISOString().slice(0, 10)}`,
    type: "drop_detect_report",
    goal,
    inputs: {
      droppedCount: result.droppedCount,
      dropped: result.dropped.slice(0, 20),
      byType,
    },
    priority: 1,
    summaryLabel: "Dropped Balls Report",
  });

  // Supersession closure: retire last week's report once this one lands.
  await supersedePriorReports("drop_detect_report", taskId);

  console.log(`[drop-detector] Surfaced ${result.droppedCount} dropped task(s) → task ${taskId}`);
}
