/**
 * @file    src/lib/purchasing/cache.ts
 * @purpose Durable snapshot + single-writer scan scheduler for the Ordering screen.
 *
 *          THE CONTRACT (HERMIA 2026-10-13 — "no need to hammer Finale, MUST be
 *          a more elegant process"):
 *
 *            - The WEB LAYER ONLY READS. A dashboard poll never starts a scan.
 *            - The SCHEDULER is the only writer. It runs resale and BOM
 *              SEQUENTIALLY inside one cycle, so the two pipelines never split
 *              the client's 2 req/s limiter between them.
 *            - Exactly ONE cycle runs at a time — enforced in-process (a single
 *              cycle promise) AND across processes (a heartbeat lock file), so
 *              aria-bot, a CLI, or a second dashboard cannot double up.
 *            - A cycle is never abandoned mid-flight. The old code raced the
 *              fetcher against a 25-min timeout that REJECTED WITHOUT ABORTING,
 *              so the "timed out" scan kept issuing requests while the next one
 *              started. That is what compounded into Finale's 429 limiter.
 *            - Cadence is derived from the MEASURED cycle duration, not a fixed
 *              interval, so a slow cycle delays the next one instead of
 *              overlapping it.
 *
 *          A request that finds the snapshot stale reports `refreshing: true`
 *          and asks the scheduler for a cycle (expedited, but never sooner than
 *          EXPEDITE_GAP_MS after the last cycle started). The panel keeps
 *          painting the last good snapshot throughout.
 *
 * @author  Hermia
 * @created 2026-07-14
 * @deps    @/lib/finale/client
 * @env     ARIA_PURCHASING_CACHE_DIR, ARIA_PURCHASING_REFRESH_MIN_MS,
 *          ARIA_PURCHASING_EXPEDITE_GAP_MS — all optional.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { FinaleClient, type PurchasingGroup } from '@/lib/finale/client';
import { createClient } from '@/lib/db';
import { poolCartonGroups, type CartonName } from './carton-pooling';

export type CacheSlot = {
    value: PurchasingGroup[] | null;
    at: number;
    promise: Promise<PurchasingGroup[]> | null;
    /** Window this slot's snapshot was produced with, so a non-default
     *  ?daysBack request is detected instead of being silently answered with
     *  the scheduled window's data. */
    windowKey?: string;
};
export type CacheKey = 'resale' | 'bom';
type PersistedSnapshot = {
    at: number;
    value: PurchasingGroup[];
    windowKey?: string;
};

type ScanCycleState = {
    promise: Promise<void> | null;
    lastStartedAt: number;
    lastFinishedAt: number;
    lastDurationMs: number;
    runs: number;
    lastReason: string;
};

type CacheStash = {
    resale: CacheSlot;
    bom: CacheSlot;
    cycle: ScanCycleState;
    nextTimer: NodeJS.Timeout | null;
    schedulerStarted: boolean;
    refreshWanted: boolean;
    prewarmRunning: boolean;
    lastPrewarmMs: number; // cold-start cooldown — avoid flooding Finale on rapid restarts
};

// Pinned to globalThis because Next.js compiles instrumentation.ts and route.ts
// into separate chunks, each of which would otherwise get its own module-level
// state — leading to duplicate scans. globalThis is the only state shared
// across compiled chunks in the same Node process.
const globalStash = globalThis as typeof globalThis & { __aria_purchasing_cache?: CacheStash };
const stash: CacheStash = (globalStash.__aria_purchasing_cache ??= {
    resale: { value: null, at: 0, promise: null },
    bom: { value: null, at: 0, promise: null },
    cycle: { promise: null, lastStartedAt: 0, lastFinishedAt: 0, lastDurationMs: 0, runs: 0, lastReason: '' },
    nextTimer: null,
    schedulerStarted: false,
    refreshWanted: false,
    prewarmRunning: false,
    lastPrewarmMs: 0,
}) as CacheStash;

// Defensive defaults: a globalThis stash created by an OLDER build of this
// module carries none of the newer fields, and `??=` only assigns when the whole
// object is missing. Backfill so a hot reload cannot wedge the scheduler.
stash.cycle ??= { promise: null, lastStartedAt: 0, lastFinishedAt: 0, lastDurationMs: 0, runs: 0, lastReason: '' };
if (stash.nextTimer === undefined) stash.nextTimer = null;
if (stash.schedulerStarted === undefined) stash.schedulerStarted = false;
if (stash.refreshWanted === undefined) stash.refreshWanted = false;

