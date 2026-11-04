/**
 * @file    invoice-line-price-match.test.ts
 * @purpose Unit tests for the unit-price proof (invoice-line-price-match.ts):
 *          the pure helpers that identify a PO by exact unit-price overlap
 *          when an invoice carries no SKU and no printed PO number.
 * @author  Hermia
 * @created 2026-11-04
 */
import { describe, it, expect } from "vitest";
import {
    pricesMatch,
    pricedInvoiceLines,
    pricedPoLines,
    scoreUnitPriceProof,
    type UnitPricePoRow,
} from "./invoice-line-price-match";

describe("pricesMatch", () => {
    it("matches identical prices", () => {
        expect(pricesMatch(20, 20)).toBe(true);
    });

    it("is float-noise safe to the cent", () => {
        expect(pricesMatch(19.999999, 20.000001)).toBe(true);
        expect(pricesMatch(20.01, 20.0)).toBe(false);
    });

    it("rejects non-finite prices", () => {
        expect(pricesMatch(NaN, 20)).toBe(false);
        expect(pricesMatch(20, Infinity)).toBe(false);
    });
});

describe("pricedInvoiceLines", () => {
    it("reads camelCase unitPrice", () => {
        expect(pricedInvoiceLines([{ qty: 100, unitPrice: 20 }])).toEqual([
            { unitPrice: 20, qty: 100 },
        ]);
    });

    it("reads snake_case unit_price (the DB line_items column)", () => {
        expect(
            pricedInvoiceLines([{ qty: 100, unit_price: 20, description: "/ Cubic Foot" }]),
        ).toEqual([{ unitPrice: 20, qty: 100 }]);
    });

    it("drops freight/tax lines (zero or missing unit price)", () => {
        expect(
            pricedInvoiceLines([
                { qty: 100, unit_price: 20 },
                { description: "Freight", unit_price: 0 },
                { description: "Tax" },
            ]),
        ).toEqual([{ unitPrice: 20, qty: 100 }]);
    });

    it("parses a JSON-string line_items value", () => {
        expect(
            pricedInvoiceLines(JSON.stringify([{ qty: 100, unit_price: 20 }])),
        ).toEqual([{ unitPrice: 20, qty: 100 }]);
    });

    it("returns [] for null/undefined/non-array", () => {
        expect(pricedInvoiceLines(null)).toEqual([]);
        expect(pricedInvoiceLines(undefined)).toEqual([]);
        expect(pricedInvoiceLines("not json")).toEqual([]);
    });
});

describe("pricedPoLines", () => {
    it("reads unitPrice + remainingQty (Finale shape)", () => {
        expect(
            pricedPoLines([{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }]),
        ).toEqual([{ unitPrice: 20, remainingQty: 450 }]);
    });

    it("returns remainingQty null when absent (no quantity fallback)", () => {
        expect(pricedPoLines([{ quantity: "325", unitPrice: 10 }])).toEqual([
            { unitPrice: 10, remainingQty: null },
        ]);
    });

    it("parses a JSON-string line_items value", () => {
        expect(
            pricedPoLines(JSON.stringify([{ quantity: "200", unitPrice: 40, remainingQty: 200 }])),
        ).toEqual([{ unitPrice: 40, remainingQty: 200 }]);
    });
});

describe("scoreUnitPriceProof", () => {
    const coloradoWormPos: UnitPricePoRow[] = [
        {
            po_number: "125467",
            vendor_name: "Colorado Worm Company",
            issue_date: "2026-11-03",
            total_amount: 9000,
            status: "Committed",
            line_items: [{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }],
        },
        {
            po_number: "125450",
            vendor_name: "Colorado Worm Company",
            issue_date: "2026-10-28",
            total_amount: 3250,
            status: "Committed",
            line_items: [{ quantity: "325", productId: "COWOCO1", unitPrice: 10, remainingQty: 325 }],
        },
        {
            po_number: "125441",
            vendor_name: "Colorado Worm Company",
            issue_date: "2026-10-15",
            total_amount: 8000,
            status: "Committed",
            line_items: [{ quantity: "200", productId: "COWOCO3", unitPrice: 40, remainingQty: 200 }],
        },
    ];

    it("uniquely identifies the $20 PO for a 100 x $20 invoice (Colorado Worm 19500)", () => {
        const hits = scoreUnitPriceProof(
            [{ qty: 100, unit_price: 20 }],
            coloradoWormPos,
        );
        expect(hits).toHaveLength(1);
        expect(hits[0].poNumber).toBe("125467");
        expect(hits[0].matchedUnitPrices).toEqual([20]);
        expect(hits[0].matchedAllLines).toBe(true);
    });

    it("does not match a PO whose remaining qty cannot cover the invoice line", () => {
        // 125467 has 450 remaining; an invoice for 500 at $20 exceeds it.
        const hits = scoreUnitPriceProof(
            [{ qty: 500, unit_price: 20 }],
            coloradoWormPos,
        );
        expect(hits).toHaveLength(0);
    });

    it("returns two hits when the price recurs across two POs (ambiguous)", () => {
        const pos: UnitPricePoRow[] = [
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                status: "Committed",
                line_items: [{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }],
            },
            {
                po_number: "125999",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-05",
                total_amount: 2000,
                status: "Committed",
                line_items: [{ quantity: "100", productId: "COWOCO2B", unitPrice: 20, remainingQty: 100 }],
            },
        ];
        const hits = scoreUnitPriceProof([{ qty: 50, unit_price: 20 }], pos);
        expect(hits).toHaveLength(2);
        // Both are conclusive — the caller must NOT auto-apply on a tie.
        expect(hits.every((h) => h.matchedAllLines)).toBe(true);
    });

    it("returns [] when the invoice has no priced goods lines", () => {
        expect(scoreUnitPriceProof([], coloradoWormPos)).toEqual([]);
        expect(scoreUnitPriceProof([{ description: "Freight" }], coloradoWormPos)).toEqual([]);
    });

    it("does not credit a fully-received PO that shares the price (remainingQty 0)", () => {
        // 125411 is the same COWOCO2 @ $20 but fully received (remainingQty 0);
        // only 125467 still has units owed.
        const pos: UnitPricePoRow[] = [
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                status: "Committed",
                line_items: [{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }],
            },
            {
                po_number: "125411",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-10-15",
                total_amount: 4500,
                status: "Committed",
                line_items: [{ quantity: "225", productId: "COWOCO2", unitPrice: 20, remainingQty: 0 }],
            },
        ];
        const hits = scoreUnitPriceProof([{ qty: 100, unit_price: 20 }], pos);
        expect(hits).toHaveLength(1);
        expect(hits[0].poNumber).toBe("125467");
        expect(hits[0].matchedAllLines).toBe(true);
    });

    it("does not credit a PO line with no remainingQty (old received PO)", () => {
        // No remainingQty field at all — the PO predates remaining tracking
        // (received), so the price alone must not credit it.
        const pos: UnitPricePoRow[] = [
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                status: "Committed",
                line_items: [{ productId: "COWOCO2", unitPrice: 20 }],
            },
        ];
        const hits = scoreUnitPriceProof([{ qty: 100, unit_price: 20 }], pos);
        expect(hits).toHaveLength(0);
    });
});
