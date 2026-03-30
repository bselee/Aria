import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    buildPlanMock,
    launchSessionMock,
    openCartMock,
    populateCartMock,
    verifyCartMock,
} = vi.hoisted(() => ({
    buildPlanMock: vi.fn(),
    launchSessionMock: vi.fn(),
    openCartMock: vi.fn(),
    populateCartMock: vi.fn(),
    verifyCartMock: vi.fn(),
}));

vi.mock("@/lib/purchasing/sustainable-village-ordering", () => ({
    buildSustainableVillageCartPlan: buildPlanMock,
}));

vi.mock("@/lib/purchasing/sustainable-village-session", () => ({
    launchSustainableVillageSession: launchSessionMock,
    openSustainableVillageStorefrontCart: openCartMock,
}));

vi.mock("@/lib/purchasing/sustainable-village-cart-live", () => ({
    populateSustainableVillageCart: populateCartMock,
    verifySustainableVillageCart: verifyCartMock,
}));

import { POST } from "./route";

describe("dashboard sustainable village order route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        const page = {};
        const context = {
            pages: vi.fn().mockReturnValue([page]),
            newPage: vi.fn().mockResolvedValue(page),
        };

        launchSessionMock.mockResolvedValue({
            context,
            close: vi.fn().mockResolvedValue(undefined),
        });
        openCartMock.mockResolvedValue(undefined);
        buildPlanMock.mockReturnValue({
            status: "ready",
            lines: [{
                productId: "SV-VALVE",
                variantId: "gid://shopify/ProductVariant/12345",
                quantity: 3,
                unitPrice: 12.99,
                productUrl: "https://sustainablevillage.com/products/valve",
                title: "Valve 3mm",
            }],
            missingMappings: [],
        });
        populateCartMock.mockResolvedValue([{
            productId: "SV-VALVE",
            variantId: "12345",
            quantity: 3,
            unitPrice: 12.99,
            lineTotal: 38.97,
            title: "Valve 3mm",
        }]);
        verifyCartMock.mockReturnValue({
            status: "verified",
            missingProducts: [],
            quantityMismatches: [],
            priceMismatches: [],
        });
    });

    it("fills and verifies the Sustainable Village cart when the plan is ready", async () => {
        const response = await POST(
            new Request("http://localhost/api/dashboard/purchasing/sustainable-village-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: [{ productId: "SV-VALVE", quantity: 3, unitPrice: 12.99 }],
                    mappings: {
                        "SV-VALVE": {
                            variantId: "gid://shopify/ProductVariant/12345",
                            productUrl: "https://sustainablevillage.com/products/valve",
                            title: "Valve 3mm",
                        },
                    },
                }),
            }) as any,
        );

        expect(response.status).toBe(200);
        expect(launchSessionMock).toHaveBeenCalledWith({ headless: true });
        expect(openCartMock).toHaveBeenCalled();
        expect(populateCartMock).toHaveBeenCalledWith(expect.anything(), expect.any(Array));
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            itemsAdded: 1,
        });
    });

    it("returns a review-needed result when cart verification fails", async () => {
        verifyCartMock.mockReturnValue({
            status: "manual_review",
            missingProducts: [],
            quantityMismatches: [],
            priceMismatches: ["SV-VALVE"],
        });

        const response = await POST(
            new Request("http://localhost/api/dashboard/purchasing/sustainable-village-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: [{ productId: "SV-VALVE", quantity: 3, unitPrice: 12.99 }],
                    mappings: {
                        "SV-VALVE": {
                            variantId: "gid://shopify/ProductVariant/12345",
                            productUrl: "https://sustainablevillage.com/products/valve",
                            title: "Valve 3mm",
                        },
                    },
                }),
            }) as any,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            itemsAdded: 0,
        });
    });
});
