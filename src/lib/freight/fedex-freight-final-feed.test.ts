/**
 * @file    fedex-freight-final-feed.test.ts
 * @purpose Unit tests for parseFedexFreightFinalNotices — the account/invoice/
 *          amount triple gleaner for FedEx Freight notice bodies.
 * @author  Hermia
 * @created 2026-10-20
 */
import { describe, it, expect } from "vitest";
import { parseFedexFreightFinalNotices } from "./fedex-freight-final-feed";

const SAMPLE_HTML = `
<html><body>
&nbsp; &nbsp; FedEx Freight Billing Online - New Invoices Available
Dear FedEx Freight Billing Online Customer:
The following invoice(s) are now available on FedEx Freight Billing Online:
Account Number Invoice Number Amount
646135168 300413379090 521.82
For details, please access the FedEx Freight Billing Online website at
<a href="https://example.com">FedEx Freight Billing Online</a>.
Sincerely, FedEx Revenue Services
</body></html>`;

const MULTI_ROW_HTML = `
Account Number Invoice Number Amount
646135168 300411710706 975.56
646135168 300414355570 871.54
646135168 300409947179 676.66
`;

describe("parseFedexFreightFinalNotices", () => {
    it("extracts the single triple from a notice body", () => {
        const out = parseFedexFreightFinalNotices(SAMPLE_HTML);
        expect(out).toEqual([{ accountNumber: "646135168", invoiceNumber: "300413379090", amount: 521.82 }]);
    });

    it("extracts multiple triples when the notice lists several invoices", () => {
        const out = parseFedexFreightFinalNotices(MULTI_ROW_HTML);
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual({ accountNumber: "646135168", invoiceNumber: "300411710706", amount: 975.56 });
        expect(out[2]).toEqual({ accountNumber: "646135168", invoiceNumber: "300409947179", amount: 676.66 });
    });

    it("dedupes the same invoice listed twice", () => {
        const out = parseFedexFreightFinalNotices(MULTI_ROW_HTML + "646135168 300411710706 975.56");
        expect(out).toHaveLength(3);
    });

    it("returns [] for empty or garbage bodies", () => {
        expect(parseFedexFreightFinalNotices("")).toEqual([]);
        expect(parseFedexFreightFinalNotices("no numbers here")).toEqual([]);
    });

    it("ignores the disclaimer boilerplate and links", () => {
        const out = parseFedexFreightFinalNotices(SAMPLE_HTML);
        expect(out).toHaveLength(1);
    });

    it("captures the FINAL amount exactly (521.82, not a booked quote)", () => {
        const out = parseFedexFreightFinalNotices("646135168 300413379090 521.82");
        expect(out[0].amount).toBe(521.82);
    });
});
