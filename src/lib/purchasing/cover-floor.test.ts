/**
 * @file    src/lib/purchasing/cover-floor.test.ts
 * @purpose Contract tests for the 30/45d cover floor. Bill's rule
 *          (2026-08-24): the ORDER must cover >= 30 days of supply (target 45,
 *          60 usually OK) and, when the order is small, history decides. Tests
 *          the 30d order-supply floor, the history mode floor with the
 *          100x-median sanity cap, the last-order floor for inconsistent
 *          history, MOQ interaction, override/zero-rate passthrough, and the
 *          over-60d flags.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    vitest, ./cover-floor
 * @env     none
 */

import { describe, it, expect } from "vitest";
import { applyCoverFloor, MIN_COVER_DAYS, TARGET_COVER_DAYS } from "./cover-floor";

describe("applyCoverFloor", () => {
    it("THC101 canonical (real data): last-order 50 beats a noisy history + tiny gap", () => {
        const r = applyCoverFloor({
            sku: "THC101",
            rawNeedQty: 5,
            dailyRate: 0.69,
            stockOnHand: 29,
            stockOnOrder: 0,
            skuPurchaseHistory: [50, 30, 20, 25, 45, 30],
            lastPurchaseQty: 50,
            unitPrice: 45,
        });
        expect(r.qty).toBe(50);
        expect(r.reason).toContain("last order was 50");
        expect(r.flags).not.toContain("moq_forced_overbuy");
    });

    it("GLP102 (real data): 30d order-supply floor = 18 when history is inconsistent", () => {
        const r = applyCoverFloor({
            sku: "GLP102",
            rawNeedQty: 5,
            dailyRate: 0.59,
            stockOnHand: 28,
            stockOnOrder: 0,
            skuPurchaseHistory: [20, 30],
            lastPurchaseQty: 20,
        });
        // 30d floor = ceil(30 x 0.59) = 18. History [20,30] is inconsistent,
        // last order 20 is only 10% above 18, so no last-order floor.
        expect(r.qty).toBe(18);
        expect(r.floorQty).toBe(18);
    });

    it("BASLPE103: consistent mode 80 beats the 30d floor; no flags", () => {
        const r = applyCoverFloor({
            sku: "BASLPE103",
            rawNeedQty: 32,
            dailyRate: 1.18,
            stockOnHand: 48,
            stockOnOrder: 0,
            skuPurchaseHistory: [80, 75, 90, 80, 70, 101, 80],
        });
        expect(r.qty).toBe(80);
        expect(r.flags).toEqual([]);
    });

    it("30d order-supply floor applies even with healthy runway (flat, not gap)", () => {
        const r = applyCoverFloor({
            sku: "COVER40",
            rawNeedQty: 2,
            dailyRate: 1,
            stockOnHand: 40,
            stockOnOrder: 0,
            skuPurchaseHistory: null,
        });
        expect(r.floorQty).toBe(MIN_COVER_DAYS); // 30 x 1
        expect(r.targetQty).toBe(TARGET_COVER_DAYS); // 45 x 1
        expect(r.qty).toBe(30);
    });

    it("S-4122: need 500 already above target — unchanged", () => {
        const r = applyCoverFloor({
            sku: "S-4122",
            rawNeedQty: 500,
            dailyRate: 3.96,
            stockOnHand: 126,
            stockOnOrder: 0,
            skuPurchaseHistory: null,
        });
        expect(r.qty).toBe(500);
    });

    it("CHC101: need 234 already above target — unchanged", () => {
        const r = applyCoverFloor({
            sku: "CHC101",
            rawNeedQty: 234,
            dailyRate: 1.4,
            stockOnHand: 59,
            stockOnOrder: 0,
            skuPurchaseHistory: null,
        });
        expect(r.qty).toBe(234);
    });

    it("corrupt history: 4501447 dropped by the 100x-median cap; mode 80 survives", () => {
        const r = applyCoverFloor({
            sku: "RAWRICEBRAN",
            rawNeedQty: 5,
            dailyRate: 1,
            stockOnHand: 5,
            stockOnOrder: 0,
            skuPurchaseHistory: [4501447, 80, 80, 80],
        });
        expect(r.historyFloor).toBe(80);
        expect(r.qty).toBe(80);
    });

    it("targetCoverDaysOverride present: input passthrough with skip reason", () => {
        const r = applyCoverFloor({
            sku: "MTO101",
            rawNeedQty: 12,
            dailyRate: 2,
            stockOnHand: 3,
            stockOnOrder: 0,
            skuPurchaseHistory: [100],
            targetCoverDaysOverride: 45,
        });
        expect(r.qty).toBe(12);
        expect(r.floorQty).toBe(0);
        expect(r.historyFloor).toBeNull();
        expect(r.flags).toEqual([]);
        expect(r.reason).toBe("vendor target cover override present - floor skipped");
    });

    it("dailyRate 0: passthrough with skip reason", () => {
        const r = applyCoverFloor({
            sku: "NOVEL101",
            rawNeedQty: 7,
            dailyRate: 0,
            stockOnHand: 10,
            stockOnOrder: 0,
            skuPurchaseHistory: [50],
        });
        expect(r.qty).toBe(7);
        expect(r.flags).toEqual([]);
        expect(r.reason).toBe("no usable daily rate - floor skipped");
    });

    it("MOQ pushes 500 onto a 0.1/day line: moq_forced_overbuy flagged", () => {
        const r = applyCoverFloor({
            sku: "BULK501",
            rawNeedQty: 1,
            dailyRate: 0.1,
            stockOnHand: 0,
            stockOnOrder: 0,
            skuPurchaseHistory: [],
            minimumOrderEaches: 500,
        });
        expect(r.qty).toBe(500);
        expect(r.flags).toContain("moq_forced_overbuy");
    });

    it("exports the cover constants at the documented values", () => {
        expect(MIN_COVER_DAYS).toBe(30);
        expect(TARGET_COVER_DAYS).toBe(45);
    });
});

