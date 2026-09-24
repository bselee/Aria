/**
 * @file    src/lib/purchasing/sku-lead-time.test.ts
 * @purpose Unit tests for time-weighted / trend-aware SKU lead planning.
 * @author  Hermia
 * @created 2026-07-29
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
    clearSkuLeadTimeCache,
    cardLeadLabel,
    dropLoneLeadOutlier,
    ewmaLeadDays,
    getObservedSkuLeadDays,
    planSkuLead,
    planningLeadDaysFromSamples,
    robustLeadDays,
    setSkuLeadTimeSamples,
    type SkuLeadSample,
} from "./sku-lead-time";
import { resolveLeadTimeDays } from "./oag-powder-policy";

function s(days: number, receiveDate: string): SkuLeadSample {
    return { days, receiveDate };
}

describe("sku-lead-time wizardry", () => {
    beforeEach(() => clearSkuLeadTimeCache());

    it("IQR drops a lone extreme when n≥5", () => {
        const samples = [
            s(20, "2026-01-01"),
            s(22, "2026-02-01"),
            s(21, "2026-03-01"),
            s(23, "2026-04-01"),
            s(200, "2026-05-01"), // outlier
        ];
        const r = robustLeadDays(samples);
        expect(r).not.toContain(200);
        expect(r.length).toBe(4);
    });

    it("EWMA overweight recent receipts", () => {
        const asOf = new Date("2026-07-01").getTime();
        const samples = [
            s(100, "2025-01-01"), // old slow
            s(20, "2026-06-15"), // recent fast
        ];
        const e = ewmaLeadDays(samples, 90, asOf)!;
        // Should sit much closer to 20 than to 100
        expect(e).toBeLessThan(50);
        expect(e).toBeGreaterThan(15);
    });

    it("slowing trend lifts planning lead above pure center", () => {
        const samples = [
            s(20, "2025-06-01"),
            s(22, "2025-08-01"),
            s(21, "2025-10-01"),
            s(45, "2026-03-01"),
            s(50, "2026-05-01"),
            s(48, "2026-07-01"),
        ];
        const plan = planSkuLead(samples, new Date("2026-07-15").getTime())!;
        expect(plan.trend).toBe("slowing");
        expect(plan.days).toBeGreaterThanOrEqual(45);
        expect(plan.provenance).toMatch(/slowing/);
    });

    it("stable cluster stays near observed band", () => {
        const samples = [
            s(14, "2026-01-01"),
            s(16, "2026-02-01"),
            s(15, "2026-03-01"),
            s(17, "2026-04-01"),
            s(15, "2026-05-01"),
            s(16, "2026-06-01"),
        ];
        const plan = planSkuLead(samples, new Date("2026-07-01").getTime())!;
        expect(plan.days).toBeGreaterThanOrEqual(14);
        expect(plan.days).toBeLessThanOrEqual(25);
        expect(plan.confidence).toBe("high");
    });

    it("cache + powder policy still wins over observed", () => {
        setSkuLeadTimeSamples(
            new Map([
                [
                    "OAG999",
                    [
                        s(30, "2026-01-01"),
                        s(35, "2026-03-01"),
                        s(40, "2026-05-01"),
                        s(42, "2026-07-01"),
                    ],
                ],
            ]),
        );
        const obs = getObservedSkuLeadDays("oag999");
        expect(obs).not.toBeNull();
        expect(obs!.n).toBe(4);
        expect(obs!.provenance).toMatch(/SKU plan/);

        expect(
            resolveLeadTimeDays({
                productId: "OAG223",
                vendorPolicyLeadDays: 21,
                skuObservedLeadDays: 40,
                baseLeadDays: 21,
            }).days,
        ).toBe(120);

        expect(
            resolveLeadTimeDays({
                productId: "WIDGET",
                vendorPolicyLeadDays: 21,
                skuObservedLeadDays: obs!.days,
                skuObservedProvenance: obs!.provenance,
                baseLeadDays: 21,
            }).days,
        ).toBe(obs!.days);
    });

    it("day-array helper still works", () => {
        expect(planningLeadDaysFromSamples([10, 20, 30, 40, 50])).toBeGreaterThan(0);
    });

    it("a lone 60d cycle does not set the plan", () => {
        expect(planSkuLead([s(60, "2026-09-17")])).toBeNull();
    });

    it("a lone normal receipt still sets the plan", () => {
        const plan = planSkuLead([s(14, "2026-06-01")])!;
        expect(plan.days).toBe(14);
    });

    it("drops one long cycle against a short cluster", () => {
        const plan = planSkuLead([
            s(16, "2026-03-01"),
            s(60, "2026-09-17"),
        ], new Date("2026-09-24").getTime())!;
        expect(plan.days).toBeLessThanOrEqual(21);
        expect(plan.provenance.toLowerCase()).toMatch(/exclud/);
    });

    it("keeps a repeated long lead when nothing is short", () => {
        const plan = planSkuLead([
            s(55, "2026-01-01"),
            s(60, "2026-04-01"),
            s(58, "2026-07-01"),
        ], new Date("2026-09-01").getTime())!;
        expect(plan.days).toBeGreaterThanOrEqual(55);
    });

    it("drops a sample the PO thread marked as a stockout hold", () => {
        const plan = planSkuLead([
            s(16, "2026-03-01"),
            { days: 56, receiveDate: "2026-09-17", orderId: "125126", holdExcluded: true, holdNote: "PO 125126 sold out" },
        ])!;
        expect(plan.days).toBeLessThanOrEqual(21);
        expect(plan.provenance).toMatch(/125126/);
    });

    it("a lone long cycle does not set the vendor lead for every SKU", () => {
        expect(dropLoneLeadOutlier([14, 16, 15, 60])).toEqual([14, 16, 15]);
        expect(dropLoneLeadOutlier([43, 44, 50, 57])).toEqual([43, 44, 50, 57]);
    });

    it("does not caption a SKU plan as the 21d default", () => {
        expect(cardLeadLabel({
            resolvedProvenance: "16d SKU plan · n=1",
            skuObserved: true,
            baseProvenance: "21d default",
            exclusionNote: null,
            powderOverride: false,
        })).toBe("16d SKU plan · n=1");
        expect(cardLeadLabel({
            resolvedProvenance: "21d base",
            skuObserved: false,
            baseProvenance: "21d default",
            exclusionNote: "PO 125126 stockout hold excluded",
            powderOverride: false,
        })).toMatch(/125126/);
        expect(cardLeadLabel({
            resolvedProvenance: "21d base",
            skuObserved: false,
            baseProvenance: "21d default",
            exclusionNote: null,
            powderOverride: false,
        })).toBe("21d default");
    });
});
