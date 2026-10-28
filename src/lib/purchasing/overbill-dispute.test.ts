/**
 * @file    overbill-dispute.test.ts
 * @purpose Tests for the overbill hold flow and the vendor draft voice.
 */
import { describe, it, expect } from "vitest";
import { overbillDraftBody } from "./overbill-dispute";

describe("overbillDraftBody", () => {
    it("uses Bill's verbatim voice — grace first, no figures in the email", () => {
        const body = overbillDraftBody({
            poNumber: "125409",
            vendorName: "Thrive Probiotics",
            invoiceNumber: "3001",
            invoicedTotal: 1500,
            receivedValue: 1000,
            delta: 500,
        });
        expect(body).toBe(
            "Hey- Noticed the delivery did not match up with the invoice. What would you like to do?",
        );
        // The numbers stay in the dispute record, never in the email.
        expect(body).not.toMatch(/\$|PO \d/);
    });

    it("is short with no em or double dashes (Bill voice)", () => {
        const body = overbillDraftBody({
            poNumber: "125379",
            vendorName: "Miles Filippelli",
            invoiceNumber: "error",
            invoicedTotal: 2688,
            receivedValue: 1344,
            delta: 1344,
        });
        expect(body.split(/\s+/).length).toBeLessThanOrEqual(45);
        expect(body).not.toMatch(/—|--/);
    });
});
