/**
 * @file    overbill-dispute.test.ts
 * @purpose Tests for the overbill hold flow and the vendor draft voice.
 */
import { describe, it, expect } from "vitest";
import { overbillDraftBody } from "./overbill-dispute";

describe("overbillDraftBody", () => {
    it("states received vs billed, the delta, and what Bill will enter", () => {
        const body = overbillDraftBody({
            poNumber: "125409",
            vendorName: "Thrive Probiotics",
            invoiceNumber: "3001",
            invoicedTotal: 1500,
            receivedValue: 1000,
            delta: 500,
        });
        expect(body).toContain("Received $1,000");
        expect(body).toContain("$1,500 billed");
        expect(body).toContain("on invoice 3001");
        expect(body).toContain("credit the $500");
        expect(body).toContain("PO 125409");
    });

    it("omits the invoice clause for junk OCR numbers", () => {
        const body = overbillDraftBody({
            poNumber: "125379",
            vendorName: "Miles Filippelli",
            invoiceNumber: "error",
            invoicedTotal: 2688,
            receivedValue: 1344,
            delta: 1344,
        });
        expect(body).not.toContain("on invoice");
        expect(body).toContain("credit the $1,344");
    });

    it("stays under 45 words with no em dashes (Bill voice)", () => {
        const body = overbillDraftBody({
            poNumber: "125409",
            vendorName: "Thrive",
            invoiceNumber: "3001",
            invoicedTotal: 1500,
            receivedValue: 1000,
            delta: 500,
        });
        expect(body.split(/\s+/).length).toBeLessThanOrEqual(45);
        expect(body).not.toMatch(/—|--/);
    });
});
