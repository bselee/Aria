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
            "lead_time",
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

describe("recommendQty — calibration safety multiplier", () => {
    it("widens cover days when safetyMultiplier > 1 and sample count >= 5", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, coverBufferDays: 60,
            safetyMultiplier: 1.5, calibrationSampleCount: 8, calibrationMedianErrorPct: -32,
        }));
        // base cover = 14 + 60 = 74. With 1.5x multiplier on buffer: 14 + 90 = 104.
        expect(result.coverDays).toBe(104);
        expect(result.safetyMultiplier).toBe(1.5);
        const coverStep = result.provenance.find(p => p.step === "cover_days");
        expect(coverStep?.detail).toContain("median error");
        expect(coverStep?.detail).toContain("8 samples");
    });

    it("ignores multiplier with insufficient sample count (< 5)", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, coverBufferDays: 60,
            safetyMultiplier: 1.5, calibrationSampleCount: 3,
        }));
        // multiplier still applied to math, but trace should not reference samples
        const coverStep = result.provenance.find(p => p.step === "cover_days");
        expect(coverStep?.detail).not.toContain("samples");
    });

    it("clamps multiplier to [0.5, 2.5] to prevent runaway calibration", () => {
        const high = recommendQty(baseInput({ safetyMultiplier: 100 }));
        expect(high.safetyMultiplier).toBe(2.5);
        const low = recommendQty(baseInput({ safetyMultiplier: 0.01 }));
        expect(low.safetyMultiplier).toBe(0.5);
    });
});

describe("recommendQty — draft PO reservation", () => {
    it("subtracts reserved qty from supply pool", () => {
        // 2/d × 74d = 148 target. 50 on hand + 100 on order - 50 reserved = 100 effective.
        // Need 148 - 100 = 48.
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, stockOnOrder: 100, openPOCount: 1,
            reservedQty: 50, reservedDraftPOs: ["DRAFT-9999"],
            leadTimeDays: 14,
        }));
        expect(result.rawNeededEaches).toBe(48);
        expect(result.reservedQty).toBe(50);
    });

    it("emits a reserved provenance step listing draft POs", () => {
        const result = recommendQty(baseInput({
            reservedQty: 30, reservedDraftPOs: ["DRAFT-1", "DRAFT-2"],
        }));
        const reservedStep = result.provenance.find(p => p.step === "reserved");
        expect(reservedStep).toBeTruthy();
        expect(reservedStep?.detail).toContain("DRAFT-1");
        expect(reservedStep?.detail).toContain("DRAFT-2");
    });

    it("reduces adjusted runway when reservations exist", () => {
        const without = recommendQty(baseInput({ stockOnHand: 50, stockOnOrder: 100, openPOCount: 1 }));
        const withReserved = recommendQty(baseInput({ stockOnHand: 50, stockOnOrder: 100, openPOCount: 1, reservedQty: 50 }));
        expect(withReserved.adjustedRunwayDays).toBeLessThan(without.adjustedRunwayDays);
    });
});

describe("recommendQty — vendor MOQ enforcement", () => {
    it("bumps up to minimum eaches when below MOQ", () => {
        // Need 30, MOQ is 100 — bump.
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 44, leadTimeDays: 14,
            minimumOrderEaches: 100,
        }));
        expect(result.suggestedQty).toBe(100);
        expect(result.moqApplied).toBe(true);
        expect(result.provenance.find(p => p.step === "moq")?.detail).toContain("Bumped");
    });

    it("snaps MOQ bump to pack increment when set", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 44, leadTimeDays: 14,
            minimumOrderEaches: 100, orderIncrementQty: 24,
        }));
        // 100 snapped to 24-pack → 120
        expect(result.suggestedQty).toBe(120);
    });

    it("bumps up to minimum dollars when below MOQ", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 44, leadTimeDays: 14,
            minimumOrderDollars: 500, unitPrice: 10,
        }));
        // need 30 × $10 = $300, MOQ = $500 → 50 eaches
        expect(result.suggestedQty).toBeGreaterThanOrEqual(50);
        expect(result.moqApplied).toBe(true);
    });

    it("does not apply MOQ when no order is needed", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 1000,  // already covered
            minimumOrderEaches: 100,
        }));
        expect(result.suggestedQty).toBe(0);
        expect(result.moqApplied).toBe(false);
    });
});

