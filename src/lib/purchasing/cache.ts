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
import { mkdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { FinaleClient, type PurchasingGroup } from '@/lib/finale/client';

export type CacheSlot = {
    value: PurchasingGroup[] | null;
    at: number;
    promise: Promise<PurchasingGroup[]> | null;
};
export type CacheKey = 'resale' | 'bom';
type PersistedSnapshot = {
    at: number;
    value: PurchasingGroup[];
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
    lastPrewarmMs: number; // cold-start cooldown — avoid flooding Finale on rapid restarts
};
const stash: CacheStash = ((globalThis as any).__aria_purchasing_cache ??= {
    resale: { value: null, at: 0, promise: null },
    bom: { value: null, at: 0, promise: null },
    prewarmTimer: null,
    prewarmRunning: false,
    lastPrewarmMs: 0,
}) as CacheStash;

export const resaleSlot = stash.resale;
export const bomSlot = stash.bom;
export const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cacheDir(): string {
    return process.env.ARIA_PURCHASING_CACHE_DIR || join(process.cwd(), '.aria-cache', 'purchasing');
}

function cacheFile(key: CacheKey): string {
    return join(cacheDir(), `purchasing-${key}.json`);
}

function inferCacheKey(slot: CacheSlot): CacheKey | null {
    if (slot === resaleSlot) return 'resale';
    if (slot === bomSlot) return 'bom';
    return null;
}

export function readPersistedSnapshot(key: CacheKey): PersistedSnapshot | null {
    try {
        const parsed = JSON.parse(readFileSync(cacheFile(key), 'utf8')) as Partial<PersistedSnapshot>;
        if (!Number.isFinite(parsed.at) || !Array.isArray(parsed.value)) return null;
        return { at: parsed.at, value: parsed.value as PurchasingGroup[] };
    } catch {
        return null;
    }
}

function hydrateFromDisk(slot: CacheSlot, key: CacheKey): void {
    if (slot.value) return;
    const snapshot = readPersistedSnapshot(key);
    if (!snapshot) return;
    slot.value = snapshot.value;
    slot.at = snapshot.at;
}

async function persistSnapshot(key: CacheKey, value: PurchasingGroup[], at: number): Promise<void> {
    try {
        mkdirSync(cacheDir(), { recursive: true });
        await writeFile(cacheFile(key), JSON.stringify({ at, value }), 'utf8');
    } catch (err: any) {
        console.warn('[purchasing/cache] failed to persist snapshot:', err?.message || err);
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fetcher timeout')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }).catch(err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Background fetch timeout (ms). Increased from 25s to 180s (3min) for resilience
 * on large scans (7881+ products, BOM + resale pipelines). Prevents premature
 * timeout during peak load while still bounding runaway fetches.
 * @env FETCH_TIMEOUT_MS can be overridden via env if needed (future).
 */
const FETCH_TIMEOUT_MS = 1_500_000; // 25 min — cold scan of 728 candidates needs ~12-15 min

export async function readSWR(
    slot: CacheSlot,
    fetcher: () => Promise<PurchasingGroup[]>,
    force: boolean,
    cacheKey: CacheKey | null = inferCacheKey(slot),
): Promise<{ value: PurchasingGroup[]; refreshing: boolean }> {
    if (cacheKey) hydrateFromDisk(slot, cacheKey);

    const stale = force || !slot.value || Date.now() - slot.at > CACHE_TTL;

    if (stale && !slot.promise) {
        slot.promise = (async () => {
            try {
                const v = await withTimeout(fetcher(), FETCH_TIMEOUT_MS);
                slot.value = v;
                slot.at = Date.now();
                if (cacheKey) void persistSnapshot(cacheKey, v, slot.at);
                return v;
            } catch (err: any) {
                // Resilience: log timeout or fetch errors but do not propagate rejection.
                // Prevents unhandledRejection spam that was causing dashboard instability / ISE.
                // Keeps previous stale value; next prewarm or bust will retry.
                console.error(`[purchasing/cache] background ${cacheKey || 'unknown'} fetch failed:`, err?.message || err);
                // Optionally could set an error flag on slot, but for now graceful degrade.
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

/**
 * Mark caches stale without dropping their current values. SWR detects the
 * stale slot (`at = 0` is older than TTL), kicks a background refresh, and
 * keeps serving the cached groups until the fresh scan lands — so dashboard
 * users keep seeing data with a "Refreshing…" badge instead of an empty list.
 *
 * DECISION(2026-05-19): Previously this also nulled slot.value, which made
 * readSWR fall through to the cold-path branch (returns `{ value: [],
 * refreshing: true }`). Right after a PO commit/send invalidation, the
 * dashboard rendered an empty Ordering list — looked like a full reload.
 * Keeping the stale value preserves continuity; the filter-out of newly-
 * committed SKUs happens on the next successful refresh.
 */
export function invalidatePurchasingCaches(): void {
    resaleSlot.at = 0;
    bomSlot.at = 0;
}

/**
 * Prewarm both caches. Idempotent — concurrent calls dedupe via readSWR's
 * in-flight promise. Safe to schedule on an interval.
 */
export async function prewarmPurchasingCaches(): Promise<void> {
    if (stash.prewarmRunning) return;
    // Cold-start cooldown: skip if last prewarm was < 5 minutes ago.
    // Prevents rapid PM2 restarts from flooding Finale with full scans.
    const COOLDOWN_MS = 5 * 60 * 1000;
    if (Date.now() - stash.lastPrewarmMs < COOLDOWN_MS) return;
    stash.prewarmRunning = true;
    stash.lastPrewarmMs = Date.now();
    const client = new FinaleClient();
    try {
        // HERMIA(2026-07-14): Warm lead-time distribution cache BEFORE the
        // purchasing scan so P90 data is available on the first pass. Without
        // this, the scan falls back to Finale's native lead time (7-14d) and
        // urgency/ordering decisions are wrong until the second 25-min cycle.
        const { leadTimeService } = await import('@/lib/builds/lead-time-service');
        await leadTimeService.warmCache().catch((err: any) =>
            console.warn('[purchasing/prewarm] lead-time dist warmup failed (non-fatal):', err?.message || err),
        );

        const { prewarmForwardDemand } = await import('./forward-demand');
        // HERMIA(2026-06-19): Run resale first, then BOM — NOT concurrently.
        // Both share the same FinaleCoreClient rate limiter (500ms between ALL
        // requests). When run in parallel, each scan gets ~1 req/sec effective
        // throughput, pushing a 12-min scan past 24 minutes and exceeding the
        // fetch timeout. Sequential execution preserves 2 req/sec per scan.
        const resaleResult = await readSWR(resaleSlot, () => client.getPurchasingIntelligence(365), false);
        await prewarmForwardDemand(30).catch(() => undefined);
        const bomResult = await readSWR(bomSlot, () => client.getBOMDemand(90), false);
        await Promise.allSettled([resaleResult, bomResult]);
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
