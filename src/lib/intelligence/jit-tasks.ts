/**
 * @file    jit-tasks.ts
 * @purpose Route JIT "order trigger" alerts through the agent_task control plane
 *          instead of firing a raw Telegram notification. Each imminent
 *          order-trigger becomes a durable, owned, deduped, auto-closeable task.
 *
 *          This is the first emit point converted from notification-first to
 *          task-first (see .agents/plans/control-plane.md and the emit-to-task
 *          gap map). The Telegram message becomes an annotation on top of the
 *          hub rows rather than the system of record.
 *
 * Dedup key: incrementOrCreate dedups on (source_table, source_id, input_hash).
 *   - source_id = `jit:<sku>`            → one obligation per component
 *   - inputs    = { sku, vendor, triggerDate } → the obligation identity
 * Re-running on the same snapshot (same sku + same trigger date) bumps
 * dedup_count instead of creating a new row — that is the "5 alerts → 1 row"
 * noise collapse. When the trigger date genuinely shifts, that is a new
 * obligation window and a new row is correct.
 */

import { incrementOrCreate, type IncrementOrCreateArgs } from "./agent-task";

export type JitTrigger = {
    sku: string;
    riskLevel: string;
    triggerDate: string;
    coverageDays?: number | null;
    vendorName?: string | null;
    stockoutDays?: number | null;
    onHand?: number | null;
    usedIn: string[];
};

export const JIT_SOURCE_TABLE = "build_risk_snapshots";

/**
 * Map a single JIT trigger to the hub-row args. Pure — no I/O — so the mapping
 * (priority, dedup identity, goal text) is unit-testable without Supabase.
 *
 * `todayISO` is the caller's "today" (YYYY-MM-DD) so urgency is deterministic
 * in tests.
 */
export function buildJitTaskArgs(t: JitTrigger, todayISO: string): IncrementOrCreateArgs {
    const isToday = t.triggerDate <= todayISO;
    // priority is numeric, lower = more urgent (matches the rest of the hub).
    // Due today or already CRITICAL → 1; everything else in the window → 2.
    const priority = isToday || t.riskLevel === "CRITICAL" ? 1 : 2;

    const vendor = t.vendorName ?? "unknown vendor";
    const feeds = t.usedIn.length ? ` — feeds ${t.usedIn.join(", ")}` : "";

    return {
        sourceTable: JIT_SOURCE_TABLE,
        sourceId: `jit:${t.sku}`,
        type: "jit_order_trigger",
        goal: `Order ${t.sku} by ${t.triggerDate} from ${vendor}${feeds}`,
        status: "PENDING",
        owner: "will",
        priority,
        requiresApproval: false,
        // Only the obligation identity is hashed — keep volatile telemetry
        // (onHand, coverageDays) out so daily reruns dedup cleanly.
        inputs: { sku: t.sku, vendor, triggerDate: t.triggerDate },
    };
}

export type JitRouteResult = {
    created: number;
    deduped: number;
    failed: number;
};

/**
 * Route every trigger to the hub, best-effort. A hub failure (Supabase down,
 * HUB_TASKS_ENABLED off, migration not yet applied) is swallowed per-item and
 * counted — it must never prevent the Telegram alert from going out, so the
 * caller still notifies regardless of what this returns.
 */
export async function routeJitTriggersToHub(
    triggers: JitTrigger[],
    todayISO: string,
): Promise<JitRouteResult> {
    const result: JitRouteResult = { created: 0, deduped: 0, failed: 0 };
    for (const t of triggers) {
        try {
            const task = await incrementOrCreate(buildJitTaskArgs(t, todayISO));
            // dedup_count > 1 means we matched an existing open row.
            if ((task.dedup_count ?? 1) > 1) result.deduped++;
            else result.created++;
        } catch (err: any) {
            result.failed++;
            console.warn(`[jit-tasks] hub write failed for ${t.sku}: ${err?.message ?? err}`);
        }
    }
    return result;
}