export const resaleSlot = stash.resale;
export const bomSlot = stash.bom;
/**
 * Extra grace beyond the cadence before a snapshot counts as stale.
 *
 * HERMIA(2026-10-13): the freshness check is aligned with the scan CADENCE, not
 * a fixed 30 min. With a 60-min cycle, a flat 30-min TTL marked every read
 * stale, so the panel showed "Refreshing..." for most of every hour even though
 * the scheduler was exactly on time. Stale now means THE SCHEDULER IS BEHIND.
 */
export const SNAPSHOT_GRACE_MS = 15 * 60 * 1000;

/** Age at which a snapshot is reported stale: one cadence plus a grace window. */
export function snapshotTtlMs(): number {
    return minCycleGapMs() + SNAPSHOT_GRACE_MS;
}

/** Windows used by the scheduled cycle. Both pipelines share one cadence. */
export const SCAN_RESALE_DAYS = 365;
export const SCAN_BOM_DAYS = 90;

/**
 * Floor between cycle STARTS. A full cycle is ~35 min of wall clock, so the old
 * 25-min interval guaranteed overlap. 60 min keeps Ordering at most one cycle
 * behind without re-deriving a plan that has not changed.
 * @env ARIA_PURCHASING_REFRESH_MIN_MS
 */
function minCycleGapMs(): number {
    const raw = Number(process.env.ARIA_PURCHASING_REFRESH_MIN_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
}

/**
 * Earliest a change-driven (expedited) cycle may start after the previous cycle
 * STARTED. Bounds how far a burst of PO commits can pull the schedule forward.
 * @env ARIA_PURCHASING_EXPEDITE_GAP_MS
 */
function expediteGapMs(): number {
    const raw = Number(process.env.ARIA_PURCHASING_EXPEDITE_GAP_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Slack added to a measured cycle duration before scheduling the next start. */
const CYCLE_SLACK_MS = 2 * 60 * 1000;

/** A lock with no heartbeat for this long is treated as abandoned. */
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;

/** Message from an unknown thrown value, for structured logging. */
function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function cacheDir(): string {
    return process.env.ARIA_PURCHASING_CACHE_DIR || join(process.cwd(), '.aria-cache', 'purchasing');
}

function cacheFile(key: CacheKey): string {
    return join(cacheDir(), `purchasing-${key}.json`);
}

function lockFile(): string {
    return join(cacheDir(), 'scan.lock');
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
        return {
            at: parsed.at,
            value: parsed.value as PurchasingGroup[],
            windowKey: typeof parsed.windowKey === 'string' ? parsed.windowKey : undefined,
        };
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
    if (snapshot.windowKey) slot.windowKey = snapshot.windowKey;
}

async function persistSnapshot(key: CacheKey, value: PurchasingGroup[], at: number, windowKey?: string): Promise<void> {
    try {
        mkdirSync(cacheDir(), { recursive: true });
        await writeFile(cacheFile(key), JSON.stringify({ at, value, windowKey }), 'utf8');
    } catch (err: unknown) {
        console.warn('[purchasing/cache] failed to persist snapshot:', errText(err));
    }
}

// ──────────────────────────────────────────────────────────────────────────
// CROSS-PROCESS SCAN LOCK
// ──────────────────────────────────────────────────────────────────────────

/**
 * Take the scan lock when it is free or abandoned. The lock carries a HEARTBEAT
 * timestamp rather than relying on PID liveness, which is unreliable on Windows
 * (PID reuse) and meaningless across containers.
 *
 * @param reason Tag recorded in the lock file for diagnostics.
 * @returns      true when this process may run a cycle.
 */
function acquireCycleLock(reason: string): boolean {
    try {
        mkdirSync(cacheDir(), { recursive: true });
        const existing = JSON.parse(readFileSync(lockFile(), 'utf8')) as { pid?: number; at?: number; reason?: string };
        if (Number.isFinite(existing.at) && Date.now() - (existing.at as number) < LOCK_STALE_MS) {
            console.log(
                `[purchasing/cycle] another scan holds the lock (pid ${existing.pid ?? '?'}, ${existing.reason ?? '?'}, ` +
                `${Math.round((Date.now() - (existing.at as number)) / 1000)}s old) — skipping this cycle`,
            );
            return false;
        }
        console.warn('[purchasing/cycle] taking over an abandoned scan lock');
    } catch {
        // No lock yet (or unreadable) — fall through and claim it.
    }
    try {
        writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now(), reason }), 'utf8');
        return true;
    } catch (err: unknown) {
        console.warn('[purchasing/cycle] could not write scan lock; running anyway:', errText(err));
        return true;
    }
}

