/**
 * @file    invoice-text-lines.test.ts
 * @purpose The PDF text is the invoice. Empty line_items is a read failure.
 * @author  Hermia
 * @created 2026-09-23
 */
import { describe, expect, it } from "vitest";
import { extractGoodsLinesFromInvoiceText } from "./invoice-text-lines";

const TEALAB = `TeaLAB
INVOICE
14322
PO Number: 125227
8/26/2026
Item Code
Description
Qty
Price
Total
Organic Compost Tea
40.00
13.00
520.00
Invoice Total: $520.00
`;

const DIAMOND_K = `DIAMOND K GYPSUM, INC.
Invoice
GY-099880-01
Quantity
Description
Unit Price
Amount
18.0000
Diamond K Gypsum Premium 97%
PO#125249
119.0000
2,142.00
4.0000
Diamond K Gypsum Premium 97%
PO#125249
63.6500
254.60
Total Invoice
$2,396.60
`;

const FINANCE = `FINANCE CHARGE NOTICE
Past due balance
Amount due $45.00
`;

const STATEMENT = `STATEMENT
Invoice 1001 $100.00
Invoice 1002 $200.00
Total $300.00
`;

const TEALAB_PARSE = `Invoice #
14322
P.O. Number
125227
Item CodeDescriptionQuantityPrice EachAmount
Brew Bag SmallBrew Bag, Small4013.00520.00
$520.00
`;

const DIAMOND_PARSE = `09/11/2026         GY-099880-01
   20 2000 DIAMOND K                    PER TON    20.00    40000             115.000     2300.00
   PREMIUM 97 SOLUTION
   GRADE GYPSUM
   4 50 LB BAGS DIAMOND K               PER TON      .10      200             966.000       96.60
   SOLUTION GRADE ULTRA
                                                   20.10     40200                      $2,396.60
   B/L #                    P.O. #    125249
`;

const GLUED = `Ferti-Fulvic Plus2004.00800.00lb
Freight158.00
Invoice Total: $958.00
`;

const ROOTWISE = `QuantityDescriptionSizeUnit PriceCost
1Mycrobe Complete5 Pound$\t350.00$\t350.00
Total$ 350.00
`;

const BEE = `Item CodeDescriptionQuantityPrice EachAmountU/M
Bee Rite
4,0000.28751,150.00
Handling Charge10.00
Total
$1,160.00
`;

describe("extractGoodsLinesFromInvoiceText", () => {
    it("reads the pdf-parse text the pipeline actually stores", () => {
        const tea = extractGoodsLinesFromInvoiceText(TEALAB_PARSE);
        expect(tea.balanced).toBe(true);
        expect(tea.poNumber).toBe("125227");
        expect(tea.lines[0]).toMatchObject({ qty: 40, unitPrice: 13, total: 520 });

        const diamond = extractGoodsLinesFromInvoiceText(DIAMOND_PARSE);
        expect(diamond.balanced).toBe(true);
        expect(diamond.poNumber).toBe("125249");
        expect(diamond.lines[0]).toMatchObject({ qty: 20, unitPrice: 115, total: 2300 });
        expect(diamond.lines[1]).toMatchObject({ qty: 0.1, unitPrice: 966, total: 96.6 });
    });

    it("reads a line when the unit or a dollar sign is glued to the amount", () => {
        const glued = extractGoodsLinesFromInvoiceText(GLUED);
        expect(glued.balanced).toBe(true);
        expect(glued.lines[0]).toMatchObject({ qty: 200, unitPrice: 4, total: 800 });

        const root = extractGoodsLinesFromInvoiceText(ROOTWISE);
        expect(root.balanced).toBe(true);
        expect(root.lines[0]).toMatchObject({ qty: 1, unitPrice: 350, total: 350 });

        const bee = extractGoodsLinesFromInvoiceText(BEE);
        expect(bee.balanced).toBe(true);
        expect(bee.lines[0]).toMatchObject({ qty: 4000, unitPrice: 0.2875, total: 1150 });
    });

    it("reads TeaLAB quantity, price, and purchase order from the text", () => {
        const read = extractGoodsLinesFromInvoiceText(TEALAB);
        expect(read.balanced).toBe(true);
        expect(read.poNumber).toBe("125227");
        expect(read.lines).toEqual([
            {
                sku: "",
                description: "Organic Compost Tea",
                qty: 40,
                unitPrice: 13,
                total: 520,
            },
        ]);
    });

    it("reads both Diamond K goods lines and ignores the purchase-order mark", () => {
        const read = extractGoodsLinesFromInvoiceText(DIAMOND_K);
        expect(read.balanced).toBe(true);
        expect(read.poNumber).toBe("125249");
        expect(read.lines).toHaveLength(2);
        expect(read.lines[0]).toMatchObject({ qty: 18, unitPrice: 119, total: 2142 });
        expect(read.lines[1]).toMatchObject({ qty: 4, unitPrice: 63.65, total: 254.6 });
        expect(read.lines[0].description).toContain("Diamond K Gypsum");
    });

    it("does not invent lines on a finance charge or a statement", () => {
        expect(extractGoodsLinesFromInvoiceText(FINANCE).lines).toEqual([]);
        expect(extractGoodsLinesFromInvoiceText(STATEMENT).lines).toEqual([]);
        expect(extractGoodsLinesFromInvoiceText(FINANCE).balanced).toBe(false);
    });

    it("holds when the lines do not add up to the printed total", () => {
        const read = extractGoodsLinesFromInvoiceText(`${TEALAB}\nExtra`, 999);
        expect(read.balanced).toBe(false);
        expect(read.lines).toEqual([]);
    });
});
