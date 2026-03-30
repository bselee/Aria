import { describe, expect, it } from "vitest";

import { buildSustainableVillageCartPlan } from "./sustainable-village-ordering";

describe("buildSustainableVillageCartPlan", () => {
    it("builds a ready cart plan when all items have product mappings", () => {
        const plan = buildSustainableVillageCartPlan([
            {
                productId: "SV-VALVE",
                quantity: 120,
                unitPrice: 0.32,
            },
        ], {
            "SV-VALVE": {
                variantId: "gid://shopify/ProductVariant/123",
                productUrl: "https://sustainablevillage.com/products/valve",
                title: "Valve 3mm",
            },
        });

        expect(plan.status).toBe("ready");
        expect(plan.lines).toEqual([
            expect.objectContaining({
                productId: "SV-VALVE",
                variantId: "gid://shopify/ProductVariant/123",
                quantity: 120,
            }),
        ]);
    });

    it("forces manual review when a mapping is missing", () => {
        const plan = buildSustainableVillageCartPlan([
            {
                productId: "SV-MISSING",
                quantity: 40,
                unitPrice: 1.15,
            },
        ], {});

        expect(plan.status).toBe("manual_review");
        expect(plan.missingMappings).toEqual(["SV-MISSING"]);
        expect(plan.lines).toHaveLength(0);
    });
});