function touchCycleLock(reason: string): void {
    try {
        writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now(), reason }), 'utf8');
    } catch {
        // Best effort — a missed heartbeat only risks the stale-takeover path.
    }
}

function releaseCycleLock(): void {
    try {
        unlinkSync(lockFile());
    } catch {
        // Already gone (or never created) — nothing to do.
    }
}

// ──────────────────────────────────────────────────────────────────────────
// THE CYCLE — the ONLY code path that performs a full scan
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pipelines a cycle runs, injectable so tests can exercise the scheduler without
 * touching Finale.
 */
export type CycleDeps = {
    /** Slow caches that must be warm before the scan (day-0 correctness). */
    before?: () => Promise<void>;
    /** Resale pipeline. */
    resale: () => Promise<PurchasingGroup[]>;
    /** Runs between the two pipelines (forward demand). */
    between?: () => Promise<void>;
    /** BOM pipeline. */
    bom: () => Promise<PurchasingGroup[]>;
};

/** Production pipelines: the real Finale-backed scans. */
function defaultCycleDeps(): CycleDeps {
    const client = new FinaleClient();
    return {
        before: async () => {
            // HERMIA(2026-07-14): Warm the lead-time distribution cache BEFORE the
            // purchasing scan so P90 data is available on the first pass. Without
            // this the scan falls back to Finale's native lead time (7-14d) and
            // urgency/ordering decisions are wrong until the second cycle.
            const { leadTimeService } = await import('@/lib/builds/lead-time-service');
            await leadTimeService.warmCache().catch((err: unknown) =>
                console.warn('[purchasing/cycle] lead-time dist warmup failed (non-fatal):', errText(err)),
            );

            // KAIZEN(2026-08-04): Populate receiving_cache before the scan so
            // coverageStockOnOrder can distinguish fully-received single-shipment
            // POs from partially-received blanket POs.
            const { refreshReceivingCache } = await import('./receiving-cache');
            await refreshReceivingCache().catch((err: unknown) =>
                console.warn('[purchasing/cycle] receiving-cache refresh failed (non-fatal):', errText(err)),
            );
        },
        resale: () => client.getPurchasingIntelligence(SCAN_RESALE_DAYS),
        between: async () => {
            const { prewarmForwardDemand } = await import('./forward-demand');
            await prewarmForwardDemand(30).catch(() => undefined);
        },
        bom: () => client.getBOMDemand(SCAN_BOM_DAYS),
    };
}

/**
 * Run one full scan cycle: slow caches first, then resale, then BOM.
 *
 * Sequential on purpose. Both pipelines share one process-wide limiter
 * (2 req/s), so running them concurrently gives each ~1 req/s and stretched a
 * 15-min scan past the old 25-min timeout — which is what produced the
 * abandoned-but-still-running scans. One at a time keeps the full budget for
 * whichever pipeline is running.
 *
 * Single-flight: concurrent callers join the in-flight cycle instead of starting
 * a second one (the first caller's deps win).
 *
 * @param reason Short tag recorded in the lock file and the logs.
 * @param deps   Pipelines to run; defaults to the real Finale-backed scans.
 * @returns      Resolves when the cycle finishes (never rejects).
 */
