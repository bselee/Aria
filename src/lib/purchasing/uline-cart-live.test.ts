import { describe, expect, it, vi } from "vitest";

import { syncVerifiedUlineCartPricesToDraftPO } from "./uline-cart-live";

describe("syncVerifiedUlineCartPricesToDraftPO", () => {
    it("writes back only verified normalized price changes", async () => {
        const finale = {
            updateOrderItemPrice: vi.fn().mockResolvedValue(undefined),
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
        expect(finale.updateOrderItemPrice).toHaveBeenCalledWith("124554", "S-3902", 0.046);
    });

    it("does nothing when there is no bound draft PO", async () => {
        const finale = {
            updateOrderItemPrice: vi.fn().mockResolvedValue(undefined),
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
        expect(finale.updateOrderItemPrice).not.toHaveBeenCalled();
    });
});
