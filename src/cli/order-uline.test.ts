import { describe, expect, it, vi } from "vitest";

const { convertMock } = vi.hoisted(() => ({
    convertMock: vi.fn(),
}));

vi.mock("../lib/purchasing/uline-ordering", () => ({
    convertFinaleItemToUlineOrder: convertMock,
    toUlineModel: vi.fn((sku: string) => sku),
}));

import { createFinaleDraftPO, gatherAutoReorderItems, runFridayUlinePreCheck } from "./order-uline";

describe("gatherAutoReorderItems", () => {
    it("uses vendor-scoped Finale intelligence for ULINE", async () => {
        convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice, description }: any) => ({
            finaleSku,
            ulineModel: finaleSku,
            quantity: finaleEachQuantity,
            unitPrice: finaleUnitPrice,
            description,
            effectiveEachQuantity: finaleEachQuantity,
            guardrailWarnings: [],
        }));

        const finale = {
            getPurchasingIntelligence: vi.fn().mockResolvedValue([
                {
                    vendorName: "ULINE",
                    vendorPartyId: "party-1",
                    urgency: "critical",
                    items: [
                        {
                            productId: "H-4987",
                            productName: "Gription Cut Resistant Gloves",
                            supplierName: "ULINE",
                            supplierPartyId: "party-1",
                            unitPrice: 8.5,
                            stockOnHand: 2,
                            stockOnOrder: 0,
                            purchaseVelocity: 0,
                            salesVelocity: 0.3,
                            demandVelocity: 0.3,
                            dailyRate: 0.3,
                            runwayDays: 6,
                            adjustedRunwayDays: 6,
                            leadTimeDays: 14,
                            leadTimeProvenance: "14d (Finale)",
                            openPOs: [],
                            urgency: "critical",
                            explanation: "Need reorder now.",
                            suggestedQty: 4,
                            orderIncrementQty: 1,
                            isBulkDelivery: false,
                            finaleReorderQty: 4,
                            finaleStockoutDays: 6,
                            finaleConsumptionQty: 0,
                            finaleDemandQty: 27,
                            reorderMethod: "demand_velocity",
                        },
                    ],
                },
            ]),
        } as any;

        const manifest = await gatherAutoReorderItems(finale);

        expect(finale.getPurchasingIntelligence).toHaveBeenCalledWith(365, "ULINE");
        expect(manifest.items).toHaveLength(1);
        expect(manifest.items[0]).toMatchObject({
            finaleSku: "H-4987",
            quantity: 4,
        });
    });
});