export function runScanCycle(reason = 'manual', deps: CycleDeps = defaultCycleDeps()): Promise<void> {
    if (stash.cycle.promise) return stash.cycle.promise;

    stash.cycle.promise = (async () => {
        if (!acquireCycleLock(reason)) return;

        const startedAt = Date.now();
        stash.cycle.lastStartedAt = startedAt;
        stash.cycle.lastReason = reason;
        const heartbeat = setInterval(() => touchCycleLock(reason), LOCK_HEARTBEAT_MS);
        heartbeat.unref?.();

        try {
            await deps.before?.();
            await runSlotScan(resaleSlot, 'resale', deps.resale, String(SCAN_RESALE_DAYS));
            touchCycleLock(reason);
            await deps.between?.();
            await runSlotScan(bomSlot, 'bom', deps.bom, String(SCAN_BOM_DAYS));
        } catch (err: unknown) {
            // Never propagate: the snapshot keeps serving and the next cycle retries.
            console.error(`[purchasing/cycle] ${reason} cycle failed:`, errText(err));
        } finally {
            clearInterval(heartbeat);
            releaseCycleLock();
            stash.cycle.lastDurationMs = Date.now() - startedAt;
            stash.cycle.lastFinishedAt = Date.now();
            stash.cycle.runs += 1;
            stash.refreshWanted = false;
            console.log(
                `[purchasing/cycle] ${reason} cycle finished in ${Math.round(stash.cycle.lastDurationMs / 1000)}s ` +
                `(run #${stash.cycle.runs})`,
            );
        }
    })().finally(() => {
        stash.cycle.promise = null;
    });

    return stash.cycle.promise;
}

/**
 * Carton index (SKU -> product name) used to pool stock by physical size.
 *
 * A dashboard poll must never pay for this: it is read once per hour by the
 * scan cycle, which is the only writer. A failed read keeps the previous index
 * rather than disabling pooling for the cycle.
 */
let cartonIndex: { at: number; rows: CartonName[] } | null = null;
const CARTON_INDEX_TTL_MS = 60 * 60 * 1000;

/** Live on-hand lookups for carton siblings, memoized across both pipelines. */
const cartonStockMemo = new Map<string, { value: number; at: number }>();
const CARTON_STOCK_TTL_MS = 10 * 60 * 1000;

async function getCartonIndex(): Promise<CartonName[]> {
    if (cartonIndex && Date.now() - cartonIndex.at < CARTON_INDEX_TTL_MS) {
        return cartonIndex.rows;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const db = createClient();
            if (!db) break;
            // JSON-path filter keeps this to ~100 carton SKUs instead of the whole
            // 2.6k-row cache (PostgREST caps a bare select at 1,000 rows).
            const { data, error } = await db
                .from('finale_sku_cache')
                .select('sku,name:raw_detail->>name')
                .filter('raw_detail->>name', 'ilike', '%box%');
            if (error) throw new Error(error.message);
            const rows = ((data ?? []) as CartonName[]).filter((r) => r?.sku);
            if (rows.length === 0) throw new Error('empty carton index');
            cartonIndex = { at: Date.now(), rows };
            writeCartonIndexToDisk(rows);
            return rows;
        } catch (err: unknown) {
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
            }
            console.warn('[purchasing/cycle] carton index unavailable:', errText(err));
        }
    }
    // PostgREST times out under scan load. A previously written index still
    // pools correctly — never disable pooling just because backing off failed.
    const disk = readCartonIndexFromDisk();
    if (disk) {
        cartonIndex = { at: Date.now(), rows: disk };
        return disk;
    }
    return cartonIndex?.rows ?? [];
}

/** Persist the carton index so a PostgREST outage cannot disable pooling. */
function writeCartonIndexToDisk(rows: CartonName[]): void {
    try {
        mkdirSync(cacheDir(), { recursive: true });
        writeFileSync(join(cacheDir(), 'carton-index.json'), JSON.stringify({ at: Date.now(), rows }), 'utf8');
    } catch {
        // Best effort — the in-memory index still serves this cycle.
    }
}

/** Read a previously persisted carton index. */
function readCartonIndexFromDisk(): CartonName[] | null {
    try {
        const parsed = JSON.parse(readFileSync(join(cacheDir(), 'carton-index.json'), 'utf8')) as {
            rows?: CartonName[];
        };
        return Array.isArray(parsed?.rows) && parsed.rows.length > 0 ? parsed.rows : null;
    } catch {
        return null;
    }
}

