import { describe, expect, it } from "vitest";
import {
    buildStatementSplitSummary,
    filterStatementInvoicePages,
    isAAACooperInvoicePage,
} from "./ap-identifier-statement-filter";

describe("AAA Cooper statement filtering", () => {
    it("keeps a true invoice page with invoice heading, PRO number, and billing charges", () => {
        const invoiceText = `
AAA COOPER TRANSPORTATION
INVOICE
CUSTOMER NUMBER 1159492
PRO NUMBER 64471581
DATE 03/13/26
P.O. NUMBER 124466
RATE 184.33
CHARGES $4,259.87
TOTAL $508.00
`;

        expect(isAAACooperInvoicePage(invoiceText)).toBe(true);
    });

    it("rejects shipment paperwork that lacks invoice heading and billing markers", () => {
        const bolText = `
AAA COOPER TRANSPORTATION
BILL OF LADING
PRO NUMBER 64471581
SHIPPER BUILDSOIL
CONSIGNEE NEW EARTH
PICKUP DATE 03/13/26
DELIVERY RECEIPT
`;

        expect(isAAACooperInvoicePage(bolText)).toBe(false);
    });

    it("rejects inspection or correction notices even if they reference freight details", () => {
        const inspectionText = `
AAA COOPER TRANSPORTATION
INSPECTION CORRECTION NOTICE
PRO NUMBER 64471581
SHIPMENT EXCEPTION
PLEASE REVIEW DAMAGE DETAILS
`;

        expect(isAAACooperInvoicePage(inspectionText)).toBe(false);
    });

    it("filters invoice candidates and reports discarded paperwork count", () => {
        const result = filterStatementInvoicePages("AAA Cooper", [
            {
                page: 1,
                type: "INVOICE",
                invoiceNumber: "64471581",
                amount: 508,
                text: `
AAA COOPER TRANSPORTATION
INVOICE
PRO NUMBER 64471581
RATE 184.33
CHARGES $4,259.87
TOTAL $508.00
`,
            },
            {
                page: 2,
                type: "INVOICE",
                invoiceNumber: "64471580",
                amount: 0,
                text: `
AAA COOPER TRANSPORTATION
BILL OF LADING
PRO NUMBER 64471580
DELIVERY RECEIPT
`,
            },
            {
                page: 3,
                type: "INVOICE",
                invoiceNumber: "64471579",
                amount: 0,
                text: `
AAA COOPER TRANSPORTATION
INSPECTION CORRECTION NOTICE
PRO NUMBER 64471579
`,
            },
        ]);

        expect(result.invoicePages).toHaveLength(1);
        expect(result.invoicePages[0].invoiceNumber).toBe("64471581");
        expect(result.discardedCount).toBe(2);

        const summary = buildStatementSplitSummary("AAA Cooper", result.invoicePages, result.discardedCount);
        expect(summary).toContain("Split 1 invoice(s); discarded 2 non-invoice page(s)");
    });
});
