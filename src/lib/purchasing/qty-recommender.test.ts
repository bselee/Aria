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
        // v2.2: cognitive ladder (tier 30-99 step 10) snaps 98 → 100 (Δ2 vs Δ8 to 90)
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, coverBufferDays: 60 }));
        expect(result.coverDays).toBe(74);
        expect(result.rawNeededEaches).toBe(98);
        expect(result.suggestedQty).toBe(100);
    });

    it("defaults to lead time plus 30 days when no cover buffer is provided", () => {
        const result = recommendQty({
            sku: "BOX-101",
            dailyRate: 2,
            dailyRateSource: "demand",
            dailyRateLabel: "90d demand",
            stockOnHand: 50,
            stockOnOrder: 0,
            openPOCount: 0,
            leadTimeDays: 14,
            leadTimeProvenance: "14d (vendor median)",
            orderIncrementQty: null,
        });

        expect(result.coverDays).toBe(44);
        expect(result.rawNeededEaches).toBe(38);
    });

    it("returns zero when stock + on-order already covers cover window", () => {
        // 2/d × 74d = 148 target; 200 on hand covers it
        const result = recommendQty(baseInput({ dailyRate: 2, stockOnHand: 200, leadTimeDays: 14 }));
        expect(result.rawNeededEaches).toBe(0);
        expect(result.suggestedQty).toBe(0);
    });

    it("rounds up to vendor pack size", () => {
        // Need 98 → pack-snap to 12-pack → 108.
        // v2.2: cognitive ladder snaps 108 → 100 (tier 100-249, step 25).
        // honorPack tries pack-multiple of 100: 96 or 108. 96 < 108 floor →
        // forced up to 108. Pack increment is a hard vendor constraint;
        // cognitive rounding cannot underbuy below the pack-rounded need.
        const result = recommendQty(baseInput({
            dailyRate: 2, stockOnHand: 50, leadTimeDays: 14, orderIncrementQty: 12,
        }));
        expect(result.rawNeededEaches).toBe(98);
        expect(result.suggestedQty).toBe(108);
    });

    it("uses a 10-each fallback increment for Miles Filippelli when Finale has no pack info", () => {
        const seven = recommendQty(baseInput({
            vendorName: "Miles Filippelli",
            dailyRate: 0.2, // 30d floor is 6, does not collide with 10 snap
            stockOnHand: 0,
            leadTimeDays: 35, // 0.2 * 35 = 7 raw eaches
            coverBufferDays: 0,
            orderIncrementQty: null,
        }));
        const twentyTwo = recommendQty(baseInput({
            vendorName: "Miles Filippelli",
            dailyRate: 0.2, // 30d floor is 6, does not collide with 30 snap
            stockOnHand: 0,
            leadTimeDays: 110, // 0.2 * 110 = 22 raw eaches
            coverBufferDays: 0,
            orderIncrementQty: null,
        }));

        expect(seven.rawNeededEaches).toBe(7);
        expect(seven.suggestedQty).toBe(10);
        expect(twentyTwo.rawNeededEaches).toBe(22);
        expect(twentyTwo.suggestedQty).toBe(30);
        expect(twentyTwo.provenance.find(step => step.step === "pack_round")?.detail)
            .toContain("Miles Filippelli fallback");
    });

    it("does not override Finale pack info for Miles Filippelli", () => {
        const result = recommendQty(baseInput({
            vendorName: "Miles Filippelli",
            dailyRate: 0.2, // 30d floor is 6
            stockOnHand: 0,
            leadTimeDays: 110, // 0.2 * 110 = 22 raw eaches
            coverBufferDays: 0,
            orderIncrementQty: 12,
        }));

        expect(result.rawNeededEaches).toBe(22);
        expect(result.suggestedQty).toBe(24);
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

    it("formula version reflects the current recommender version", () => {
        expect(QTY_FORMULA_VERSION).toBe("v2.8-residual-topup-cap-2026-07-10");
    });
});