/**
 * Recompute carton runway against pooled on-hand for the physical size, so the
 * board does not order a carton that another vendor SKU already covers.
 *
 * Applied in the single writer, so the dashboard slot and the persisted
 * snapshot the Friday report reads carry identical numbers.
 *
 * @param key    Slot being scanned (logging).
 * @param groups Freshly scanned groups.
 * @returns      Groups with pooled carton runway, or the originals on failure.
 */
async function applyCartonPooling(
    key: CacheKey,
    groups: PurchasingGroup[],
): Promise<PurchasingGroup[]> {
    try {
        const cartonNames = await getCartonIndex();
        if (cartonNames.length === 0) return groups;

        const client = new FinaleClient();
        const now = Date.now();
        const outcome = await poolCartonGroups(groups, {
            cartonNames,
            stockFor: async (sku: string) => {
                const hit = cartonStockMemo.get(sku);
                if (hit && now - hit.at < CARTON_STOCK_TTL_MS) return hit.value;
                const value = await client.getStockLevel(sku);
                const n = Number(value);
                if (Number.isFinite(n)) cartonStockMemo.set(sku, { value: n, at: now });
                return Number.isFinite(n) ? n : null;
            },
        });

        for (const row of outcome.pooled) {
            if (!row.covered) continue;
            console.log(
                `[purchasing/cycle] ${key} carton ${row.dimKey}: ${row.onHand} on hand across ` +
                `${row.skus.length} SKUs (${row.runwayDays.toFixed(0)}d runway) — no reorder`,
            );
        }
        return outcome.groups;
    } catch (err: unknown) {
        // Pooling is an accuracy improvement, never a reason to lose a scan.
        console.warn(`[purchasing/cycle] ${key} carton pooling failed (using scan values):`, errText(err));
        return groups;
    }
}

/**
 * Refresh one slot inside a cycle, updating memory and the durable snapshot.
 *
 * A failure keeps the previous value (continuity) and is logged, never thrown —
 * one empty pipeline must not blank the other.
 *
 * @param slot      Slot to update.
 * @param key       Persisted snapshot key.
 * @param fetcher   Pipeline that produces the groups.
 * @param windowKey Window the scan used, recorded so a deep-dive request is
 *                  detected as a mismatch rather than served stale data.
 */
async function runSlotScan(
    slot: CacheSlot,
    key: CacheKey,
    fetcher: () => Promise<PurchasingGroup[]>,
    windowKey?: string,
): Promise<void> {
    try {
        const scanned = await fetcher();
        // HERMIA(2026-10-15): never publish an EMPTY BOM over a good one. A pass that
        // could not read the BOMs comes back empty (Finale rate-limits the per-SKU BOM
        // fetch, and getBillOfMaterials() swallows the error into []), and the empty
        // result then overwrites the snapshot, so every BOM component silently vanishes
        // from the ordering board. An empty result is indistinguishable from a failed
        // read here, so keep what is on file and say so. Observed live: 0 of 304 board
        // rows were bom-component while this was happening.
        if (key === 'bom' && scanned.length === 0 && (slot.value?.length ?? 0) > 0) {
            console.warn(
                `[purchasing/cycle] bom scan returned nothing while ${(slot.value as PurchasingGroup[]).length} group(s) are on file — keeping the previous BOM snapshot`,
            );
            return;
        }
        // Same carton size ships under several vendor SKUs; pool before publishing
        // so the board and the Friday report judge the size, not the SKU.
        let value = await applyCartonPooling(key, scanned);
        // Phase 2 (2026-10-28): stamp bag/label artwork state on resale items.
        // Art in review must hold the reorder (Bill's rule), so the gate rides
        // on the same snapshot the board and reports read.
        if (key === 'resale') {
            try {
                const { applyArtworkStatus } = await import('../artwork/enrich');
                value = await applyArtworkStatus(value);
            } catch (err: unknown) {
                console.warn(`[purchasing/cycle] ${key} artwork enrichment failed (using unenriched scan):`, errText(err));
            }
        }
        slot.value = value;
        slot.at = Date.now();
        if (windowKey) slot.windowKey = windowKey;
        void persistSnapshot(key, value, slot.at, windowKey);
    } catch (err: unknown) {
        console.error(`[purchasing/cycle] ${key} scan failed (keeping previous snapshot):`, errText(err));
    }
}