describe("recommendQty — P90 lead time", () => {
    it("uses P90 instead of point estimate when provided", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50,
            leadTimeDays: 7, leadTimeP90: 14,
        }));
        expect(result.leadTimeUsed).toBe(14);
        expect(result.leadTimeBasis).toBe("p90");
        expect(result.coverDays).toBe(74);  // 14 + 60
    });

    it("falls back to point estimate when no P90 provided", () => {
        const result = recommendQty(baseInput({ leadTimeDays: 14 }));
        expect(result.leadTimeUsed).toBe(14);
        expect(result.leadTimeBasis).not.toBe("p90");
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

describe("recommendQty — vendor reorder policy", () => {
    it("uses targetCoverDays as total cover when provided", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2,
            stockOnHand: 50,
            leadTimeDays: 14,
            targetCoverDays: 180,
        }));

        expect(result.coverDays).toBe(180);
        // need = 2/d × 180d − 50 = 310
        expect(result.rawNeededEaches).toBe(310);
        const coverStep = result.provenance.find(p => p.step === "cover_days");
        expect(coverStep?.detail).toContain("vendor policy");
    });

    it("cover override mentions safetyMultiplier bypass when calibration would have shifted it", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2,
            stockOnHand: 50,
            leadTimeDays: 14,
            targetCoverDays: 180,
            safetyMultiplier: 1.25,
            calibrationSampleCount: 8,
        }));

        // Cover stays 180, NOT 180 × 1.25
        expect(result.coverDays).toBe(180);
        const coverStep = result.provenance.find(p => p.step === "cover_days");
        expect(coverStep?.detail).toContain("bypassed");
    });

    it("uses lead time override ahead of P90 or point estimate", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 0,
            leadTimeDays: 14,
            leadTimeP90: 21,
            leadTimeOverrideDays: 45,
        }));

        expect(result.leadTimeUsed).toBe(45);
        const ltStep = result.provenance.find(p => p.step === "lead_time");
        expect(ltStep?.detail).toContain("override");
    });

    it("warns but does not bump quantity when moqMode is warn", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            minimumOrderEaches: 100,
            moqMode: "warn",
        }));

        // need = 1/d × 74d − 44 = 30; warn does not bump
        expect(result.suggestedQty).toBe(30);
        expect(result.moqApplied).toBe(false);
        expect(result.moqWarning).toBe(true);
        const moqStep = result.provenance.find(p => p.step === "moq");
        expect(moqStep?.detail).toContain("warn-only");
    });

    it("ignores MOQ when moqMode is ignore", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            minimumOrderEaches: 100,
            moqMode: "ignore",
        }));

        expect(result.suggestedQty).toBe(30);
        expect(result.moqApplied).toBe(false);
        expect(result.moqWarning).toBe(false);
    });

    it("flags review when pack rounding creates a large overbuy", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            orderIncrementQty: 100,
            unitPrice: 20,
            overbuyReviewPct: 50,
            overbuyReviewDollars: 1000,
        }));

        // need=30, snapped to 100-pack → 100. Overbuy=70 / 30 = 233% pct, $1400.
        expect(result.suggestedQty).toBe(100);
        expect(result.reviewRequired).toBe(true);
        expect(result.reviewReasons.join(" ")).toMatch(/overbuy/i);
    });

    it("does not flag review when overbuy is below both thresholds", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 75,
            leadTimeDays: 14,
            orderIncrementQty: 1,
            unitPrice: 5,
            // need = 74 − 75 ⇒ 0 → no order, no review
            overbuyReviewPct: 50,
            overbuyReviewDollars: 1000,
        }));

        expect(result.suggestedQty).toBe(0);
        expect(result.reviewRequired).toBe(false);
        expect(result.reviewReasons).toEqual([]);
    });

    it("formula version reflects the v2.1 policy bump", () => {
        expect(QTY_FORMULA_VERSION).toBe("v2.1-vendor-policy-2026-05-06");
    });
});
