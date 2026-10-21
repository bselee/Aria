/**
 * @file    invoice-header.test.ts
 * @purpose Pin the vendor-invoice header parser + freight classification used to
 *          decide whether an invoice's shipping amount belongs on the PO.
 * @author  Hermia
 * @created 2026-10-07
 * @deps    vitest, invoice-header
 */

import { describe, it, expect } from "vitest";
import { parseVendorInvoiceHeader, classifyInvoiceFreight } from "./invoice-header";

/** Real header layout of Stock Bag Depot invoice 112370 (PO 125382), CIP / Free Freight. */
const INV_112370 = `                                                                                 INVOICE 112370
                                                                                              Invoice Date: 10/06/26
Customer PO No.               Payment Terms              Ship Via              Shipping Terms               Order No.
    PO 125382                    PBS-CARD              FEDEX-GND                       CIP                   113434
MUBZ-2P13        2LB Metallized SUZP - Natural Kraft   1,000  1,000         0  $0.5200         $0.00            $520.00
F-FREESHIP                                                      1           1        0 ($149.1400) ($149.14)            $0.00
                 Free Shipping
Order Notes:                                                                                Sales Amount    $860.00
CCx 3526 | Card on file                                                                Invoice Discount     $860.00
Free Freight to mtch online                                                            Shipping Amount
                                                                                                               $0.00
                                                                                                            $0.00
                                                                                              Sales Tax
                                                                               Total Invoice Amount
`;

/** Real header of invoice 112119 (PO 125260), PPD-ADD with a real $32.08 freight charge. */
const INV_112119 = `                                                                             INVOICE 112119
                                                                                          Invoice Date: 09/01/26
Customer PO No.               Payment Terms          Ship Via              Shipping Terms             Order No.
    PO 125260                    PBS-CARD          FEDEX-GND                   PPD-ADD                 113179
MUBZ-8Z07        8oz Metallized SUZP - Green       1,000  1,000         0  $0.2520         $0.00        $252.00
Order Notes:                                                                            Sales Amount    $252.00
CCx 3526 | Card on file                                                            Invoice Discount        $0.00
                                                                                   Shipping Amount
                                                                                                        $32.08
                                                                                             Sales Tax     $0.00
                                                                               Total Invoice Amount
                                                                           Payment/Credit Applied       $284.08
`;

/** UPS-prepaid-and-add variant (invoice 109612, PO 123898). */
const INV_109612 = `INVOICE 109612
Invoice Date: 10/09/25
    PO 123898                    PBS-CARD          UPS-GND                   PPD-ADD                 110555
Sales Amount    $252.00
Shipping Amount    $27.05
Total Invoice Amount    $279.05
`;

describe("parseVendorInvoiceHeader", () => {
    it("reads invoice number, stated PO, order number, ship via and shipping terms", () => {
        const h = parseVendorInvoiceHeader(INV_112370);
        expect(h.invoiceNumber).toBe("112370");
        expect(h.invoiceDate).toBe("10/06/26");
        expect(h.statedPo).toBe("125382");
        expect(h.orderNumber).toBe("113434");
        expect(h.paymentTerms).toBe("PBS-CARD");
        expect(h.shipVia).toBe("FEDEX-GND");
        expect(h.shippingTerms).toBe("CIP");
    });

    it("reads the goods amount and a blank shipping amount", () => {
        const h = parseVendorInvoiceHeader(INV_112370);
        expect(h.salesAmount).toBe(860);
        expect(h.shippingAmount).toBe(0);
        expect(h.freeFreightMarker).toBe(true);
    });

    it("reads a real shipping amount when the vendor charged one", () => {
        const h = parseVendorInvoiceHeader(INV_112119);
        expect(h.statedPo).toBe("125260");
        expect(h.shippingTerms).toBe("PPD-ADD");
        expect(h.salesAmount).toBe(252);
        expect(h.shippingAmount).toBe(32.08);
        expect(h.total).toBe(284.08);
    });

    it("parses the jammed pdf-parse reading-order row (columns run together)", () => {
        const h = parseVendorInvoiceHeader(
            `Customer PO No.Payment TermsShip ViaShipping TermsOrder No.
PO 125260PBS-CARDFEDEX-GNDPPD-ADD113179
Sales Amount$252.00
Invoice Discount $0.00
Shipping Amount$32.08
Total Invoice Amount$284.08
`,
        );
        expect(h.statedPo).toBe("125260");
        expect(h.orderNumber).toBe("113179");
        expect(h.shipVia).toBe("FEDEX-GND");
        expect(h.shippingTerms).toBe("PPD-ADD");
        expect(h.paymentTerms).toBe("PBS-CARD");
        expect(classifyInvoiceFreight(h)).toEqual({ payer: "vendor_charged", amount: 32.08 });
    });
});

describe("classifyInvoiceFreight", () => {
    it("CIP / free-freight invoice => vendor pays, nothing to add", () => {
        expect(classifyInvoiceFreight(parseVendorInvoiceHeader(INV_112370))).toEqual({
            payer: "vendor_free",
            amount: 0,
        });
    });

    it("PPD-ADD invoice => vendor charged us the printed shipping amount", () => {
        expect(classifyInvoiceFreight(parseVendorInvoiceHeader(INV_112119))).toEqual({
            payer: "vendor_charged",
            amount: 32.08,
        });
    });

    it("UPS PPD-ADD variant is vendor_charged", () => {
        const c = classifyInvoiceFreight(parseVendorInvoiceHeader(INV_109612));
        expect(c.payer).toBe("vendor_charged");
        expect(c.amount).toBe(27.05);
    });

    it("COLLECT => our carrier account pays, nothing on this invoice", () => {
        const c = classifyInvoiceFreight(
            parseVendorInvoiceHeader(`INVOICE 900001\nInvoice Date: 01/02/26\n    PO 123456    NET30    FEDEX-GND    COLLECT    778899\nSales Amount    $100.00\n`),
        );
        expect(c).toEqual({ payer: "bas_collect", amount: 0 });
    });

    it("a blank shipping cell that bleeds onto the sales amount is not freight", () => {
        // Layout artifact: the printed Shipping Amount reads back as the sales value.
        const h = parseVendorInvoiceHeader(
            `INVOICE 111601\n    PO 125014    PBS-CARD    FEDEX-GND    CIP    112629\nSales Amount    $504.00\nShipping Amount    $504.00\n`,
        );
        expect(classifyInvoiceFreight(h)).toEqual({ payer: "vendor_free", amount: 0 });
    });

    it("derives freight from the amount block when the terms are not conclusive", () => {
        const h = parseVendorInvoiceHeader(
            `INVOICE 900002\n    PO123456    CARD    FEDEX-GND    NET30    778899\nSales Amount    $252.00\nShipping Amount    $32.08\nTotal Invoice Amount    $284.08\n`,
        );
        expect(classifyInvoiceFreight(h)).toEqual({ payer: "vendor_charged", amount: 32.08 });
    });
});
