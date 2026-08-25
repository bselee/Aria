/**
 * @file    src/lib/purchasing/vendor-sku-bundle.test.ts
 * @purpose Vendor SKU correlation: preempt near-term drips, skip Amazon and tiny eaches.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest
 */

import { describe, expect, it } from "vitest";
import {
    bundleVendorDraftLines,
    capBundledLines,
    isAmazonVendor,
} from "./vendor-sku-bundle";

const glp102 = {
    productId: "GLP102",
    unitPrice: 4,
    suggestedQty: 18,
    dailyRate: 0.69,
    adjustedRunwayDays: 47,
    stockOnOrder: 0,
    assessment: { decision: "order", recommendedQty: 18 },
};

const glp113 = {
    productId: "GLP113",
    unitPrice: 4,
    suggestedQty: 0,
    dailyRate: 1,
    adjustedRunwayDays: 55,
    stockOnOrder: 0,
    assessment: { decision: "hold", recommendedQty: 0, reasonCodes: ["runway_healthy"] },
};

const glb205 = {
    productId: "GLB205",
    unitPrice: 8,
    suggestedQty: 0,
    dailyRate: 0.08,
    adjustedRunwayDays: 62,
    stockOnOrder: 0,
    assessment: { decision: "hold", recommendedQty: 0, reasonCodes: ["runway_healthy"] },
};

const glp115 = {
    productId: "GLP115",
    unitPrice: 4,
    dailyRate: 1.4,
    adjustedRunwayDays: 131,
    stockOnOrder: 0,
    assessment: { decision: "hold", recommendedQty: 0, reasonCodes: ["runway_healthy"] },
};

const onOrder = {
    productId: "GLP116",
    unitPrice: 4,
    dailyRate: 4,
    adjustedRunwayDays: 63,
    stockOnOrder: 150,
    assessment: { decision: "hold", recommendedQty: 0, reasonCodes: ["on_order_already_covers_need"] },
};

describe("isAmazonVendor", () => {
    it("skips Amazon, not Amazonian-looking names", () => {
        expect(isAmazonVendor("Amazon")).toBe(true);
        expect(isAmazonVendor("Amazon.com")).toBe(true);
        expect(isAmazonVendor("Grassroots Fabric Pots")).toBe(false);
    });
});

describe("bundleVendorDraftLines", () => {
    it("adds 55d Grassroots drips and skips tiny / far / already-on-order", () => {
        const out = bundleVendorDraftLines({
            vendorName: "Grassroots Fabric Pots",
            allItems: [glp102, glp113, glb205, glp115, onOrder],
            selected: [{
                productId: "GLP102",
                quantity: 18,
                unitPrice: 4,
                orderIncrementQty: null,
                isBulkDelivery: false,
            }],
        });
        const ids = out.map((l) => l.productId);
        expect(ids).toContain("GLP102");
        expect(ids).toContain("GLP113");
        expect(ids).not.toContain("GLB205");
        expect(ids).not.toContain("GLP115");
        expect(ids).not.toContain("GLP116");
        expect(out.find((l) => l.productId === "GLP113")?.preempt).toBe(true);
        expect(out.find((l) => l.productId === "GLP113")?.quantity).toBeGreaterThanOrEqual(30);
    });

    it("never bundles Amazon", () => {
        const out = bundleVendorDraftLines({
            vendorName: "Amazon",
            allItems: [glp102, glp113],
            selected: [{
                productId: "GLP102",
                quantity: 18,
                unitPrice: 4,
                orderIncrementQty: null,
                isBulkDelivery: false,
            }],
        });
        expect(out.map((l) => l.productId)).toEqual(["GLP102"]);
    });

    it("does not open a PO with no trigger line", () => {
        expect(bundleVendorDraftLines({
            vendorName: "Grassroots Fabric Pots",
            allItems: [glp113],
            selected: [],
        })).toEqual([]);
    });

    it("honors allowPreempt false (operator checked a subset)", () => {
        const out = bundleVendorDraftLines({
            vendorName: "Grassroots Fabric Pots",
            allItems: [glp102, glp113],
            selected: [{
                productId: "GLP102",
                quantity: 18,
                unitPrice: 4,
                orderIncrementQty: null,
                isBulkDelivery: false,
            }],
            allowPreempt: false,
        });
        expect(out.map((l) => l.productId)).toEqual(["GLP102"]);
    });
});

describe("capBundledLines", () => {
    it("keeps trigger lines and drops preempt over the cap", () => {
        const kept = capBundledLines([
            { productId: "A", quantity: 10, unitPrice: 100, orderIncrementQty: null, isBulkDelivery: false, preempt: false },
            { productId: "B", quantity: 10, unitPrice: 200, orderIncrementQty: null, isBulkDelivery: false, preempt: true },
        ], 1500);
        expect(kept.map((l) => l.productId)).toEqual(["A"]);
    });
});
