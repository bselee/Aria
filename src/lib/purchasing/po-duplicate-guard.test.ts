/**
 * @file    po-duplicate-guard.test.ts
 * @purpose Unit tests for open/draft PO re-order failsafe
 * @author  Hermia
 * @created 2026-07-10
 */
import { describe, expect, it } from "vitest";
import { evaluateOpenPoDuplicateGuard } from "./po-duplicate-guard";

describe("evaluateOpenPoDuplicateGuard", () => {
    it("blocks when open PO qty covers requested qty", () => {
        const result = evaluateOpenPoDuplicateGuard([
            {
                productId: "OAG110LABELBACK",
                quantity: 250,
                openPOs: [{ orderId: "125056", quantity: 500 }],
            },
        ]);
        expect(result.ok).toBe(false);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].kind).toBe("open_po");
        expect(result.blocks[0].coveringOrderId).toBe("125056");
        expect(result.allowedProductIds).toEqual([]);
    });

    it("allows residual top-up when open qty is less than requested", () => {
        const result = evaluateOpenPoDuplicateGuard([
            {
                productId: "SKU-1",
                quantity: 100,
                openPOs: [{ orderId: "1", quantity: 40 }],
            },
        ]);
        expect(result.ok).toBe(true);
        expect(result.allowedProductIds).toEqual(["SKU-1"]);
        expect(result.blocks).toHaveLength(0);
    });

    it("blocks draft PO coverage", () => {
        const result = evaluateOpenPoDuplicateGuard([
            {
                productId: "SKU-2",
                quantity: 50,
                draftPO: { orderId: "124900", quantity: 50 },
            },
        ]);
        expect(result.ok).toBe(false);
        expect(result.blocks[0].kind).toBe("draft_po");
    });

    it("forceTopUp overrides blocks but reports them", () => {
        const result = evaluateOpenPoDuplicateGuard(
            [{
                productId: "OAG110LABELBACK",
                quantity: 250,
                openPOs: [{ orderId: "125056", quantity: 500 }],
            }],
            { forceTopUp: true },
        );
        expect(result.ok).toBe(true);
        expect(result.blocks).toHaveLength(1);
        expect(result.summary).toMatch(/forceTopUp/i);
    });

    it("mixed basket: only covered SKUs block", () => {
        const result = evaluateOpenPoDuplicateGuard([
            {
                productId: "COVERED",
                quantity: 10,
                openPOs: [{ orderId: "9", quantity: 10 }],
            },
            {
                productId: "NEED",
                quantity: 5,
                openPOs: [],
            },
        ]);
        expect(result.ok).toBe(false);
        expect(result.allowedProductIds).toEqual(["NEED"]);
        expect(result.blocks.map(b => b.productId)).toEqual(["COVERED"]);
    });
});

// coverageStockOnOrder is demand-side; tested alongside failsafe in this suite for locality
import { coverageStockOnOrder } from "./po-reliability-scorer";

describe("coverageStockOnOrder", () => {
    it("credits full Finale open PO qty even when enriched marks stuck", () => {
        const open = [{ quantity: 500 }];
        const enriched = [{
            orderId: "125056",
            quantity: 500,
            orderDate: "2026-07-02",
            isDeliverable: false,
            stuckReason: "no_record" as const,
            ageDays: 8,
        }];
        expect(coverageStockOnOrder(open, enriched)).toBe(500);
    });

    it("returns 0 when no open POs", () => {
        expect(coverageStockOnOrder([], [])).toBe(0);
    });
});
