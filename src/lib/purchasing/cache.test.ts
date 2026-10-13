/**
 * @file    src/lib/purchasing/cache.test.ts
 * @purpose Tests for the purchasing snapshot cache and its scan scheduler.
 *
 *          Covers the 2026-10-13 contract: a request NEVER starts a scan, only
 *          the scheduler writes, exactly one cycle runs at a time, and a cycle
 *          runs resale and BOM sequentially so the two pipelines never split the
 *          client's 2 req/s limiter.
 *
 *          Every test that could reach the network pre-writes a fresh scan lock,
 *          so `acquireCycleLock` refuses and the real Finale pipelines are never
 *          constructed. Pipelines are injected via `runScanCycle(reason, deps)`.
 *
 * @author  Hermia
 * @created 2026-07-14
 * @deps    vitest
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PurchasingGroup } from "@/lib/finale/client";
import type { CacheSlot } from "./cache";

/** Typed handle on the globalThis stash, without reaching for `any`. */
const globalStash = globalThis as typeof globalThis & { __aria_purchasing_cache?: unknown };

describe("purchasing cache + scan scheduler", () => {
    let cacheDir: string;
    const originalCacheDir = process.env.ARIA_PURCHASING_CACHE_DIR;

    beforeEach(() => {
        vi.resetModules();
        cacheDir = mkdtempSync(join(tmpdir(), "aria-purchasing-cache-"));
        process.env.ARIA_PURCHASING_CACHE_DIR = cacheDir;
        // The stash lives on globalThis, so resetModules() alone does not clear it.
        delete globalStash.__aria_purchasing_cache;
    });

    afterEach(() => {
        if (originalCacheDir === undefined) {
            delete process.env.ARIA_PURCHASING_CACHE_DIR;
        } else {
            process.env.ARIA_PURCHASING_CACHE_DIR = originalCacheDir;
        }
        delete globalStash.__aria_purchasing_cache;
        rmSync(cacheDir, { recursive: true, force: true });
    });

    /** Hold the scan lock so no cycle can touch Finale. */
    function holdScanLock(): void {
        writeFileSync(join(cacheDir, "scan.lock"), JSON.stringify({ pid: process.pid, at: Date.now(), reason: "test" }));
    }

    const cachedGroups = [
        {
            vendorName: "ULINE",
            vendorPartyId: "party-1",
            urgency: "critical",
            items: [
                {
                    productId: "BOX-101",
                    productName: "Shipping Box",
                    supplierName: "ULINE",
                    supplierPartyId: "party-1",
                    unitPrice: 1.15,
                    stockOnHand: 20,
                    stockOnOrder: 0,
                    purchaseVelocity: 0,
                    salesVelocity: 9,
                    demandVelocity: 9,
                    dailyRate: 9,
                    runwayDays: 2.2,
                    adjustedRunwayDays: 2.2,
                    leadTimeDays: 14,
                    leadTimeProvenance: "14d default",
                    openPOs: [],
                    urgency: "critical",
                    explanation: "Demand exceeds available runway.",
                    suggestedQty: 300,
                    orderIncrementQty: 25,
                    isBulkDelivery: false,
                    finaleReorderQty: 300,
                    finaleStockoutDays: 3,
                    finaleConsumptionQty: 0,
                    finaleDemandQty: 270,
                },
            ],
        },
    ];
    /** The same fixture, typed as the pipeline's return value. */
    const groups = cachedGroups as unknown as PurchasingGroup[];
    const deepDive = [
        { vendorName: "DEEP", vendorPartyId: "p2", urgency: "ok", items: [] },
    ] as unknown as PurchasingGroup[];

    function persistSnapshotFile(key: string, at: number): void {
        writeFileSync(join(cacheDir, `purchasing-${key}.json`), JSON.stringify({ at, value: cachedGroups }));
    }

    function emptySlot(): CacheSlot {
        return { value: null, at: 0, promise: null };
    }

    it("serves a persisted snapshot on a cold slot and reports an overdue refresh, without scanning", async () => {
        // Past one cadence (60 min) + grace (15 min): the scheduler is behind.
        persistSnapshotFile("resale", Date.now() - 80 * 60 * 1000);
        holdScanLock();

        const { readSWR } = await import("./cache");
        const fetcher = vi.fn(async () => []);
        const coldSlot = emptySlot();

        const result = await readSWR(coldSlot, fetcher, false, "resale");

        expect(result.value).toEqual(cachedGroups);
        expect(result.refreshing).toBe(true);
        // THE contract change: a poll must never run a pipeline.
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("does not mark a snapshot stale while the scheduler is still on time", async () => {
        // 40 min old on a 60-min cadence is on schedule - the panel must not
        // claim to be refreshing for most of every hour.
        persistSnapshotFile("resale", Date.now() - 40 * 60 * 1000);
        holdScanLock();

        const { readSWR } = await import("./cache");
        const fetcher = vi.fn(async () => []);
        const coldSlot = emptySlot();

        const result = await readSWR(coldSlot, fetcher, false, "resale");

        expect(result.value).toEqual(cachedGroups);
        expect(result.refreshing).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("reports a fresh snapshot as not refreshing", async () => {
        persistSnapshotFile("resale", Date.now());

        const { readSWR } = await import("./cache");
        const fetcher = vi.fn(async () => []);
        const slot = emptySlot();

        const result = await readSWR(slot, fetcher, false, "resale");

        expect(result.value).toEqual(cachedGroups);
        expect(result.refreshing).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("returns empty and starts a cycle on a truly cold cache, without blocking the request", async () => {
        holdScanLock();

        const { readSWR } = await import("./cache");
        const fetcher = vi.fn(async () => []);
        const slot = emptySlot();

        const result = await readSWR(slot, fetcher, false, "resale");

        expect(result.value).toEqual([]);
        expect(result.refreshing).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        // The lock we planted must still be intact - the cycle respected it.
        expect(existsSync(join(cacheDir, "scan.lock"))).toBe(true);
    });

    it("runs the two pipelines sequentially and never concurrently", async () => {
        const { runScanCycle, resaleSlot, bomSlot } = await import("./cache");
        const order: string[] = [];
        let resaleDone = false;

        await runScanCycle("test", {
            resale: async () => {
                order.push("resale:start");
                await new Promise((r) => setTimeout(r, 20));
                resaleDone = true;
                order.push("resale:end");
                return [];
            },
            bom: async () => {
                // If these overlapped, resale would not have finished yet.
                expect(resaleDone).toBe(true);
                order.push("bom:start");
                return [];
            },
        });

        expect(order).toEqual(["resale:start", "resale:end", "bom:start"]);
        expect(resaleSlot.at).toBeGreaterThan(0);
        expect(bomSlot.at).toBeGreaterThan(0);
    });

    it("de-duplicates concurrent cycles into a single run", async () => {
        const { runScanCycle } = await import("./cache");
        const resale = vi.fn(async () => []);
        const bom = vi.fn(async () => []);
        const deps = { resale, bom };

        await Promise.all([
            runScanCycle("a", deps),
            runScanCycle("b", deps),
            runScanCycle("c", deps),
        ]);

        expect(resale).toHaveBeenCalledTimes(1);
        expect(bom).toHaveBeenCalledTimes(1);
    });

    it("refuses to start a cycle while another process holds the lock", async () => {
        holdScanLock();

        const { runScanCycle, resaleSlot } = await import("./cache");
        const resale = vi.fn(async () => []);
        const bom = vi.fn(async () => []);

        await runScanCycle("blocked", { resale, bom });

        expect(resale).not.toHaveBeenCalled();
        expect(bom).not.toHaveBeenCalled();
        expect(resaleSlot.at).toBe(0);
    });

    it("keeps the previous snapshot when a pipeline throws", async () => {
        const { runScanCycle, resaleSlot, bomSlot } = await import("./cache");
        resaleSlot.value = groups;
        resaleSlot.at = 1;

        await runScanCycle("partial", {
            resale: async () => {
                throw new Error("Finale exploded");
            },
            bom: async () => [],
        });

        // Resale keeps serving the last good value; BOM still completes.
        expect(resaleSlot.value).toEqual(cachedGroups);
        expect(resaleSlot.at).toBe(1);
        expect(bomSlot.at).toBeGreaterThan(0);
    });

    it("marks caches stale on invalidation without dropping the value", async () => {
        holdScanLock();

        const { invalidatePurchasingCaches, resaleSlot, bomSlot } = await import("./cache");
        resaleSlot.value = groups;
        resaleSlot.at = Date.now();
        bomSlot.value = groups;
        bomSlot.at = Date.now();

        invalidatePurchasingCaches();

        expect(resaleSlot.at).toBe(0);
        expect(bomSlot.at).toBe(0);
        // Continuity: the value is retained (an empty list looked like a full reload).
        expect(resaleSlot.value).toEqual(cachedGroups);
    });

    it("does not add a competing scan for a deep-dive window while the lock is held", async () => {
        holdScanLock();

        const { readSWR } = await import("./cache");
        const slot: CacheSlot = { value: groups, at: Date.now(), promise: null, windowKey: "365" };
        const fetcher = vi.fn(async () => []);

        // 730 != 365 -> deep-dive path, but the lock is held so it must not scan.
        const result = await readSWR(slot, fetcher, false, "resale", { windowKey: "730" });

        expect(fetcher).not.toHaveBeenCalled();
        expect(result.value).toEqual(cachedGroups);
        expect(result.refreshing).toBe(true);
    });

    it("runs a deep-dive scan when the lock is free without melting the shared slot", async () => {
        const { readSWR } = await import("./cache");
        const slot: CacheSlot = { value: groups, at: Date.now(), promise: null, windowKey: "365" };
        const fetcher = vi.fn(async () => deepDive);

        const result = await readSWR(slot, fetcher, false, "resale", { windowKey: "730" });

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(result.value).toEqual(deepDive);
        expect(result.refreshing).toBe(false);
        // The shared slot must keep the scheduled window's data.
        expect(slot.value).toEqual(cachedGroups);
    });

    it("persists a completed cycle to disk and releases the lock", async () => {
        const { runScanCycle } = await import("./cache");

        await runScanCycle("persist", { resale: async () => groups, bom: async () => [] });

        // persistSnapshot is fire-and-forget by design; wait for it to land
        // rather than sleeping a fixed amount.
        const waitFor = async (file: string): Promise<void> => {
            for (let i = 0; i < 50; i++) {
                if (existsSync(join(cacheDir, file))) return;
                await new Promise((r) => setTimeout(r, 20));
            }
        };
        await waitFor("purchasing-resale.json");
        await waitFor("purchasing-bom.json");

        expect(existsSync(join(cacheDir, "purchasing-resale.json"))).toBe(true);
        expect(existsSync(join(cacheDir, "purchasing-bom.json"))).toBe(true);
        expect(existsSync(join(cacheDir, "scan.lock"))).toBe(false);
    });
});

describe("scan cadence", () => {
    const MIN = 60 * 60 * 1000;
    const EXPEDITE = 30 * 60 * 1000;
    const SLACK = 2 * 60 * 1000;
    const now = Date.now();
    const originalMin = process.env.ARIA_PURCHASING_REFRESH_MIN_MS;
    const originalExpedite = process.env.ARIA_PURCHASING_EXPEDITE_GAP_MS;

    beforeEach(() => {
        delete (globalThis as { __aria_purchasing_cache?: unknown }).__aria_purchasing_cache;
        process.env.ARIA_PURCHASING_REFRESH_MIN_MS = String(MIN);
        process.env.ARIA_PURCHASING_EXPEDITE_GAP_MS = String(EXPEDITE);
    });

    afterEach(() => {
        if (originalMin === undefined) delete process.env.ARIA_PURCHASING_REFRESH_MIN_MS;
        else process.env.ARIA_PURCHASING_REFRESH_MIN_MS = originalMin;
        if (originalExpedite === undefined) delete process.env.ARIA_PURCHASING_EXPEDITE_GAP_MS;
        else process.env.ARIA_PURCHASING_EXPEDITE_GAP_MS = originalExpedite;
    });

    it("waits the full floor after a cycle that just started", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        expect(computeNextCycleDelayMs({ lastStartedAt: now, refreshWanted: false, now })).toBe(MIN);
    });

    it("measures the floor between STARTS so a 35-min cycle still lands hourly", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        const delay = computeNextCycleDelayMs({
            lastStartedAt: now - 35 * 60 * 1000,
            refreshWanted: false,
            now,
        });
        expect(delay).toBe(MIN - 35 * 60 * 1000); // 25 min
    });

    it("expedites a wanted refresh once past the expedite floor", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        expect(computeNextCycleDelayMs({ lastStartedAt: now - MIN, refreshWanted: true, now })).toBe(0);
        expect(computeNextCycleDelayMs({ lastStartedAt: now - EXPEDITE, refreshWanted: true, now })).toBe(0);
    });

    it("refuses to expedite sooner than the expedite floor", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        // Only 10 min into a 30-min floor: a commit burst must not pull it forward.
        const delay = computeNextCycleDelayMs({
            lastStartedAt: now - 10 * 60 * 1000,
            refreshWanted: true,
            now,
        });
        expect(delay).toBe(MIN - 10 * 60 * 1000); // 50 min
    });

    it("never restarts back-to-back when a cycle overran the floor", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        expect(computeNextCycleDelayMs({ lastStartedAt: now - 70 * 60 * 1000, refreshWanted: false, now })).toBe(SLACK);
    });

    it("does not expedite before any cycle has ever run", async () => {
        const { computeNextCycleDelayMs } = await import("./cache");
        expect(computeNextCycleDelayMs({ lastStartedAt: 0, refreshWanted: true, now })).toBe(SLACK);
    });
});
