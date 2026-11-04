/**
 * @file    reconcile-parcel-tracking-freight.test.ts
 * @purpose Pin the FedEx parcel invoice parse: one shipment block read as-is from
 *          Xpdf `pdftotext -table` output, including the recipient-billed shape
 *          and the revenue-threshold sentence that must NOT count as a charge.
 */
import { describe, it, expect } from "vitest";
import {
    splitShipmentBlocks,
    parseBlockAmounts,
    amountsBalance,
    trackingIdsFromRows,
    trackingIdsFromInvoiceText,
    invoiceOnOurFedexAccount,
    blockMentionsVendor,
} from "./reconcile-parcel-tracking-freight";

/** Verbatim `pdftotext -table` block for tracking 879074408812 (invoice 952951280 p10). */
const RECIPIENT_BILLED_BLOCK = `
Tracking ID       879074408812       Sender                        Recipient                                                   Transportation Charge      25.16

Service Type      Ground Domestic    GAGE W. DEVRIES               BILL SELEE                                                  Discount                   -11.57

Zone              6                  SAFE SOLUTIONS INC.           BUILDASOIL LLC                                              Earned Discount            -3.77

Packages          1                  HOWARD CITY MI 49329-5114-33  MONTROSE CO 81401-8170-46                                   Fuel Surcharge             2.84

Rated Weight      14 lbs                                                                                                       DAS Commercial             1.78

Delivered         Oct 28, 2026                                                                                                 Total Charge          USD  $14.44

                                                                   Bill Recipient Subtotal                                             USD                $14.44
`;

/** Outbound BAS shipment, shipper-billed, with the prose revenue sentence. */
const OUTBOUND_BLOCK = `
The Earned Discount for this ship date has been calculated based on a revenue threshold of USD 2,587,377.19

Tracking ID       879362129666       Sender                        Recipient                                                   Transportation Charge      29.09

Service Type      Ppd, Domestic      BAS SHIPPING                  COLIN FLYNN                                                 Discount                   -14.55

Zone              5                  BAS                           SANTA CRUZ CA 95060-1219-94                                 Earned Discount            -4.36

Packages          1                  MONTROSE CO 81401-8170-46                                                                  Fuel Surcharge             4.22

Actual Weight     22.9 lbs                                                                                                     Residential Delivery       6.45

Rated Weight      23 lbs                                                                                                       Demand Surcharge           0.50

Delivered         Oct 31, 2026                                                                                                 Total Charge          USD  $21.35
`;

const PAGE = `${OUTBOUND_BLOCK}\n${RECIPIENT_BILLED_BLOCK}`;

describe("splitShipmentBlocks", () => {
    it("splits a page into one block per Tracking ID row", () => {
        const blocks = splitShipmentBlocks(PAGE);
        expect(blocks).toHaveLength(2);
        expect(blocks[0][0]).toContain("879362129666");
        expect(blocks[1][0]).toContain("879074408812");
    });
});

describe("parseBlockAmounts", () => {
    const block = splitShipmentBlocks(PAGE)[1];

    it("reads the recipient-billed total and its components", () => {
        const a = parseBlockAmounts(block);
        expect(a.total).toBe(14.44);
        expect(a.billRecipientTotal).toBe(14.44);
        expect(a.components.map((c) => [c.label, c.amount])).toEqual([
            ["Transportation Charge", 25.16],
            ["Discount", -11.57],
            ["Earned Discount", -3.77],
            ["Fuel Surcharge", 2.84],
            ["DAS Commercial", 1.78],
        ]);
        expect(amountsBalance(a)).toBe(true);
    });

    it("ignores the revenue-threshold sentence", () => {
        const outbound = splitShipmentBlocks(PAGE)[0];
        const a = parseBlockAmounts(outbound);
        expect(a.total).toBe(21.35);
        expect(a.components.some((c) => c.amount > 1000)).toBe(false);
        expect(amountsBalance(a)).toBe(true);
    });
});

describe("trackingIdsFromRows", () => {
    it("strips the carrier prefix PostgREST stores", () => {
        expect(trackingIdsFromRows(["FedEx:::879074408812"])).toEqual(["879074408812"]);
        expect(trackingIdsFromRows(["FedEx:::874432399574, FedEx:::879074408812"]).sort()).toEqual([
            "874432399574",
            "879074408812",
        ]);
    });

    it("ignores empty and short values", () => {
        expect(trackingIdsFromRows([null, undefined, "", "FedEx:::"])).toEqual([]);
    });
});

describe("blockMentionsVendor", () => {
    const hint = "Zone 6 SAFE SOLUTIONS INC. BUILDASOIL LLC Earned Discount -3.77";

    it("matches the vendor despite punctuation and case", () => {
        expect(blockMentionsVendor(hint, "safe solutions")).toBe(true);
        expect(blockMentionsVendor(hint, "Safe Solutions, Inc.")).toBe(true);
        expect(blockMentionsVendor(hint, "SafeSolutions")).toBe(true);
    });

    it("does not match another vendor", () => {
        expect(blockMentionsVendor(hint, "Uline")).toBe(false);
        expect(blockMentionsVendor(hint, "")).toBe(false);
    });
});

describe("trackingIdsFromInvoiceText", () => {
    // Verbatim header lines from Safe Solutions invoice 9113 (PO 124304).
    const HEADER = `
   Shipping info                                    Invoice details                       P.O. Number: 124304
   Ship via: FedEx                                  Invoice no.: 9113                     Sales Rep: Bill Selee
   Ship date: 01/16/2026                            Terms: Net 30
   Tracking no.: 887976290599                       Invoice date: 01/16/2026
   Due date: 02/15/2026
2.                       Shipping                               BAS FedEx Account                     1          $0.00   $0.00
`;

    it("reads the tracking number the vendor printed", () => {
        expect(trackingIdsFromInvoiceText(HEADER)).toEqual(["887976290599"]);
    });

    it("does not mistake an invoice or PO number for a tracking number", () => {
        expect(trackingIdsFromInvoiceText("Invoice no.: 9113  P.O. Number: 124304")).toEqual([]);
    });

    it("recognises the BAS FedEx account line", () => {
        expect(invoiceOnOurFedexAccount(HEADER)).toBe(true);
        expect(invoiceOnOurFedexAccount("Ship via: UPS Ground")).toBe(false);
    });
});