describe("last-order floor", () => {
    it("floors to the last order when the suggestion is >= 50% below it", () => {
        const r = applyCoverFloor({
            sku: "LAST1", rawNeedQty: 2, dailyRate: 1, stockOnHand: 0, stockOnOrder: 0,
            skuPurchaseHistory: [30, 20], lastPurchaseQty: 60,
        });
        // 30d floor = 30; last order 60 is 50% above it → floor to 60.
        expect(r.qty).toBe(60);
        expect(r.reason).toContain("last order was 60");
    });

    it("does NOT floor when last order is close to the suggestion", () => {
        const r = applyCoverFloor({
            sku: "LAST2", rawNeedQty: 18, dailyRate: 1, stockOnHand: 0, stockOnOrder: 0,
            skuPurchaseHistory: [20, 30], lastPurchaseQty: 20,
        });
        // base = max(18, 30d floor 30) = 30; last 20 < 30 -> no floor.
        expect(r.qty).toBe(30);
        expect(r.reason).not.toContain("last order was");
    });

    it("rejects a last order > 1000x raw need as corrupt (no floor)", () => {
        const r = applyCoverFloor({
            sku: "LAST3", rawNeedQty: 5, dailyRate: 5, stockOnHand: 0, stockOnOrder: 0,
            skuPurchaseHistory: null, lastPurchaseQty: 10000,
        });
        // 10000 > 1000 x 5 -> rejected; falls back to the 30d supply floor = 150.
        expect(r.qty).toBe(150);
        expect(r.lastOrderFloor).toBeNull();
    });

    it("keeps a real print-run last order (label: 250 vs 20 raw need)", () => {
        const r = applyCoverFloor({
            sku: "OAG109LABELBACK", rawNeedQty: 20, dailyRate: 0.54, stockOnHand: 29, stockOnOrder: 0,
            skuPurchaseHistory: null, lastPurchaseQty: 250,
        });
        // 250 is 12.5x raw need — a legitimate print run, not corrupt.
        expect(r.qty).toBe(250);
        expect(r.reason).toContain("last order was 250");
    });

    it("rejects a lone corrupt history entry (10,000-unit promo) and falls back to the supply floor", () => {
        const r = applyCoverFloor({
            sku: "PROMO101", rawNeedQty: 5, dailyRate: 5, stockOnHand: 0, stockOnOrder: 0,
            skuPurchaseHistory: [10000],
        });
        expect(r.qty).toBe(150);
        expect(r.flags).toContain("history_floor_rejected");
        expect(r.reason).toContain("rejected as corrupt");
    });
});

describe("rule 0: floor never creates an order", () => {
    it("held line (rawNeed 0) with MOQ and history stays 0", () => {
        const r = applyCoverFloor({
            sku: "HELD101", rawNeedQty: 0, dailyRate: 1, stockOnHand: 100, stockOnOrder: 0,
            skuPurchaseHistory: [50], minimumOrderEaches: 100,
        });
        expect(r.qty).toBe(0);
        expect(r.reason).toContain("no need");
    });
});
