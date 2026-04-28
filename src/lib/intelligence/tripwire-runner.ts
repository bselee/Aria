/**
 * @file    tripwire-runner.ts
 * @purpose Translate TripwireResult[] into agent_task hub writes.
 *
 *          Failing tripwires create or dedup `tripwire_violation` rows via
 *          `incrementOrCreate`. Passing tripwires auto-close any open row
 *          for the same tripwire — the writer is the single source of
 *          closure (no separate closeFinishedTasks predicate involved).
 *
 *          Best-effort: a hub write failure for one tripwire never blocks
 *          processing of the next. Logged + swallowed.
 */

import * as agentTask from "@/lib/intelligence/agent-task";
import type { TripwireResult } from "./tripwires";

const OPEN_STATUSES = new Set(["PENDING", "NEEDS_APPROVAL", "RUNNING", "CLAIMED"]);

export async function applyTripwireResults(results: TripwireResult[]): Promise<void> {
    for (const r of results) {
        try {
            if (!r.ok) {
                await agentTask.incrementOrCreate({
                    type: "tripwire_violation",
                    sourceTable: "tripwires",
                    sourceId: r.tripwire,
                    goal: r.summary,
                    owner: "aria",
                    priority: 1,
                    requiresApproval: false,
                    inputs: { tripwire: r.tripwire, ranAt: r.ranAt, ...r.detail },
                });
                continue;
            }
            const open = await agentTask.getBySource("tripwires", r.tripwire);
            if (open && OPEN_STATUSES.has(open.status)) {
                await agentTask.complete(open.id, {
                    auto_handled_by: "tripwire-runner",
                    resolution: r.summary,
                    ranAt: r.ranAt,
                });
            }
        } catch (err) {
            console.warn(`[tripwire-runner] failed for ${r.tripwire}:`, err instanceof Error ? err.message : err);
        }
    }
}
