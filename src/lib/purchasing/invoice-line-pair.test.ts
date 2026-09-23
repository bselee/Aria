/**
 * @file    invoice-line-pair.test.ts
 * @purpose Prove invoice lines pair to PO lines without using the vendor part as our SKU.
 * @author  Hermia
 * @created 2026-09-23
 * @deps    vitest, invoice-line-pair
 * @env     none
 */
import { describe, expect, it } from "vitest";
import { decideSupplierPriceWrite, pairInvoiceLines } from "./invoice-line-pair";

describe("pairInvoiceLines", () => {
    it("pairs the only invoice line to the only PO line even when part numbers differ", () => {
        const pairs = pairInvoiceLines(
            [{ vendorPart: "S-22361", quantity: 2, unitPrice: 80 }],
            [{ productId: "PLC101", quantity: 2, unitPrice: 75 }],
        );
        expect(pairs).toEqual([
            expect.objectContaining({
                status: "paired",
                productId: "PLC101",
                vendorPart: "S-22361",
                qtyDiffers: false,
            }),
        ]);
    });

    it("does not treat a vendor part as our SKU by substring", () => {
        const pairs = pairInvoiceLines(
            [{ vendorPart: "223", quantity: 4, unitPrice: 10 }],
            [
                { productId: "S22361", quantity: 2, unitPrice: 10 },
                { productId: "BAG101", quantity: 9, unitPrice: 4 },
            ],
        );
        expect(pairs[0]?.status).toBe("hold");
    });

    it("pairs a Uline item number that already equals our SKU", () => {
        const pairs = pairInvoiceLines(
            [{ vendorPart: "S-5940", quantity: 1, unitPrice: 28 }],
            [{ productId: "S-5940", quantity: 1, unitPrice: 26 }],
        );
        expect(pairs[0]).toEqual(expect.objectContaining({
            status: "paired",
            productId: "S-5940",
        }));
    });

    it("holds a line when two PO lines share the quantity and the price does not pick one", () => {
        const pairs = pairInvoiceLines(
            [{ vendorPart: "V-1", quantity: 10, unitPrice: 40 }],
            [
                { productId: "A", quantity: 10, unitPrice: 20 },
                { productId: "B", quantity: 10, unitPrice: 22 },
            ],
        );
        expect(pairs[0]?.status).toBe("hold");
    });

    it("flags a quantity difference as contact, not a rewrite", () => {
        const pairs = pairInvoiceLines(
            [{ vendorPart: "V-9", quantity: 8, unitPrice: 50 }],
            [{ productId: "RW1", quantity: 10, unitPrice: 50 }],
        );
        expect(pairs[0]).toEqual(expect.objectContaining({
            status: "paired",
            qtyDiffers: true,
        }));
    });
});

describe("decideSupplierPriceWrite", () => {
    it("writes when the invoice is within 2% of Supplier 1", () => {
        const d = decideSupplierPriceWrite({
            currentSupplierPrice: 200,
            invoicePrice: 203,
            priorPrices: [200],
        });
        expect(d.write).toBe(true);
    });

    it("holds a clean pack multiple of every prior price", () => {
        const d = decideSupplierPriceWrite({
            currentSupplierPrice: 10,
            invoicePrice: 120,
            priorPrices: [10, 10.5],
        });
        expect(d.write).toBe(false);
        expect(d.reason).toMatch(/multiple/i);
    });

    it("writes a non-multiple move when there is only one prior price", () => {
        const d = decideSupplierPriceWrite({
            currentSupplierPrice: 200,
            invoicePrice: 216,
            priorPrices: [200],
        });
        expect(d.write).toBe(true);
    });

    it("writes when the new price sits inside how that SKU has moved", () => {
        const d = decideSupplierPriceWrite({
            currentSupplierPrice: 19,
            invoicePrice: 17.5,
            priorPrices: [15, 19],
        });
        expect(d.write).toBe(true);
    });
});
