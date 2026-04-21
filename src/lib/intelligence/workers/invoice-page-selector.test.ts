import { describe, expect, it } from "vitest";

import { pickPrimaryInvoicePage } from "./invoice-page-selector";

describe("pickPrimaryInvoicePage", () => {
    it("selects the invoice summary page over packing paperwork", () => {
        const selection = pickPrimaryInvoicePage([
            {
                pageNumber: 1,
                text: [
                    "INVOICE",
                    "Invoice Number: INV-1001",
                    "Bill To: BuildASoil",
                    "Amount Due $1,240.33",
                    "PO #124500",
                ].join("\n"),
                hasTable: true,
            },
            {
                pageNumber: 2,
                text: [
                    "PACKING SLIP",
                    "Tracking Number 1Z999",
                    "Shipment Details",
                ].join("\n"),
                hasTable: false,
            },
        ]);

        expect(selection.pageNumber).toBe(1);
        expect(selection.confidence).toBe("strong");
    });

    it("stays conservative when no page looks clearly like the invoice main page", () => {
        const selection = pickPrimaryInvoicePage([
            {
                pageNumber: 1,
                text: "Shipment details and tracking update",
                hasTable: false,
            },
            {
                pageNumber: 2,
                text: "Order acknowledgement and warehouse notes",
                hasTable: false,
            },
        ]);

        expect(selection.pageNumber).toBeNull();
        expect(selection.confidence).toBe("none");
    });
});