describe("recommendQty — residual top-up cap (v2.8)", () => {
    it("caps open-PO residual to order-point window, not full aggressive cover", () => {
        // RAWWORM-style: high cover (90d) with large open PO still left a huge residual.
        // daily 1000, lead 14, cover 90 → target 90k
        // on hand 0 + open 42k → full residual 48k
        // order-point (14+30)=44d → 44k; residual at OP = max(0, 44k-42k) = 2k
        const result = recommendQty(baseInput({
            sku: "RAWWORMCASTINGS",
            dailyRate: 1000,
            stockOnHand: 0,
            stockOnOrder: 42000,
            openPOCount: 1,
            leadTimeDays: 14,
            coverBufferDays: 30,
            targetCoverDays: 90,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));

        expect(result.coverDays).toBe(90);
        // Cap to order-point residual (not 48k full-cover residual)
        expect(result.rawNeededEaches).toBe(2000);
        const capStep = result.provenance.find(p => p.step === "residual_topup_cap");
        expect(capStep).toBeDefined();
        expect(capStep?.detail).toMatch(/capped/i);
        // 2k raw residual may bump via 2× floor / cognitive snap — keep far below full 48k
        expect(result.suggestedQty).toBeGreaterThan(0);
        expect(result.suggestedQty).toBeLessThanOrEqual(5000);
    });

    it("does not invent residual when open PO already covers order point", () => {
        // order-point 44d * 1000 = 44k; open 50k covers OP even if full cover is 90k
        const result = recommendQty(baseInput({
            dailyRate: 1000,
            stockOnHand: 0,
            stockOnOrder: 50000,
            openPOCount: 1,
            leadTimeDays: 14,
            targetCoverDays: 90,
            orderIncrementQty: 1,
            historicalLineQtys: [],
            historicalCapMultiple: null,
        }));
        expect(result.rawNeededEaches).toBe(0);
        expect(result.suggestedQty).toBe(0);
    });
});

describe("recommendQty — cognitive rounding integration", () => {
    it("Will's example: 591 raw + Colorful history snaps to 500 with historical_round provenance", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10,
            stockOnHand: 0,
            stockOnOrder: 0,
            leadTimeDays: 21,
            targetCoverDays: 60,    // 10/d × 60d = 600 raw need; close to Colorful 500/1000 cluster
            historicalLineQtys: [500, 1000, 500, 500, 1000, 500],
        }));
        // Raw need 600, historical snap → 500 (closer than 1000)
        expect(result.suggestedQty).toBe(500);
        expect(result.roundingMethod).toBe("historical");
        const step = result.provenance.find(p => p.step === "historical_round");
        expect(step).toBeDefined();
        expect(step?.detail).toContain("500");
    });

    it("explicit favoriteBatches overrides historical", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10, stockOnHand: 0, leadTimeDays: 21, targetCoverDays: 60,
            historicalLineQtys: [500, 500, 1000, 500],
            favoriteBatches: [250, 750],
        }));
        // Raw 600, explicit favorites [250, 750] — nearest is 750.
        expect(result.suggestedQty).toBe(750);
        expect(result.roundingMethod).toBe("vendor_explicit");
        expect(result.provenance.find(p => p.step === "vendor_round")).toBeDefined();
    });

    it("no history + no explicit → cognitive ladder", () => {
        const result = recommendQty(baseInput({
            dailyRate: 0.5, stockOnHand: 0, leadTimeDays: 14, coverBufferDays: 30, // 0.5/d × 44d = 22 raw, 30d floor is 15
        }));
        expect(result.suggestedQty).toBe(25);
        expect(result.roundingMethod).toBe("cognitive");
        expect(result.provenance.find(p => p.step === "cognitive_round")).toBeDefined();
    });

    it("MOQ still wins over cognitive snap", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1, stockOnHand: 0, leadTimeDays: 14, coverBufferDays: 8,  // raw 22
            minimumOrderEaches: 100,
            moqMode: "enforce",
        }));
        // Cognitive snaps 22 → 25, MOQ bumps 25 → 100.
        expect(result.suggestedQty).toBe(100);
        expect(result.moqApplied).toBe(true);
    });

    it("formula version is bumped to current", () => {
        expect(QTY_FORMULA_VERSION).toBe("v2.8-residual-topup-cap-2026-07-10");
    });

    it("emits 2 rounding alternatives for the UI dropdown", () => {
        const result = recommendQty(baseInput({
            dailyRate: 10, stockOnHand: 0, leadTimeDays: 21, targetCoverDays: 60,
            historicalLineQtys: [500, 1000, 500, 500, 1000, 500],
        }));
        expect(result.roundingAlternatives).toBeDefined();
        expect(result.roundingAlternatives!.length).toBeGreaterThan(0);
    });
});