// ──────────────────────────────────────────────────────────────────────────
// READ PATH — never scans
// ──────────────────────────────────────────────────────────────────────────

/**
 * Ask the scheduler for a cycle, no sooner than the expedite floor after the
 * last cycle started. Called by stale reads and by cache invalidation.
 *
 * @param reason Tag for the cycle log line.
 */
function requestRefresh(reason: string): void {
    stash.refreshWanted = true;
    if (stash.cycle.promise) return; // the running cycle picks the flag up when it finishes
    const sinceStart = Date.now() - stash.cycle.lastStartedAt;
    if (stash.cycle.lastStartedAt > 0 && sinceStart < expediteGapMs()) return;
    if (stash.nextTimer) {
        clearTimeout(stash.nextTimer);
        stash.nextTimer = null;
    }
    void runScanCycle(`refresh:${reason}`);
}

/**
 * Read a slot for a dashboard request.
 *
 * HERMIA(2026-10-13): this used to scan whenever the snapshot was stale, so a
 * browser poll could start a 35-minute full-catalog scan AND compete with the
 * scheduler's own scan for the rate limit. It now ONLY reads: staleness is
 * reported through `refreshing` and handed to the scheduler.
 *
 * `fetcher` is used in exactly two cases — a genuinely cold cache (nothing in
 * memory and nothing on disk, so the caller has nothing to show) and an explicit
 * non-default window the scheduler does not produce.
 *
 * @param slot          Slot to read.
 * @param fetcher       Pipeline for the cold and deep-dive paths.
 * @param force         `?bust=1` — expedite a cycle; still returns cached data.
 * @param cacheKey      Persisted snapshot backing this slot.
 * @param opts.windowKey Window the caller asked for, e.g. "730".
 * @returns             Snapshot plus whether a refresh is in progress.
 */
export async function readSWR(
    slot: CacheSlot,
    fetcher: () => Promise<PurchasingGroup[]>,
    force: boolean,
    cacheKey: CacheKey | null = inferCacheKey(slot),
    opts?: { windowKey?: string },
): Promise<{ value: PurchasingGroup[]; refreshing: boolean }> {
    if (cacheKey) hydrateFromDisk(slot, cacheKey);

    const stale = force || !slot.value || Date.now() - slot.at > snapshotTtlMs();

    // A window the scheduler does not produce (e.g. ?daysBack=730) still gets a
    // real scan, serialized behind the cycle lock so it cannot overlap one.
    if (opts?.windowKey && slot.windowKey && opts.windowKey !== slot.windowKey && cacheKey) {
        return runDeepDive(slot, fetcher, cacheKey, opts.windowKey);
    }

    if (!stale) return { value: slot.value ?? [], refreshing: false };

    if (slot.value) {
        requestRefresh(cacheKey ?? 'slot');
        return { value: slot.value, refreshing: true };
    }

    // Cold: nothing in memory and nothing on disk. Start a cycle and paint
    // empty; the panel polls until `refreshing` flips, as before.
    void runScanCycle('cold-start');
    return { value: [], refreshing: true };
}

/**
 * Serve a non-default window (deep-dive history search) with a one-off scan.
 *
 * Serialized against the scheduled cycle by the same lock, and deliberately NOT
 * persisted into the shared slot so it cannot poison the panel's snapshot.
 *
 * @param slot      Slot holding the last good value.
 * @param fetcher   Pipeline for the requested window.
 * @param cacheKey  Snapshot key, for logging only.
 * @param windowKey Requested window.
 */
async function runDeepDive(
    slot: CacheSlot,
    fetcher: () => Promise<PurchasingGroup[]>,
    cacheKey: CacheKey,
    windowKey: string,
): Promise<{ value: PurchasingGroup[]; refreshing: boolean }> {
    if (!acquireCycleLock(`deep-dive:${cacheKey}:${windowKey}`)) {
        // A cycle already owns Finale — do not add a competing scan.
        return { value: slot.value ?? [], refreshing: true };
    }
    const heartbeat = setInterval(() => touchCycleLock(`deep-dive:${cacheKey}`), LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
        const value = await fetcher();
        return { value, refreshing: false };
    } catch (err: unknown) {
        console.error(`[purchasing/cache] deep-dive ${cacheKey} scan failed:`, errText(err));
        return { value: slot.value ?? [], refreshing: true };
    } finally {
        clearInterval(heartbeat);
        releaseCycleLock();
    }
}

