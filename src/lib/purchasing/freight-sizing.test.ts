/**
 * @file    src/lib/purchasing/freight-sizing.test.ts
 * @purpose Contract tests for FTL-aware freight sizing — proves bulk raw
 *          needs snap to whole trucks (21 totes x 2,000 lb = 42,000 lb),
 *          that a second truck requires the need to clear 1.5 trucks, that
 *          whole trucks are validated against max cover days, and that the
 *          post-receipt cap (R2) and policy override (R2b) refinements hold.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    freight-sizing.ts (sizeToFreight)
 * @env     none
 */

import { describe, it, expect } from "vitest";
import { sizeToFreight } from "./freight-sizing";

const RICE_BRAN = "RAWRICEBRAN";
const FULL_TRUCK = 42000;
const RATE = 1119.63;

describe("sizeToFreight", () => {
    it("snaps rice bran 33,589 lb need to one full truck (~37.5d supply)", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 33589,
            dailyRate: RATE,
            leadTimeDays: 21,
        });
        expect(result.qty).toBe(FULL_TRUCK);
        expect(result.mode).toBe("full_truck");
        expect(result.daysOfSupply).toBeCloseTo(37.5, 1);
    });

    it("caps a 1.2-truck need at one full truck instead of ordering a second", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 50384,
            dailyRate: RATE,
            leadTimeDays: 21,
        });
        expect(result.qty).toBe(FULL_TRUCK);
        expect(result.mode).toBe("full_truck");
        expect(result.reason).toMatch(/capped at one full truck/i);
    });

    it("orders two full trucks when need exceeds 1.5 trucks", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 70000,
            dailyRate: RATE,
            leadTimeDays: 21,
        });
        expect(result.qty).toBe(84000);
        expect(result.truckCount).toBe(2);
        expect(result.mode).toBe("multi_truck");
    });

    it("snaps a sub-truck need up to one full truck", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 30000,
            dailyRate: RATE,
            leadTimeDays: 21,
        });
        expect(result.qty).toBe(FULL_TRUCK);
        expect(result.mode).toBe("full_truck");
    });

    it("falls back to a partial when a full truck exceeds max cover days", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 400,
            dailyRate: 5,
            leadTimeDays: 21,
        });
        expect(result.mode).toBe("partial");
        expect(result.qty).toBeLessThan(FULL_TRUCK);
        expect(result.reason).toMatch(/exceeds max cover/i);
    });

    it("leaves non-freight SKUs untouched", () => {
        const result = sizeToFreight({
            sku: "THC101",
            rawNeedQty: 20,
            dailyRate: 0.69,
            leadTimeDays: 21,
        });
        expect(result.qty).toBe(20);
        expect(result.mode).toBe("not_freight_constrained");
        expect(result.truckCount).toBe(0);
        expect(result.reason).toBe("not freight-constrained");
    });

    it("never returns a zero or negative qty even for a zero raw need", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 0,
            dailyRate: RATE,
            leadTimeDays: 21,
        });
        expect(result.qty).toBeGreaterThan(0);
    });

    it("R2: partial when a full truck would push post-receipt cover past 90 days", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 30000,
            dailyRate: RATE,
            leadTimeDays: 21,
            stockOnHand: 90000,
            stockOnOrder: 0,
        });
        expect(result.mode).toBe("partial");
        expect(result.qty).toBeLessThan(FULL_TRUCK);
        expect(result.qty).toBe(30000);
    });

    it("R2b: keeps the truck but flags a policy override conflict", () => {
        const result = sizeToFreight({
            sku: RICE_BRAN,
            rawNeedQty: 33589,
            dailyRate: RATE,
            leadTimeDays: 21,
            targetCoverDaysOverride: 30,
        });
        expect(result.mode).toBe("full_truck");
        expect(result.qty).toBe(FULL_TRUCK);
        expect(result.reason).toContain("policy_override_conflict");
    });
});
