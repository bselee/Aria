/**
 * @file    email-draft-voice.test.ts
 * @purpose Bill voice grade gate + Megan kelp regression (false COA claim).
 */
import { describe, expect, it } from "vitest";
import {
    extractReplyFirstName,
    gradeVendorReplyDraft,
    templateWarmVendorReply,
} from "./email-draft-voice";
import { templateOpportunityDraft } from "./vendor-opportunity";

const MEGAN_FROM = "Megan Bateman <megan@noamkelp.com>";
const MEGAN_SUBJECT = "North American Kelp — traceability";
const MEGAN_BODY = `
Good morning Bill,

One thing that truly sets North American Kelp apart is our proximity to the Atlantic Ocean.
We maintain exceptional traceability and consistency. Our organic certifier, MOFGA, assigns
sector numbers. With our lot numbering system, we can trace every 50 lb bag back to the
individual harvester.

Videos:
https://www.youtube.com/watch?v=1ayYbVQxo1o
https://www.youtube.com/watch?v=d97JfKlv_N8

Lastly, we do not typically offer a COA for this product, however I have included some prior
testing results. Let me know if you have any questions or if you'd be interested in receiving
a sample so you can see the quality first hand!

Kind regards,
Megan
`;

describe("extractReplyFirstName", () => {
    it("uses display name Megan Bateman", () => {
        expect(extractReplyFirstName(MEGAN_FROM)).toBe("Megan");
    });
});

describe("gradeVendorReplyDraft", () => {
    it("FAILS the cold wrong draft Bill refused to send", () => {
        const bad =
            "Traceability details and COA received. We'll review and compare with our current source and follow up if useful. Bill / BuildASoil Purchasing";
        const g = gradeVendorReplyDraft({
            draftBody: bad,
            inboundFrom: MEGAN_FROM,
            inboundSubject: MEGAN_SUBJECT,
            inboundBody: MEGAN_BODY,
        });
        expect(g.pass).toBe(false);
        expect(g.failures).toEqual(
            expect.arrayContaining(["false_coa_claim", "dismissive_close"]),
        );
        expect(g.score).toBeLessThan(70);
    });

    it("PASSES a warm accurate draft", () => {
        const good = `Hi Megan,

Thanks for the traceability detail and the process videos — helpful. Noted you don't typically issue a COA for this product; the prior testing results are still useful for our review. A sample would be welcome if you can send one. We'll review on our side and follow up.

Bill
BuildASoil Purchasing`;
        const g = gradeVendorReplyDraft({
            draftBody: good,
            inboundFrom: MEGAN_FROM,
            inboundSubject: MEGAN_SUBJECT,
            inboundBody: MEGAN_BODY,
        });
        expect(g.failures).toEqual([]);
        expect(g.pass).toBe(true);
        expect(g.score).toBeGreaterThanOrEqual(70);
    });
});

describe("templateWarmVendorReply / opportunity template — Megan kelp", () => {
    it("never claims COA received; acknowledges help; offers soft sample accept", () => {
        const body = templateWarmVendorReply({
            from: MEGAN_FROM,
            subject: MEGAN_SUBJECT,
            bodyText: MEGAN_BODY,
        });

        expect(body).toMatch(/^Hi Megan,/m);
        expect(body).toMatch(/\nBill\nBuildASoil Purchasing\s*$/);
        expect(body.toLowerCase()).not.toMatch(/coa received/);
        expect(body).toMatch(/don't typically issue a COA|do not typically/i);
        expect(body).toMatch(/traceab|video|testing/i);
        expect(body).toMatch(/sample/i);
        expect(body.toLowerCase()).not.toMatch(/follow up if useful/);

        const g = gradeVendorReplyDraft({
            draftBody: body,
            inboundFrom: MEGAN_FROM,
            inboundSubject: MEGAN_SUBJECT,
            inboundBody: MEGAN_BODY,
        });
        expect(g.pass).toBe(true);

        const opp = templateOpportunityDraft({
            from: MEGAN_FROM,
            subject: MEGAN_SUBJECT,
            bodyText: MEGAN_BODY,
        });
        expect(opp.draftBody).toBe(body);
    });
});