describe("createFinaleDraftPO", () => {
    it("creates the Finale draft using effective vendor-order quantity", async () => {
        convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice, description }: any) => ({
            finaleSku,
            ulineModel: finaleSku,
            quantity: finaleEachQuantity,
            unitPrice: finaleUnitPrice,
            description,
            finaleEachQuantity,
            finaleUnitPrice,
            effectiveEachQuantity: finaleEachQuantity,
            orderUnitEaches: 1,
            quantityStep: 1,
            guardrailWarnings: [],
        }));

        const finale = {
            findVendorPartyByName: vi.fn().mockResolvedValue("party-uline"),
            findActiveDraftPOsForVendor: vi.fn().mockResolvedValue([]),
            findRecentPurchaseOrdersForVendor: vi.fn().mockResolvedValue([]),
            createDraftPurchaseOrder: vi.fn().mockResolvedValue({
                orderId: "124600",
                finaleUrl: "https://example.com/po/124600",
                duplicateWarnings: [],
                priceAlerts: [],
            }),
            getOrderDetails: vi.fn().mockResolvedValue({
                orderId: "124600",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    {
                        productId: "FJG102",
                        quantity: 240,
                        unitPrice: 1.25,
                        itemDescription: "F-Style jug 32 oz",
                    },
                ],
            }),
        } as any;

        const manifest = {
            sourceType: "auto_reorder" as const,
            sourcePO: null,
            totalEstimate: 300,
            items: [
                {
                    finaleSku: "FJG102",
                    ulineModel: "S-13505B",
                    quantity: 240,
                    unitPrice: 1.25,
                    description: "F-Style jug 32 oz",
                    finaleEachQuantity: 155,
                    finaleUnitPrice: 1.25,
                    effectiveEachQuantity: 240,
                    orderUnitEaches: 1,
                    quantityStep: 120,
                    guardrailWarnings: [],
                },
            ],
        };

        await createFinaleDraftPO(finale, manifest);

        expect(finale.createDraftPurchaseOrder).toHaveBeenCalledWith(
            "party-uline",
            [
                {
                    productId: "FJG102",
                    quantity: 240,
                    unitPrice: 1.25,
                },
            ],
            expect.stringContaining("Auto-reorder generated"),
        );
        expect(finale.getOrderDetails).toHaveBeenCalledWith("124600");
    });

    it("rebuilds the manifest from the saved PO so cart fill matches a reused draft", async () => {
        convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice, description }: any) => ({
            finaleSku,
            ulineModel: finaleSku,
            quantity: finaleEachQuantity,
            unitPrice: finaleUnitPrice,
            description,
            finaleEachQuantity,
            finaleUnitPrice,
            effectiveEachQuantity: finaleEachQuantity,
            orderUnitEaches: 1,
            quantityStep: 1,
            guardrailWarnings: [],
        }));

        const finale = {
            findVendorPartyByName: vi.fn().mockResolvedValue("party-uline"),
            findActiveDraftPOsForVendor: vi.fn().mockResolvedValue([
                { orderId: "124500", orderDate: "2026-04-11", finaleUrl: "https://finale/124500" },
            ]),
            findRecentPurchaseOrdersForVendor: vi.fn().mockResolvedValue([]),
            createDraftPurchaseOrder: vi.fn().mockResolvedValue({
                orderId: "124500",
                finaleUrl: "https://example.com/po/124500",
                duplicateWarnings: ["Reused existing draft PO #124500 for this vendor."],
                priceAlerts: [],
            }),
            getOrderDetails: vi.fn().mockResolvedValue({
                orderId: "124500",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    {
                        productId: "EXISTING-1",
                        quantity: 5,
                        unitPrice: 3,
                        itemDescription: "Existing line",
                    },
                    {
                        productId: "FJG102",
                        quantity: 240,
                        unitPrice: 1.25,
                        itemDescription: "F-Style jug 32 oz",
                    },
                ],
            }),
        } as any;

        const manifest = {
            sourceType: "auto_reorder" as const,
            sourcePO: null,
            totalEstimate: 300,
            items: [
                {
                    finaleSku: "FJG102",
                    ulineModel: "S-13505B",
                    quantity: 240,
                    unitPrice: 1.25,
                    description: "F-Style jug 32 oz",
                    finaleEachQuantity: 155,
                    finaleUnitPrice: 1.25,
                    effectiveEachQuantity: 240,
                    orderUnitEaches: 1,
                    quantityStep: 120,
                    guardrailWarnings: [],
                },
            ],
        };

        const result = await createFinaleDraftPO(finale, manifest);

        expect(result.sourcePO).toBe("124500");
        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.finaleSku)).toEqual(["EXISTING-1", "FJG102"]);
    });

    it("refuses to create a new ULINE draft when only a committed PO exists", async () => {
        convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice, description }: any) => ({
            finaleSku,
            ulineModel: finaleSku,
            quantity: finaleEachQuantity,
            unitPrice: finaleUnitPrice,
            description,
            finaleEachQuantity,
            finaleUnitPrice,
            effectiveEachQuantity: finaleEachQuantity,
            orderUnitEaches: 1,
            quantityStep: 1,
            guardrailWarnings: [],
        }));

        const finale = {
            findVendorPartyByName: vi.fn().mockResolvedValue("party-uline"),
            findActiveDraftPOsForVendor: vi.fn().mockResolvedValue([]),
            findRecentPurchaseOrdersForVendor: vi.fn().mockResolvedValue([
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ]),
            createDraftPurchaseOrder: vi.fn(),
        } as any;

        const manifest = {
            sourceType: "auto_reorder" as const,
            sourcePO: null,
            totalEstimate: 300,
            items: [
                {
                    finaleSku: "FJG102",
                    ulineModel: "S-13505B",
                    quantity: 240,
                    unitPrice: 1.25,
                    description: "F-Style jug 32 oz",
                    finaleEachQuantity: 155,
                    finaleUnitPrice: 1.25,
                    effectiveEachQuantity: 240,
                    orderUnitEaches: 1,
                    quantityStep: 120,
                    guardrailWarnings: [],
                },
            ],
        };

        await expect(createFinaleDraftPO(finale, manifest)).rejects.toThrow(/Committed/i);
        expect(finale.createDraftPurchaseOrder).not.toHaveBeenCalled();
    });
});

describe("runFridayUlinePreCheck", () => {
    it("requires review instead of creating a new order when only a committed ULINE PO exists", async () => {
        convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice, description }: any) => ({
            finaleSku,
            ulineModel: finaleSku,
            quantity: finaleEachQuantity,
            unitPrice: finaleUnitPrice,
            description,
            finaleEachQuantity,
            finaleUnitPrice,
            effectiveEachQuantity: finaleEachQuantity,
            orderUnitEaches: 1,
            quantityStep: 1,
            guardrailWarnings: [],
        }));

        const finale = {
            getPurchasingIntelligence: vi.fn().mockResolvedValue([
                {
                    vendorName: "ULINE",
                    vendorPartyId: "party-uline",
                    urgency: "critical",
                    items: [
                        {
                            productId: "H-4987",
                            productName: "Gription Cut Resistant Gloves",
                            supplierName: "ULINE",
                            supplierPartyId: "party-uline",
                            unitPrice: 8.5,
                            stockOnHand: 2,
                            stockOnOrder: 0,
                            purchaseVelocity: 0,
                            salesVelocity: 0.3,
                            demandVelocity: 0.3,
                            dailyRate: 0.3,
                            runwayDays: 6,
                            adjustedRunwayDays: 6,
                            leadTimeDays: 14,
                            leadTimeProvenance: "14d (Finale)",
                            openPOs: [],
                            urgency: "critical",
                            explanation: "Need reorder now.",
                            suggestedQty: 4,
                            orderIncrementQty: 1,
                            isBulkDelivery: false,
                            finaleReorderQty: 4,
                            finaleStockoutDays: 6,
                            finaleConsumptionQty: 0,
                            finaleDemandQty: 27,
                            reorderMethod: "demand_velocity",
                        },
                    ],
                },
            ]),
            findVendorPartyByName: vi.fn().mockResolvedValue("party-uline"),
            findActiveDraftPOsForVendor: vi.fn().mockResolvedValue([]),
            findRecentPurchaseOrdersForVendor: vi.fn().mockResolvedValue([
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ]),
        } as any;

        const preCheck = await runFridayUlinePreCheck(finale);

        expect(preCheck.reason).toBe("review_required");
        expect(preCheck.needsOrder).toBe(false);
    });
});
