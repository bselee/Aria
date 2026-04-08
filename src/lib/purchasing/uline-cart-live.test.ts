import { describe, expect, it, vi } from "vitest";

import {
    diffObservedUlineCartRows,
    scrapeObservedUlineCartRows,
    syncVerifiedUlineCartPricesToDraftPO,
} from "./uline-cart-live";

describe("scrapeObservedUlineCartRows", () => {
    it("derives cart quantity from line total when description contains pack text", async () => {
        const page = {
            locator: vi.fn().mockReturnValue({
                evaluateAll: vi.fn().mockResolvedValue([
                    {
                        text: "S-13505B F-Style Jugs Bulk Pack - 32 oz, White 120/case $150.00 $300.00",
                        quantityValue: "",
                    },
                ]),
            }),
        } as any;

        const rows = await scrapeObservedUlineCartRows(page);

        expect(rows).toEqual([
            {
                ulineModel: "S-13505B",
                quantity: 2,
                unitPrice: 150,
                lineTotal: 300,
            },
        ]);
    });
});

describe("diffObservedUlineCartRows", () => {
    it("correlates only the quantity added by the current PO when cart rows already exist", () => {
        const delta = diffObservedUlineCartRows(
            [
                { ulineModel: "S-13505B", quantity: 120, unitPrice: 1.4, lineTotal: 168 },
                { ulineModel: "S-1667", quantity: 50, unitPrice: 0.33, lineTotal: 16.5 },
            ],
            [
                { ulineModel: "S-13505B", quantity: 360, unitPrice: 1.4, lineTotal: 504 },
                { ulineModel: "S-1667", quantity: 509, unitPrice: 0.33, lineTotal: 167.97 },
                { ulineModel: "S-3902", quantity: 1, unitPrice: 230, lineTotal: 230 },
            ],
        );

        expect(delta).toEqual([
            { ulineModel: "S-13505B", quantity: 240, unitPrice: 1.4, lineTotal: 336 },
            { ulineModel: "S-1667", quantity: 459, unitPrice: 0.33, lineTotal: 151.47 },
            { ulineModel: "S-3902", quantity: 1, unitPrice: 230, lineTotal: 230 },
        ]);
    });
});

describe("syncVerifiedUlineCartPricesToDraftPO", () => {
    it("writes back only verified normalized price changes", async () => {
        const finale = {
            updateOrderItemQuantityAndPrice: vi.fn().mockResolvedValue(undefined),
        } as any;

        const applied = await syncVerifiedUlineCartPricesToDraftPO(
            finale,
            "124554",
            [{
                finaleSku: "S-3902",
                ulineModel: "S-3902",
                quantity: 1,
                unitPrice: 195,
                finaleUnitPrice: 0.039,
                orderUnitEaches: 5000,
            }],
            [{
                ulineModel: "S-3902",
                quantity: 1,
                unitPrice: 230,
                lineTotal: 230,
            }],
            {
                status: "verified",
                matchedModels: ["S-3902"],
                missingModels: [],
                quantityMismatches: [],
                unexpectedModels: [],
            },
        );

        expect(applied).toBe(1);
        expect(finale.updateOrderItemQuantityAndPrice).toHaveBeenCalledWith("124554", "S-3902", 5000, 0.046);
    });

    it("does nothing when there is no bound draft PO", async () => {
        const finale = {
            updateOrderItemQuantityAndPrice: vi.fn().mockResolvedValue(undefined),
        } as any;

        const applied = await syncVerifiedUlineCartPricesToDraftPO(
            finale,
            null,
            [],
            [],
            {
                status: "verified",
                matchedModels: [],
                missingModels: [],
                quantityMismatches: [],
                unexpectedModels: [],
            },
        );

        expect(applied).toBe(0);
        expect(finale.updateOrderItemQuantityAndPrice).not.toHaveBeenCalled();
    });

    it("writes back cart-normalized Finale each quantities when ULINE rounds to a case", async () => {
        const finale = {
            updateOrderItemQuantityAndPrice: vi.fn().mockResolvedValue(undefined),
        } as any;

        const applied = await syncVerifiedUlineCartPricesToDraftPO(
            finale,
            "124554",
            [{
                finaleSku: "S-1667",
                ulineModel: "S-1667",
                quantity: 459,
                effectiveEachQuantity: 459,
                unitPrice: 0.328,
                finaleUnitPrice: 0.328,
                orderUnitEaches: 500,
            }],
            [{
                ulineModel: "S-1667",
                quantity: 1,
                unitPrice: 164,
                lineTotal: 164,
            }],
            {
                status: "partial",
                matchedModels: [],
                missingModels: [],
                quantityMismatches: [{
                    ulineModel: "S-1667",
                    expectedQuantity: 459,
                    observedQuantity: 1,
                }],
                unexpectedModels: [],
            },
        );

        expect(applied).toBe(1);
        expect(finale.updateOrderItemQuantityAndPrice).toHaveBeenCalledWith("124554", "S-1667", 500, 0.328);
    });
});
