import { describe, expect, it } from "vitest";

import {
    assessPurchasingCandidate,
    type PurchasingCandidateInput,
} from "./policy-engine";

function makeCandidate(overrides: Partial<PurchasingCandidateInput> = {}): PurchasingCandidateInput {
    return {
        vendorName: "ULINE",
        productId: "BOX-101",
        directDemand: 10,
        bomDemand: 0,
        stockOnHand: 40,
        stockOnOrder: 0,
        adjustedRunwayDays: 4,
        finishedGoodsCoverageDays: null,
        leadTimeDays: 14,
        suggestedQty: 240,
        orderIncrementQty: 1,
        minimumOrderQty: null,
        minimumOrderValue: null,
        unitPrice: 1.25,
        ...overrides,
    };
}

describe("assessPurchasingCandidate", () => {
    it("returns order for direct-demand-only items with short runway", () => {
        const assessment = assessPurchasingCandidate(makeCandidate());

        expect(assessment.decision).toBe("order");
        expect(assessment.reasonCodes).toContain("direct_demand_support");
        expect(assessment.recommendedQty).toBe(240);
    });

    it("holds BOM-heavy components when finished goods already have healthy coverage", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            vendorName: "Sustainable Village",
            productId: "VALVE-3MM",
            directDemand: 0,
            bomDemand: 18,
            adjustedRunwayDays: 28,
            finishedGoodsCoverageDays: 42,
            suggestedQty: 180,
        }));

        expect(assessment.decision).toBe("hold");
        expect(assessment.reasonCodes).toEqual(
            expect.arrayContaining(["fg_coverage_sufficient", "bom_demand_suppressed"]),
        );
        expect(assessment.recommendedQty).toBe(0);
    });

    it("still orders mixed-demand items when direct demand justifies it", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            productId: "BAG-200",
            directDemand: 8,
            bomDemand: 20,
            adjustedRunwayDays: 6,
            finishedGoodsCoverageDays: 38,
            suggestedQty: 300,
        }));

        expect(assessment.decision).toBe("order");
        expect(assessment.reasonCodes).toContain("direct_demand_support");
        expect(assessment.recommendedQty).toBe(300);
    });

    it("holds when on-order inventory already covers the need", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            stockOnHand: 40,
            stockOnOrder: 500,
            adjustedRunwayDays: 55,
        }));

        expect(assessment.decision).toBe("hold");
        expect(assessment.reasonCodes).toContain("on_order_already_covers_need");
    });

    it("routes to manual review when pack sizing forces large overbuy", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            productId: "LABEL-42",
            suggestedQty: 500,
            orderIncrementQty: 5000,
            unitPrice: 0.12,
        }));

        expect(assessment.decision).toBe("manual_review");
        expect(assessment.reasonCodes).toContain("pack_size_forced_overbuy");
    });

    it("holds tiny uneconomic orders that do not meet a practical minimum order value", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            vendorName: "Axiom",
            productId: "CARD-1",
            suggestedQty: 25,
            unitPrice: 0.5,
            minimumOrderValue: 100,
        }));

        expect(assessment.decision).toBe("hold");
        expect(assessment.reasonCodes).toContain("order_economics_unclear");
    });

    it("keeps manual items actionable when movement still supports reorder", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            reorderMethod: "manual",
            directDemand: 6,
            suggestedQty: 150,
        }) as any);

        expect(assessment.decision).toBe("order");
    });

    it("treats default with current consumption like demand-driven movement", () => {
        const assessment = assessPurchasingCandidate(makeCandidate({
            reorderMethod: "default",
            directDemand: 0,
            bomDemand: 20,
            finishedGoodsCoverageDays: 12,
            suggestedQty: 200,
        }) as any);

        expect(assessment.decision).toBe("order");
    });
});
