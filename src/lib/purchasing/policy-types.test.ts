import { describe, expect, it } from "vitest";

import {
    DEFAULT_VENDOR_AUTOMATION_POLICY,
    createPurchasingAssessment,
    type PurchasingAssessment,
} from "./policy-types";

describe("createPurchasingAssessment", () => {
    it("represents a direct-demand reorder cleanly", () => {
        const assessment = createPurchasingAssessment({
            vendorName: "ULINE",
            productId: "BOX-101",
            decision: "order",
            recommendedQty: 240,
            confidence: "high",
            reasonCodes: ["direct_demand_support"],
            explanation: "Direct sell-through supports an immediate reorder.",
        });

        expect(assessment).toMatchObject({
            vendorName: "ULINE",
            productId: "BOX-101",
            decision: "order",
            recommendedQty: 240,
            confidence: "high",
            reasonCodes: ["direct_demand_support"],
        });
    });

    it("represents a BOM-suppressed hold with downstream coverage context", () => {
        const assessment = createPurchasingAssessment({
            vendorName: "Sustainable Village",
            productId: "VALVE-3MM",
            decision: "hold",
            recommendedQty: 0,
            confidence: "high",
            reasonCodes: ["fg_coverage_sufficient", "bom_demand_suppressed"],
            explanation: "Finished goods already have enough runway, so BOM-driven reorder pressure is suppressed.",
            metrics: {
                directDemand: 0,
                bomDemand: 18,
                sharedDemand: 18,
                stockOnHand: 400,
                stockOnOrder: 0,
                adjustedRunwayDays: 64,
                finishedGoodsCoverageDays: 42,
                leadTimeDays: 14,
            },
        });

        expect(assessment.decision).toBe("hold");
        expect(assessment.reasonCodes).toContain("fg_coverage_sufficient");
        expect(assessment.metrics.finishedGoodsCoverageDays).toBe(42);
    });

    it("supports manual review outcomes with reason codes and metrics", () => {
        const assessment: PurchasingAssessment = createPurchasingAssessment({
            vendorName: "Axiom",
            productId: "LABEL-42",
            decision: "manual_review",
            recommendedQty: 500,
            confidence: "medium",
            reasonCodes: ["pack_size_forced_overbuy", "order_economics_unclear"],
            explanation: "Vendor ordering constraints force material overbuy and need a human decision.",
            metrics: {
                directDemand: 4,
                bomDemand: 0,
                sharedDemand: 4,
                stockOnHand: 120,
                stockOnOrder: 0,
                adjustedRunwayDays: 31,
                finishedGoodsCoverageDays: null,
                leadTimeDays: 21,
            },
        });

        expect(assessment.reasonCodes).toEqual([
            "pack_size_forced_overbuy",
            "order_economics_unclear",
        ]);
        expect(assessment.metrics.leadTimeDays).toBe(21);
    });
});

describe("DEFAULT_VENDOR_AUTOMATION_POLICY", () => {
    it("starts with trusted repeatable vendors enabled for auto-draft evaluation", () => {
        expect(DEFAULT_VENDOR_AUTOMATION_POLICY.trustedVendors).toEqual(
            expect.arrayContaining(["ULINE", "Axiom", "Sustainable Village"]),
        );
        expect(DEFAULT_VENDOR_AUTOMATION_POLICY.defaultLookbackDays).toBeGreaterThan(0);
    });
});
