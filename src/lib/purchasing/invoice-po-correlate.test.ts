/**
 * @file    invoice-po-correlate.test.ts
 * @purpose Pin the invoice→PO correlator: a printed PO only wins when the money
 *          agrees; otherwise fall back to amount+date and refuse to guess.
 * @author  Hermia
 * @created 2026-10-07
 * @deps    vitest, invoice-po-correlate
 */

import { describe, it, expect } from "vitest";
import { correlateInvoiceToPo, type PoRef } from "./invoice-po-correlate";

const PO = (poNumber: string, totalAmount: number, issueDate: string, status = "received"): PoRef => ({
    poNumber,
    vendorName: "Stock Bag Depot",
    totalAmount,
    issueDate,
    status,
});

const VENDOR_POS: PoRef[] = [
    PO("125382", 860.0, "2026-10-05", "open"),
    PO("125303", 751.5, "2026-09-15"),
    PO("125273", 725.0, "2026-09-03"),
    PO("125260", 252.0, "2026-09-01"),
    PO("125014", 504.0, "2026-06-27"),
    PO("124608", 504.0, "2026-04-06"),
];

describe("correlateInvoiceToPo", () => {
    it("confirms the printed PO when the goods totals agree", () => {
        const r = correlateInvoiceToPo({ statedPo: "125382", salesAmount: 860, invoiceDate: "2026-10-06" }, VENDOR_POS);
        expect(r.match?.poNumber).toBe("125382");
        expect(r.reason).toBe("stated_po_amount_confirmed");
    });

    it("rejects a wrong printed PO and finds the right one by amount", () => {
        // Stock Bag printed 125273 on the 751.50 invoice, which is really 125303.
        const r = correlateInvoiceToPo({ statedPo: "125273", salesAmount: 751.5, invoiceDate: "2026-09-17" }, VENDOR_POS);
        expect(r.match?.poNumber).toBe("125303");
        expect(r.reason).toBe("stated_po_amount_mismatch");
    });

    it("picks the nearest of two same-priced POs only when it is clearly closer", () => {
        // 504.00 exists on 125014 (Jun) and 124608 (Apr); the Jun invoice is nearest by far.
        const r = correlateInvoiceToPo({ statedPo: null, salesAmount: 504, invoiceDate: "2026-06-26" }, VENDOR_POS);
        expect(r.match?.poNumber).toBe("125014");
        expect(r.reason).toBe("nearest_amount_date");
    });

    it("holds when two same-priced POs are equally close", () => {
        const pos = [PO("111111", 100, "2026-06-20"), PO("222222", 100, "2026-06-22")];
        const r = correlateInvoiceToPo({ statedPo: null, salesAmount: 100, invoiceDate: "2026-06-21" }, pos);
        expect(r.match).toBeNull();
        expect(r.reason).toBe("ambiguous_amount_date");
    });

    it("reports no candidate when nothing matches the amount", () => {
        const r = correlateInvoiceToPo({ statedPo: null, salesAmount: 999, invoiceDate: "2026-06-21" }, VENDOR_POS);
        expect(r.match).toBeNull();
        expect(r.reason).toBe("no_candidate");
    });
});
