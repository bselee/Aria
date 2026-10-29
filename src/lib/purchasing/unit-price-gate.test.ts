/**
 * @file    src/lib/purchasing/unit-price-gate.test.ts
 * @purpose Pin the `unit_price_missing` gate: a reorder about to be committed
 *          must have a usable supplier unit price. `finale/purchasing.ts` emits
 *          `unitPrice: 0` when a supplier has no stored price, and an auto-draft
 *          built on $0 would price a PO at zero. The engine must flip such a
 *          candidate to `manual_review` (never `order`), while leaving
 *          genuinely held / legitimately priced candidates untouched.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    policy-engine
 */
import { describe, expect, it } from "vitest";

import { assessPurchasingCandidate } from "./policy-engine";
import type { PurchasingCandidateInput } from "./policy-engine";

/** A candidate the engine would otherwise ORDER: runway below lead. */
function orderBoundInput(unitPrice: number): PurchasingCandidateInput {
    return {
        vendorName: "Clarke",
        productId: "WDG101",
        directDemand: 1.0,
        bomDemand: 0,
        stockOnHand: 1,
        stockOnOrder: 0,
        adjustedRunwayDays: 5,
        finishedGoodsCoverageDays: null,
        leadTimeDays: 21,
        suggestedQty: 20,
        orderIncrementQty: 1,
        minimumOrderQty: null,
        minimumOrderValue: null,
        unitPrice,
    };
}

describe("unit_price_missing gate", () => {
    it("flips a would-be order to manual_review when unitPrice is 0", () => {
        const a = assessPurchasingCandidate(orderBoundInput(0));
        expect(a.decision).toBe("manual_review");
        expect(a.reasonCodes).toContain("unit_price_missing");
        expect(a.recommendedQty).toBeGreaterThan(0);
        expect(a.explanation).toContain("unit price");
    });

    it("flips a would-be order to manual_review when unitPrice is NaN", () => {
        const a = assessPurchasingCandidate(orderBoundInput(Number.NaN));
        expect(a.decision).toBe("manual_review");
        expect(a.reasonCodes).toContain("unit_price_missing");
    });

    it("still orders when a real price is present", () => {
        const a = assessPurchasingCandidate(orderBoundInput(10));
        expect(a.decision).toBe("order");
        expect(a.reasonCodes).not.toContain("unit_price_missing");
    });

    it("does not mislabel a held item with a missing price", () => {
        const held = assessPurchasingCandidate({
            ...orderBoundInput(0),
            adjustedRunwayDays: 200, // healthy runway -> hold, never reaches the gate
        });
        expect(held.decision).toBe("hold");
        expect(held.reasonCodes).not.toContain("unit_price_missing");
    });
});
