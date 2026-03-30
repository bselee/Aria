import { describe, expect, it, vi } from "vitest";

import {
    populateSustainableVillageCart,
    toSustainableVillageVariantId,
    verifySustainableVillageCart,
} from "./sustainable-village-cart-live";

describe("toSustainableVillageVariantId", () => {
    it("extracts the numeric Shopify variant id from gid values", () => {
        expect(toSustainableVillageVariantId("gid://shopify/ProductVariant/12345")).toBe(12345);
        expect(toSustainableVillageVariantId("67890")).toBe(67890);
    });
});

describe("populateSustainableVillageCart", () => {
    it("posts normalized Shopify cart items and returns observed cart lines", async () => {
        const page = {
            evaluate: vi.fn().mockResolvedValue({
                items: [
                    {
                        variant_id: 12345,
                        quantity: 3,
                        price: 1299,
                        final_line_price: 3897,
                        product_title: "Valve 3mm",
                    },
                ],
            }),
        };

        const observed = await populateSustainableVillageCart(page as any, [
            {
                productId: "SV-VALVE",
                variantId: "gid://shopify/ProductVariant/12345",
                quantity: 3,
                unitPrice: 12.99,
                productUrl: "https://sustainablevillage.com/products/valve",
                title: "Valve 3mm",
            },
        ]);

        expect(page.evaluate).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                clearFirst: true,
                items: [{ id: 12345, quantity: 3 }],
            }),
        );
        expect(observed).toEqual([
            expect.objectContaining({
                productId: "SV-VALVE",
                variantId: "12345",
                quantity: 3,
                unitPrice: 12.99,
            }),
        ]);
    });
});

describe("verifySustainableVillageCart", () => {
    it("requires manual review when a verified cart price drifts from the draft PO", () => {
        const result = verifySustainableVillageCart([{
            productId: "SV-VALVE",
            variantId: "gid://shopify/ProductVariant/12345",
            quantity: 3,
            unitPrice: 12.99,
            productUrl: "https://sustainablevillage.com/products/valve",
            title: "Valve 3mm",
        }], [{
            productId: "SV-VALVE",
            variantId: "12345",
            quantity: 3,
            unitPrice: 13.49,
            lineTotal: 40.47,
            title: "Valve 3mm",
        }]);

        expect(result.status).toBe("manual_review");
        expect(result.priceMismatches).toEqual(["SV-VALVE"]);
    });
});
