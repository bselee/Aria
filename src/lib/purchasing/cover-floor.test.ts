/**
 * @file    src/lib/purchasing/cover-floor.test.ts
 * @purpose Contract tests for the 30/45d cover floor: gap semantics (R1 —
 *          the floor raises POST-RECEIPT cover, it never adds a flat 30d on
 *          top of existing stock), history mode floor with the 100x-median
 *          sanity cap (kills corrupt values like 4501447), MOQ interaction,
 *          override/zero-rate passthrough, and the 60d overbuy flags.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    vitest, ./cover-floor
 * @env     none
 */

import { describe, it, expect } from "vitest";
import { applyCoverFloor, MIN_COVER_DAYS, TARGET_COVER_DAYS } from "./cover-floor";

describe("applyCoverFloor", () => {
    it("THC101 canonical (2026-08-24 screenshot): history floor 50 beats the 5-unit gap fill", () => {
        const r = applyCoverFloor({
            sku: "THC101",
            rawNeedQty: 5,
            dailyRate: 0.69,
            stockOnHand: 29,
            stockOnOrder: 0,
            skuPurchaseHistory: [50],
            minimumOrderEaches: 9,
            unitPrice: 45,
        });
        expect(r.qty).toBe(50);
        expect(r.reason).toContain("50");
        expect(r.flags).not.toContain("moq_forced_overbuy");
    });

    it("GLP102: consistent [30, 30] history floors to 30 and cites history", () => {
        const r = applyCoverFloor({
            sku: "GLP102",
            rawNeedQty: 5,
            dailyRate: 0.59,
            stockOnHand: 28,
            stockOnOrder: 0,
            skuPurchaseHistory: [30, 30],
        });
        // 30d flat floor would be ~18 at 0.59/day — qty must clear that either way.
        expect(r.qty).toBeGreaterThanOrEqual(18);
        // The consistent history [30, 30] is the binding floor.
        expect(r.qty).toBe(30);
        expect(r.reason).toMatch(/history/i);
    });

    it("BASLPE103: mode 80 (3 of 7 orders) beats the 30d gap floor; no flags", () => {
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

    it("40d existing cover: gap floor is ~0 (R1), target is 5, qty is the raw need", () => {
        const r = applyCoverFloor({
            sku: "COVER40",
            rawNeedQty: 2,
            dailyRate: 1,
            stockOnHand: 40,
            stockOnOrder: 0,
            skuPurchaseHistory: null,
        });
        expect(r.qty).toBe(2);
        expect(r.floorQty).toBe(0);
        expect(r.targetQty).toBe(TARGET_COVER_DAYS - 40);
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

describe("single-entry history guard", () => {
    it("caps a lone 10,000-unit promo record at 90 days of supply", () => {
        const r = applyCoverFloor({
            sku: "PROMO101", rawNeedQty: 5, dailyRate: 5, stockOnHand: 0, stockOnOrder: 0,
            skuPurchaseHistory: [10000],
        });
        expect(r.qty).toBe(450);
        expect(r.flags).toContain("single_entry_history_capped");
        expect(r.reason).toContain("capped");
    });

    it("keeps trusting a lone entry inside the cap (THC101 canonical)", () => {
        const r = applyCoverFloor({
            sku: "THC101", rawNeedQty: 5, dailyRate: 0.69, stockOnHand: 29, stockOnOrder: 0,
            skuPurchaseHistory: [50], minimumOrderEaches: 9, unitPrice: 45,
        });
        expect(r.qty).toBe(50);
        expect(r.flags).not.toContain("single_entry_history_capped");
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
