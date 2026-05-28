import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("purchasing cache persistence", () => {
    let cacheDir: string;
    const originalCacheDir = process.env.ARIA_PURCHASING_CACHE_DIR;

    beforeEach(() => {
        vi.resetModules();
        cacheDir = mkdtempSync(join(tmpdir(), "aria-purchasing-cache-"));
        process.env.ARIA_PURCHASING_CACHE_DIR = cacheDir;
    });

    afterEach(() => {
        if (originalCacheDir === undefined) {
            delete process.env.ARIA_PURCHASING_CACHE_DIR;
        } else {
            process.env.ARIA_PURCHASING_CACHE_DIR = originalCacheDir;
        }
        rmSync(cacheDir, { recursive: true, force: true });
    });

    it("hydrates a cold resale slot from the last persisted snapshot while refreshing stale data", async () => {
        const staleAt = Date.now() - 31 * 60 * 1000;
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
        writeFileSync(
            join(cacheDir, "purchasing-resale.json"),
            JSON.stringify({ at: staleAt, value: cachedGroups }),
        );

        const { readSWR } = await import("./cache");
        let resolveRefresh!: (value: []) => void;
        const refreshPromise = new Promise<[]>((resolve) => {
            resolveRefresh = resolve;
        });
        const fetcher = vi.fn(() => refreshPromise);
        const coldSlot = { value: null, at: 0, promise: null };

        const result = await readSWR(coldSlot, fetcher, false, "resale");

        expect(result.value).toEqual(cachedGroups);
        expect(result.refreshing).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(coldSlot.value).toEqual(cachedGroups);

        resolveRefresh([]);
        await coldSlot.promise;
    });
});
