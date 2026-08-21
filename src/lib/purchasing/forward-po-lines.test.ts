/**
 * @file    forward-po-lines.test.ts
 * @purpose Window-aware draft line selection.
 * @author  Hermia
 * @created 2026-08-14
 */
import { describe, expect, it } from "vitest";
import { applyTruckQty, selectForwardPoLines } from "./forward-po-lines";

const today = {
    productId: "SMT105",
    suggestedQty: 5,
    unitPrice: 10,
    leadTimeDays: 14,
    runwayDays: 0,
    adjustedRunwayDays: 0,
    urgency: "critical" as const,
    assessment: { decision: "order" as const, recommendedQty: 5 },
};

const later = {
    productId: "S-4122",
    suggestedQty: 500,
    unitPrice: 1,
    leadTimeDays: 7,
    runwayDays: 32,
    adjustedRunwayDays: 32,
    urgency: "warning" as const,
    assessment: { decision: "order" as const, recommendedQty: 500 },
};

describe("selectForwardPoLines", () => {
    it("includes the visible 60d window, not just TODAY", () => {
        const lines = selectForwardPoLines({ items: [today, later], focus: "60" });
        expect(lines.map(l => l.productId).sort()).toEqual(["S-4122", "SMT105"]);
    });

    it("keeps TODAY tight", () => {
        const lines = selectForwardPoLines({ items: [today, later], focus: "order_now" });
        expect(lines.map(l => l.productId)).toEqual(["SMT105"]);
    });

    it("uses qty overrides", () => {
        const lines = selectForwardPoLines({
            items: [today],
            focus: "order_now",
            qtyOverrides: { SMT105: 12 },
        });
        expect(lines[0]?.quantity).toBe(12);
    });

    it("prefers checked rows when any are checked", () => {
        const lines = selectForwardPoLines({
            items: [today, later],
            focus: "90",
            checked: { "S-4122": true },
        });
        expect(lines.map(l => l.productId)).toEqual(["S-4122"]);
    });

    it("skips covered and draft rows", () => {
        const lines = selectForwardPoLines({
            items: [
                { ...today, draftPO: { orderId: "1" } },
                { ...later, productId: "HOLD1" },
            ],
            focus: "90",
            isCovered: item => item.productId === "HOLD1",
        });
        expect(lines).toEqual([]);
    });
});

describe("applyTruckQty", () => {
    it("sizes a single-SKU draft to the truck", () => {
        const out = applyTruckQty([{
            productId: "RAWWORMCASTINGS",
            quantity: 100,
            unitPrice: 1,
            orderIncrementQty: null,
            isBulkDelivery: true,
            leadTimeDays: 15,
        }], 42000);
        expect(out[0].quantity).toBe(42000);
    });

    it("does not smash multi-SKU drafts", () => {
        const lines = [
            { productId: "A", quantity: 1, unitPrice: 1, orderIncrementQty: null, isBulkDelivery: false, leadTimeDays: 7 },
            { productId: "B", quantity: 2, unitPrice: 1, orderIncrementQty: null, isBulkDelivery: false, leadTimeDays: 7 },
        ];
        expect(applyTruckQty(lines, 999).map(l => l.quantity)).toEqual([1, 2]);
    });
});
