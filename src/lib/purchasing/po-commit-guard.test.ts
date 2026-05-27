import { describe, expect, it } from "vitest";

import { assessPOCommitGuard, assessPOCommitGuardsForLines } from "./po-commit-guard";
import type { AssessedPurchasingLine } from "./assessment-service";

function line(overrides: Partial<AssessedPurchasingLine> = {}): AssessedPurchasingLine {
    const base: AssessedPurchasingLine = {
        item: {
            productId: "BOX-101",
            productName: "Shipping Box",
            supplierName: "ULINE",
            supplierPartyId: "party-1",
            unitPrice: 2,
            stockOnHand: 10,
            stockOnOrder: 0,
            purchaseVelocity: 0,
            salesVelocity: 2,
            demandVelocity: 2,
            dailyRate: 2,
            runwayDays: 5,
            adjustedRunwayDays: 5,
            leadTimeDays: 14,
            leadTimeProvenance: "14d (Finale)",
            openPOs: [],
            urgency: "critical",
            explanation: "Demand exceeds runway.",
            suggestedQty: 78,
            orderIncrementQty: 1,
            isBulkDelivery: false,
            finaleReorderQty: 78,
            finaleStockoutDays: 5,
            finaleConsumptionQty: 0,
            finaleDemandQty: 180,
        },
        candidate: {
            vendorName: "ULINE",
            productId: "BOX-101",
            directDemand: 2,
            bomDemand: 0,
            stockOnHand: 10,
            stockOnOrder: 0,
            adjustedRunwayDays: 5,
            finishedGoodsCoverageDays: null,
            leadTimeDays: 14,
            suggestedQty: 78,
            orderIncrementQty: 1,
            minimumOrderQty: null,
            minimumOrderValue: null,
            unitPrice: 2,
            explanation: "Demand exceeds runway.",
            sourceUrgency: "critical",
            openPOs: [],
            leadTimeProvenance: "14d (Finale)",
            finaleDemandQty: 180,
            finaleConsumptionQty: 0,
            isBulkDelivery: false,
            reorderMethod: "default",
        },
        assessment: {
            vendorName: "ULINE",
            productId: "BOX-101",
            decision: "order",
            recommendedQty: 78,
            confidence: "high",
            reasonCodes: ["direct_demand_support"],
            explanation: "Current demand and supply position support placing a reorder now.",
            metrics: {
                directDemand: 2,
                bomDemand: 0,
                sharedDemand: 2,
                stockOnHand: 10,
                stockOnOrder: 0,
                adjustedRunwayDays: 5,
                finishedGoodsCoverageDays: null,
                leadTimeDays: 14,
            },
        },
    };

    return {
        ...base,
        ...overrides,
        item: { ...base.item, ...(overrides.item ?? {}) },
        candidate: { ...base.candidate, ...(overrides.candidate ?? {}) },
        assessment: { ...base.assessment, ...(overrides.assessment ?? {}) },
    };
}

describe("assessPOCommitGuard", () => {
    it("allows autonomous commit when the recommended quantity covers lead time plus 30 days", () => {
        const guard = assessPOCommitGuard(line());

        expect(guard.decision).toBe("commit");
        expect(guard.targetCoverDays).toBe(44);
        expect(guard.minimumPostLeadCoverageDays).toBe(30);
        expect(guard.projectedPostReceiptCoverageDays).toBe(30);
        expect(guard.blockReasons).toEqual([]);
    });

    it("downgrades to draft only when the quantity does not leave 30 days after lead time", () => {
        const guard = assessPOCommitGuard(line({
            item: { suggestedQty: 50 },
            candidate: { suggestedQty: 50 },
            assessment: { recommendedQty: 50 },
        }));

        expect(guard.decision).toBe("draft_only");
        expect(guard.blockReasons).toContain("recommended_qty_below_lead_plus_30");
        expect(guard.projectedPostReceiptCoverageDays).toBe(16);
    });

    it("blocks autonomous commit for low confidence assessments", () => {
        const guard = assessPOCommitGuard(line({
            assessment: { confidence: "low" },
        }));

        expect(guard.decision).toBe("draft_only");
        expect(guard.blockReasons).toContain("confidence_below_high");
    });

    it("blocks autonomous commit when the recommendation itself is not actionable", () => {
        const guard = assessPOCommitGuard(line({
            assessment: {
                decision: "manual_review",
                recommendedQty: 150,
                confidence: "medium",
                reasonCodes: ["pack_size_forced_overbuy"],
            },
        }));

        expect(guard.decision).toBe("block");
        expect(guard.blockReasons).toContain("assessment_not_order");
    });
});

describe("assessPOCommitGuardsForLines", () => {
    it("summarizes commit-ready and manual-review lines", () => {
        const result = assessPOCommitGuardsForLines([
            line(),
            line({
                item: { productId: "BOX-102", suggestedQty: 40 },
                candidate: { productId: "BOX-102", suggestedQty: 40 },
                assessment: { productId: "BOX-102", recommendedQty: 40 },
            }),
        ]);

        expect(result.commitReadyLines.map(entry => entry.line.item.productId)).toEqual(["BOX-101"]);
        expect(result.manualLines.map(entry => entry.line.item.productId)).toEqual(["BOX-102"]);
        expect(result.hasBlocks).toBe(false);
    });
});
