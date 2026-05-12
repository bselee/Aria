/**
 * @file    cache.ts
 * @purpose Module-level cache + stale-while-revalidate for the Ordering screen.
 *
 * Both pipelines (resale + BOM) take minutes to scan. SWR serves cached data
 * immediately (even when stale) and refreshes in the background, so the user
 * sees instant data after the first ever scan completes. The exported
 * `prewarmPurchasingCaches()` is called from `src/instrumentation.ts` at
 * dashboard boot and on a 25-min interval — the user never hits a cold scan.
 */
import { FinaleClient, type PurchasingGroup } from '@/lib/finale/client';

export type CacheSlot = {
    value: PurchasingGroup[] | null;
    at: number;
    promise: Promise<PurchasingGroup[]> | null;
};

// Pinned to globalThis because Next.js compiles instrumentation.ts and route.ts
// into separate chunks, each of which would otherwise get its own module-level
// state — leading to duplicate scans. globalThis is the only state shared
// across compiled chunks in the same Node process.
type CacheStash = {
    resale: CacheSlot;
    bom: CacheSlot;
    prewarmTimer: NodeJS.Timeout | null;
    prewarmRunning: boolean;
};
const stash: CacheStash = ((globalThis as any).__aria_purchasing_cache ??= {
    resale: { value: null, at: 0, promise: null },
    bom: { value: null, at: 0, promise: null },
    prewarmTimer: null,
    prewarmRunning: false,
}) as CacheStash;

export const resaleSlot = stash.resale;
export const bomSlot = stash.bom;
export const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function readSWR(
    slot: CacheSlot,
    fetcher: () => Promise<PurchasingGroup[]>,
    force: boolean,
): Promise<{ value: PurchasingGroup[]; refreshing: boolean }> {
    const stale = force || !slot.value || Date.now() - slot.at > CACHE_TTL;

    if (stale && !slot.promise) {
        slot.promise = (async () => {
            try {
                const v = await fetcher();
                slot.value = v;
                slot.at = Date.now();
                return v;
            } finally {
                slot.promise = null;
            }
        })();
    }

    // Have cached data — return immediately, refresh runs in background.
    if (slot.value && !force) {
        return { value: slot.value, refreshing: stale };
    }

    // Forced bust with prior cache — still return cached value, refresh runs.
    if (slot.value && force) {
        return { value: slot.value, refreshing: true };
    }

    // Cold cache — don't block the request. Return empty + refreshing flag so
    // the page paints instantly; the panel polls until refreshing flips false.
    return { value: [], refreshing: true };
}

export function invalidatePurchasingCaches(): void {
    resaleSlot.value = null;
    resaleSlot.at = 0;
    bomSlot.value = null;
    bomSlot.at = 0;
}

/**
 * Prewarm both caches. Idempotent — concurrent calls dedupe via readSWR's
 * in-flight promise. Safe to schedule on an interval.
 */
export async function prewarmPurchasingCaches(): Promise<void> {
    if (stash.prewarmRunning) return;
    stash.prewarmRunning = true;
    const client = new FinaleClient();
    try {
        await Promise.allSettled([
            readSWR(resaleSlot, () => client.getPurchasingIntelligence(365), false),
            readSWR(bomSlot, () => client.getBOMDemand(90), false),
        ]);
    } finally {
        stash.prewarmRunning = false;
    }
}

/**
 * Start the prewarm interval. Called once from instrumentation.ts. Kicks off
 * an immediate scan and then refreshes every 25 min (just under the 30-min
 * TTL so the cache is always warm).
 */
export function startPurchasingPrewarm(): void {
    if (stash.prewarmTimer) return; // already started
    stash.prewarmTimer = setInterval(() => {
        prewarmPurchasingCaches().catch(err =>
            console.error('[purchasing/prewarm] interval error:', err?.message || err),
        );
    }, 25 * 60 * 1000);
    // Fire the first scan immediately, non-blocking.
    prewarmPurchasingCaches().catch(err =>
        console.error('[purchasing/prewarm] initial error:', err?.message || err),
    );
}
