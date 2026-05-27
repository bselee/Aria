import { describe, it, expect } from "vitest";
import { applySmartMOQTopUp } from "./moq-topup";

describe("applySmartMOQTopUp", () => {
    it("does nothing if the MOQ requirements are already satisfied", () => {
        const items = [
            {
                productId: "A",
                productName: "Product A",
                suggestedQty: 10,
                unitPrice: 100,
                orderIncrementQty: 5,
                dailyRate: 1,
                stockOnHand: 10,
                stockOnOrder: 0,
                adjustedRunwayDays: 10,
                urgency: "critical",
            },
        ];

        const moq = {
            minimumOrderDollars: 1000,
            minimumOrderEaches: 10,
        };

        const result = applySmartMOQTopUp(items, moq);
        expect(result[0].suggestedQty).toBe(10);
        expect(result[0].topUpQty).toBe(0);
    });

    it("tops up the item with the lowest runway days to meet dollar MOQ", () => {
        const items = [
            {
                productId: "A", // warning (lower runway)
                productName: "Product A",
                suggestedQty: 5,
                unitPrice: 10,
                orderIncrementQty: 5,
                dailyRate: 1,
                stockOnHand: 10,
                stockOnOrder: 0,
                adjustedRunwayDays: 10,
                urgency: "warning",
            },
            {
                productId: "B", // watch (higher runway)
                productName: "Product B",
                suggestedQty: 0,
                unitPrice: 10,
                orderIncrementQty: 10,
                dailyRate: 0.5,
                stockOnHand: 20,
                stockOnOrder: 0,
                adjustedRunwayDays: 40,
                urgency: "watch",
            },
        ];

        const moq = {
            minimumOrderDollars: 200, // current is 5 * 10 = $50. Need $150 more
            minimumOrderEaches: 0,
        };

        // $150 more / $10 price = 15 eaches.
        // Product A has lower runway (10 vs 40), so top-up should prioritize A first.
        // Product A pack increment is 5, so we add 5-packs.
        // Loop adds to A. We'll add 15 more to A (since daily rate cap permits or it meets MOQ).
        const result = applySmartMOQTopUp(items, moq);

        const resA = result.find(r => r.productId === "A");
        const resB = result.find(r => r.productId === "B");

        expect(resA?.suggestedQty).toBe(20); // 5 + 15 = 20
        expect(resA?.topUpQty).toBe(15);
        expect(resB?.suggestedQty).toBe(0);
    });

    it("respects the maximum cover days safety cap", () => {
        const items = [
            {
                productId: "A",
                productName: "Product A",
                suggestedQty: 5,
                unitPrice: 10,
                orderIncrementQty: 5,
                dailyRate: 1,
                stockOnHand: 10,
                stockOnOrder: 0,
                adjustedRunwayDays: 10,
                urgency: "warning",
            },
        ];

        const moq = {
            minimumOrderDollars: 1000, // Needs huge top-up ($950 more)
            minimumOrderEaches: 0,
        };

        // Limit to max cover days of 30.
        // For Product A, stock (10) + current (5) + increment (5) = 20 total.
        // 20 total / 1/day = 20 cover days.
        // The next increment would push to 25. Next to 30.
        // Thus, suggestedQty can only be bumped to 15 (making total 25).
        // 15 suggestedQty * $10 = $150, which doesn't meet MOQ, but it stops to satisfy guardrails.
        const result = applySmartMOQTopUp(items, moq, 25);

        const resA = result.find(r => r.productId === "A");
        expect(resA?.suggestedQty).toBe(15); // stock 10 + suggested 15 = 25 days supply max.
    });
});
