import { describe, it, expect } from "vitest";
import { QTY_FORMULA_VERSION, recommendQty, snapToIncrement, type RecommenderInput } from "./qty-recommender";

function baseInput(overrides: Partial<RecommenderInput> = {}): RecommenderInput {
    return {
        sku: "TEST-SKU",
        dailyRate: 2,
        dailyRateSource: "demand",
        dailyRateLabel: "90d demand",
        stockOnHand: 100,
        stockOnOrder: 0,
        openPOCount: 0,
        leadTimeDays: 14,
        leadTimeProvenance: "14d (vendor median)",
        coverBufferDays: 60,
        orderIncrementQty: null,
        ...overrides,
    };
}

describe("snapToIncrement", () => {
    it("returns quantity untouched when no increment", () => {
        expect(snapToIncrement(33, null)).toBe(33);
        expect(snapToIncrement(33, undefined)).toBe(33);
        expect(snapToIncrement(33, 0)).toBe(33);
        expect(snapToIncrement(33, 1)).toBe(33);
    });

    it("rounds up to the nearest pack multiple", () => {
        expect(snapToIncrement(33, 12)).toBe(36);
        expect(snapToIncrement(7, 6)).toBe(12);
    });

    it("enforces a floor of one full pack when below", () => {
        expect(snapToIncrement(2, 12)).toBe(12);
    });

    it("returns exact multiples unchanged", () => {
        expect(snapToIncrement(48, 12)).toBe(48);
    });
});

describe("recommendQty — basic math", () => {
    it("computes runway from on-hand alone when no on-order", () => {
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 100 }));
        expect(result.runwayDays).toBe(50);
        expect(result.adjustedRunwayDays).toBe(50);
    });

    it("extends adjusted runway by on-order qty", () => {
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 100, stockOnOrder: 200, openPOCount: 1 }));
        expect(result.runwayDays).toBe(50);
        expect(result.adjustedRunwayDays).toBe(150);
    });

    it("targets dailyRate × (lead + buffer) and subtracts stock + on-order", () => {
        // 2/d × (14 + 60) = 148 target − 50 on hand − 0 on order = 98 needed
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, coverBufferDays: 60 }));
        expect(result.coverDays).toBe(74);
        expect(result.rawNeededEaches).toBe(98);
        expect(result.suggestedQty).toBe(98);
    });

    it("returns zero when stock + on-order already covers cover window", () => {
        // 2/d × 74d = 148 target; 200 on hand covers it
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 200, leadTimeDays: 14 }));
        expect(result.rawNeededEaches).toBe(0);
        expect(result.suggestedQty).toBe(0);
    });

    it("rounds up to vendor pack size", () => {
        // Need 98 → snap to 12-pack → 108
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, orderIncrementQty: 12,
        }));
        expect(result.rawNeededEaches).toBe(98);
        expect(result.suggestedQty).toBe(108);
    });
});

describe("recommendQty — urgency tiers", () => {
    it("flags critical when adjusted runway is below lead time", () => {
        const result = recommendQty(baseInput({ dailyRate: 10, stockOnHand: 50, leadTimeDays: 14 }));
        // adjustedRunway = 5d < 14d
        expect(result.urgency).toBe("critical");
    });

    it("flags warning when adjusted runway is between lead and lead+30", () => {
        // 14 < runway < 44
        const result = recommendQty(baseInput({ dailyRate: 10, stockOnHand: 200, leadTimeDays: 14 }));
        expect(result.urgency).toBe("warning");
    });

    it("flags watch when adjusted runway is between lead+30 and lead+60", () => {
        // 44 < runway < 74
        const result = recommendQty(baseInput({ dailyRate: 10, stockOnHand: 500, leadTimeDays: 14 }));
        expect(result.urgency).toBe("watch");
    });

    it("flags ok when adjusted runway is past lead+60", () => {
        const result = recommendQty(baseInput({ dailyRate: 10, stockOnHand: 1000, leadTimeDays: 14 }));
        expect(result.urgency).toBe("ok");
    });

    it("uses on-order to demote critical to warning/watch", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10, stockOnHand: 50, stockOnOrder: 1000, openPOCount: 1, leadTimeDays: 14,
        }));
        expect(result.urgency).toBe("ok");
    });
});

describe("recommendQty — provenance trace", () => {
    it("emits a step for each named computation", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, stockOnOrder: 24, openPOCount: 1, leadTimeDays: 14, orderIncrementQty: 12,
        }));
        const steps = result.provenance.map(p => p.step);
        expect(steps).toEqual([
            "daily_rate",
            "on_hand",
            "on_order",
            "runway",
            "cover_days",
            "raw_qty",
            "pack_round",
            "urgency",
        ]);
    });

    it("describes velocity cap when inflated", () => {
        const result = recommendQty(baseInput({
            dailyRate: 0.3,
            velocityInflated: true,
            velocityRawRate: 152,
            velocityRealityCap: 0.3,
        }));
        const dailyStep = result.provenance.find(p => p.step === "daily_rate");
        expect(dailyStep?.detail).toContain("Capped to reality");
        expect(dailyStep?.detail).toContain("152");
        expect(dailyStep?.detail).toContain("0.3");
    });

    it("describes pack rounding when increment is set", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, orderIncrementQty: 12,
        }));
        const packStep = result.provenance.find(p => p.step === "pack_round");
        expect(packStep?.detail).toContain("12-pack");
    });

    it("includes formula version", () => {
        const result = recommendQty(baseInput());
        expect(result.formulaVersion).toBe(QTY_FORMULA_VERSION);
    });
});

describe("recommendQty — explanation backwards compat", () => {
    it("matches the legacy inline format used by the Telegram bot summary", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2.4, stockOnHand: 106, stockOnOrder: 0, leadTimeDays: 14,
        }));
        expect(result.explanation).toContain("Avg 2.4/day (90d demand)");
        expect(result.explanation).toContain("106 in stock");
        expect(result.explanation).toContain("Lead 14d");
    });

    it("appends an open-PO sentence when on-order > 0", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, stockOnOrder: 200, openPOCount: 2,
        }));
        expect(result.explanation).toContain("2 open PO (+200)");
    });
});
