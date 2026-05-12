/**
 * @file    forward-demand.ts
 * @purpose Calendar-driven component demand for the next N days.
 *
 * Wraps build-risk's runBuildRiskAnalysis (which fetches Google Calendar
 * builds, LLM-parses them, and explodes BOMs) into a cached lookup the
 * Ordering screen can consume. SWR-style: serves stale data immediately,
 * refreshes in background. 4-hour TTL since this hits the LLM.
 */
import { runBuildRiskAnalysis, type ComponentDemand } from '@/lib/builds/build-risk';

export interface ForwardDemandEntry {
    componentSku: string;
    requiredQty: number;
    earliestBuildDate: string;
    feedsBuilds: string[]; // FG SKUs that drive this demand
}

type ForwardDemandMap = Map<string, ForwardDemandEntry>;

type Slot = {
    value: ForwardDemandMap | null;
    at: number;
    promise: Promise<ForwardDemandMap> | null;
};

// Pin to globalThis for the same reason as the purchasing cache —
// Next.js compiles route.ts and instrumentation.ts into separate chunks.
const slot: Slot = ((globalThis as any).__aria_forward_demand_slot ??= {
    value: null,
    at: 0,
    promise: null,
}) as Slot;

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function runScan(daysOut: number): Promise<ForwardDemandMap> {
    try {
        const report = await runBuildRiskAnalysis(daysOut);
        const out: ForwardDemandMap = new Map();
        for (const [sku, demand] of report.components.entries()) {
            out.set(sku, {
                componentSku: sku,
                requiredQty: demand.totalRequiredQty,
                earliestBuildDate: demand.earliestBuildDate,
                feedsBuilds: Array.from(demand.usedIn),
            });
        }
        return out;
    } catch (err: any) {
        console.warn('[forward-demand] scan failed:', err?.message || err);
        return new Map();
    }
}

/**
 * Returns the current forward-demand snapshot (possibly stale). Triggers a
 * background refresh when stale. Never blocks: cold cache returns empty map
 * immediately while the refresh runs.
 */
export function readForwardDemand(daysOut = 30): ForwardDemandMap {
    const stale = !slot.value || Date.now() - slot.at > TTL_MS;
    if (stale && !slot.promise) {
        slot.promise = (async () => {
            try {
                const v = await runScan(daysOut);
                slot.value = v;
                slot.at = Date.now();
                return v;
            } finally {
                slot.promise = null;
            }
        })();
    }
    return slot.value ?? new Map();
}

/**
 * Fire-and-forget warm-up. Safe to schedule alongside the purchasing prewarm.
 */
export async function prewarmForwardDemand(daysOut = 30): Promise<void> {
    if (slot.value && Date.now() - slot.at < TTL_MS) return;
    if (slot.promise) {
        await slot.promise.catch(() => undefined);
        return;
    }
    slot.promise = (async () => {
        try {
            const v = await runScan(daysOut);
            slot.value = v;
            slot.at = Date.now();
            return v;
        } finally {
            slot.promise = null;
        }
    })();
    await slot.promise.catch(() => undefined);
}