/**
 * Mark caches stale WITHOUT dropping their current values, so dashboard users
 * keep seeing data instead of an empty list, and ask the scheduler for a cycle.
 *
 * DECISION(2026-05-19): nulling slot.value here made readSWR fall through to the
 * cold path (empty list) right after a PO commit, which looked like a full
 * reload. Keeping the stale value preserves continuity.
 *
 * DECISION(2026-10-13): this is now a REQUEST, not a scan. A commit burst used
 * to start one scan per burst; now it can pull the next cycle forward at most
 * once per expedite floor.
 */
export function invalidatePurchasingCaches(): void {
    resaleSlot.at = 0;
    bomSlot.at = 0;
    requestRefresh('invalidate');
}

/**
 * Run a cycle now (bounded by the lock). Public entry point used by
 * instrumentation and any caller that wants a guaranteed attempt.
 */
export async function prewarmPurchasingCaches(): Promise<void> {
    if (stash.prewarmRunning) return;
    // Cold-start cooldown: skip if the last attempt was < 5 minutes ago, so
    // rapid PM2 restarts don't queue several full scans.
    const COOLDOWN_MS = 5 * 60 * 1000;
    if (Date.now() - stash.lastPrewarmMs < COOLDOWN_MS) return;
    stash.prewarmRunning = true;
    stash.lastPrewarmMs = Date.now();
    try {
        await runScanCycle('prewarm');
    } finally {
        stash.prewarmRunning = false;
    }
}

/**
 * Delay before the next scheduled cycle starts.
 *
 * Pure over its inputs (plus the two env knobs) so the cadence contract is unit
 * testable — this math is what decides how stale the Ordering snapshot can get,
 * and it is easy to get subtly wrong.
 *
 * @param opts.lastStartedAt  When the previous cycle STARTED (0 if none yet).
 * @param opts.refreshWanted  A stale read or an invalidation asked for a refresh.
 * @param opts.now            Clock override for tests.
 * @returns                   Milliseconds to wait before the next cycle.
 */
export function computeNextCycleDelayMs(opts: {
    lastStartedAt: number;
    refreshWanted: boolean;
    now?: number;
}): number {
    const now = opts.now ?? Date.now();
    const sinceStart = now - opts.lastStartedAt;
    const expedite = opts.refreshWanted && opts.lastStartedAt > 0 && sinceStart >= expediteGapMs();
    if (expedite) return 0;
    // Floor measured between STARTS, so a ~35-min cycle on a 60-min floor still
    // lands every 60 min. A small minimum idle stops a cycle that overran the
    // floor from restarting back-to-back.
    return Math.max(minCycleGapMs() - sinceStart, CYCLE_SLACK_MS);
}

/**
 * Start the scan scheduler. Called once from instrumentation.ts.
 *
 * Chains the next cycle off the previous one's COMPLETION and MEASURED duration
 * rather than a fixed interval. The old `setInterval(25min)` fired regardless of
 * whether the previous ~35-minute cycle had finished, which is how scans ended
 * up overlapping and competing for Finale's rate limit.
 *
 * The gap is measured BETWEEN CYCLE STARTS (see computeNextCycleDelayMs): with a
 * ~35-min cycle and a 60-min floor, the next scan begins 60 min after the last
 * one began, so the snapshot is at most about one cycle old.
 */
export function startPurchasingPrewarm(): void {
    if (stash.schedulerStarted) return;
    stash.schedulerStarted = true;

    const scheduleNext = (): void => {
        const delay = computeNextCycleDelayMs({
            lastStartedAt: stash.cycle.lastStartedAt,
            refreshWanted: stash.refreshWanted,
        });
        if (stash.nextTimer) clearTimeout(stash.nextTimer);
        stash.nextTimer = setTimeout(() => {
            stash.nextTimer = null;
            void runScanCycle('scheduler').then(scheduleNext);
        }, delay);
        stash.nextTimer.unref?.();
        console.log(`[purchasing/cycle] next scan in ${Math.round(delay / 1000)}s`);
    };

    void runScanCycle('startup').then(scheduleNext);
}