describe("recommendQty — v2.4 30-day minimum floor & historical PO deviation checks", () => {
    it("enforces a 2×-capped 30-day supply floor (v2.7 — prevents overbuys)", () => {
        // Daily rate = 5. CoverDays would normally suggest 150 target, rawNeed = 10.
        // The uncapped 30d floor was 150 (15× overbuy). v2.7 caps it at 2× raw need = 20.
        const result = recommendQty(baseInput({
            dailyRate: 5,
            stockOnHand: 140, // very close to lead time + cover target
            leadTimeDays: 14,
            coverBufferDays: 16, // total target = 5 * 30 = 150 target eaches. rawNeed = 10 eaches.
        }));
        // v2.7 capped floor: min(150, 10*2) = 20. 10 < 20, so bumped to 20.
        expect(result.suggestedQty).toBe(20);
        const packStep = result.provenance.find(p => p.step === "pack_round");
        expect(packStep?.detail).toContain("2×-capped supply floor");
    });

    it("pack snap satisfies the capped floor without extra bump", () => {
        const result = recommendQty(baseInput({
            dailyRate: 5,
            stockOnHand: 140,
            leadTimeDays: 14,
            coverBufferDays: 16,
            orderIncrementQty: 24, // Case pack = 24
        }));
        // rawNeed = 10, cappedMin30 = 20, snapToIncrement(10, 24) = 24.
        // 24 >= 20 → pack snap already satisfies floor.
        expect(result.suggestedQty).toBe(24);
    });

    it("adds a review flag when suggested quantity deviates by more than 50% from last order", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2,
            stockOnHand: 0,
            leadTimeDays: 14,
            coverBufferDays: 16, // raw needed = 60
            lastPurchaseQty: 10, // last purchase was tiny (10 units), suggestion is 60 (+500% deviation)
        }));
        expect(result.reviewRequired).toBe(true);
        expect(result.reviewReasons.join(" ")).toMatch(/last order|different/i);
    });
});

describe("recommendQty — v2.6 historical order floor", () => {
    // Helper: inputs that produce a small positive recommendation
    // so the historical floor actually fires (need > 0, need < 20).
    const lowNeedInput = {
        dailyRate: 0.3,
        stockOnHand: 5,
        stockOnOrder: 0,
        leadTimeDays: 14,
        coverBufferDays: 20,
    };

    it("bumps qty to standard_order_qty when below explicit policy floor", () => {
        const result = recommendQty(baseInput({
            ...lowNeedInput,
            standardOrderQty: 20,
        }));
        expect(result.historicalFloorApplied).toBe(true);
        expect(result.suggestedQty).toBeGreaterThanOrEqual(20);
        expect(result.provenance.some(s => s.step === "standard_order_floor")).toBe(true);
    });

    it("auto-detects consistent SKU pattern and bumps to mode", () => {
        const result = recommendQty(baseInput({
            ...lowNeedInput,
            skuPurchaseHistory: [20, 20, 20, 15, 20], // mode = 20 (80% consistency)
        }));
        expect(result.historicalFloorApplied).toBe(true);
        expect(result.suggestedQty).toBeGreaterThanOrEqual(20);
        expect(result.provenance.some(s => s.step === "historical_floor")).toBe(true);
    });

    it("does NOT bump when history is inconsistent (no clear pattern)", () => {
        const result = recommendQty(baseInput({
            ...lowNeedInput,
            skuPurchaseHistory: [5, 10, 20, 15, 8], // no mode ≥ 60%
        }));
        expect(result.historicalFloorApplied).toBe(false);
    });

    it("does NOT bump when suggested qty is already above the historical floor", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2,
            stockOnHand: 0,
            stockOnOrder: 0,
            leadTimeDays: 14,
            coverBufferDays: 60,
            standardOrderQty: 20,
        }));
        expect(result.suggestedQty).toBeGreaterThan(20);
        expect(result.historicalFloorApplied).toBe(false);
    });

    it("uses lastPurchaseQty as fallback floor when no multi-PO history exists", () => {
        const result = recommendQty(baseInput({
            ...lowNeedInput,
            lastPurchaseQty: 20,
            skuPurchaseHistory: [],
        }));
        expect(result.historicalFloorApplied).toBe(true);
        expect(result.suggestedQty).toBeGreaterThanOrEqual(20);
        expect(result.provenance.some(s => s.step === "last_purchase_floor")).toBe(true);
    });
});

