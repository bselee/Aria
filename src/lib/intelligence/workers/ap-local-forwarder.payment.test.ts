import { describe, expect, it } from "vitest";

import { looksLikePaymentCorrespondence } from "./ap-local-forwarder";

describe("looksLikePaymentCorrespondence", () => {
    it("flags a duplicate-check notice from a vendor", () => {
        const subject = "Logan Labs Payment";
        const body = "We received a check today and these invoices were already paid in March. What do you want me to do with these checks?";
        expect(looksLikePaymentCorrespondence(subject, body)).toBe(true);
    });

    it("flags 'already paid' with a month", () => {
        expect(looksLikePaymentCorrespondence("Payment", "These invoices were paid in June.")).toBe(true);
    });

    it("flags duplicate/overpayment signals", () => {
        expect(looksLikePaymentCorrespondence("Re: invoice", "It looks like this was a duplicate payment.")).toBe(true);
        expect(looksLikePaymentCorrespondence("Re: invoice", "We overpaid your invoice.")).toBe(true);
    });

    it("flags 'what do I do with this check?'", () => {
        expect(looksLikePaymentCorrespondence("", "I received another check today. What should I do?")).toBe(true);
    });

    it("does NOT flag a normal invoice-forward subject/body", () => {
        expect(looksLikePaymentCorrespondence("Invoice 12345 attached", "Please find your invoice attached.")).toBe(false);
    });

    it("does NOT flag empty/marketing noise", () => {
        expect(looksLikePaymentCorrespondence("Weekly newsletter", "Click here for our latest deals.")).toBe(false);
    });
});
