/**
 * @file    email-draft-voice.test.ts
 * @purpose Bill voice: no Gmail-dupe signature, Megan COA accuracy, Cari simple Thanks!
 */
import { describe, expect, it } from "vitest";
import {
    BILL_VENDOR_REPLY_VOICE,
    composeSimpleThanks,
    extractNameFromSignOff,
    extractReplyFirstName,
    gradeVendorReplyDraft,
    isSimpleVendorConfirmation,
    templateWarmVendorReply,
} from "./email-draft-voice";
import { templateOpportunityDraft } from "./vendor-opportunity";
import {
    composeHumanEscalationDraftStub,
    composeRoutineDraftBody,
} from "./email-response-policy";

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

Lastly, we do not typically offer a COA for this product, however I have included some prior
testing results. Let me know if you'd be interested in receiving a sample!

Kind regards,
Megan
`;

const CARI_FROM = "cs@herbsnow.com";
const CARI_BODY = `Hi Bill,

Sounds good! I'll send over an invoice as soon as we're restocked.

Best regards,
Cari
HerbsNOW
`;

describe("extractReplyFirstName", () => {
    it("uses display name Megan Bateman", () => {
        expect(extractReplyFirstName(MEGAN_FROM)).toBe("Megan");
    });

    it("uses body sign-off Cari, never cs from cs@", () => {
        expect(extractReplyFirstName(CARI_FROM, CARI_BODY)).toBe("Cari");
        expect(extractNameFromSignOff(CARI_BODY)).toBe("Cari");
        expect(extractReplyFirstName(CARI_FROM)).not.toBe("Cs");
        expect(extractReplyFirstName(CARI_FROM).toLowerCase()).not.toBe("cs");
    });
});

describe("isSimpleVendorConfirmation", () => {
    it("flags HerbsNOW restock invoice promise as simple confirm", () => {
        expect(
            isSimpleVendorConfirmation({
                subject: "Re: order",
                bodyText: CARI_BODY,
            }),
        ).toBe(true);
    });

    it("does not flag Megan substantive commercial email", () => {
        expect(
            isSimpleVendorConfirmation({
                subject: MEGAN_SUBJECT,
                bodyText: MEGAN_BODY,
            }),
        ).toBe(false);
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
            expect.arrayContaining(["false_coa_claim", "dismissive_close", "duplicate_gmail_signature"]),
        );
    });

    it("FAILS Hi cs + looking into this on Cari confirm", () => {
        const bad = `Hi cs,

Thanks — looking into this and will follow up shortly.

Bill
BuildASoil Purchasing`;
        const g = gradeVendorReplyDraft({
            draftBody: bad,
            inboundFrom: CARI_FROM,
            inboundSubject: "Re: order",
            inboundBody: CARI_BODY,
        });
        expect(g.pass).toBe(false);
        expect(g.failures).toEqual(
            expect.arrayContaining(["bad_greeting_name", "wrong_escalation_stub", "duplicate_gmail_signature"]),
        );
    });

    it("PASSES a warm accurate draft WITHOUT gmail signature", () => {
        const good = `Hi Megan,

Thanks for the traceability detail and the process videos — helpful. Noted you don't typically issue a COA for this product; the prior testing results are still useful for our review. A sample would be welcome if you can send one. We'll review on our side and follow up.

Thanks!`;
        const g = gradeVendorReplyDraft({
            draftBody: good,
            inboundFrom: MEGAN_FROM,
            inboundSubject: MEGAN_SUBJECT,
            inboundBody: MEGAN_BODY,
        });
        expect(g.failures).toEqual([]);
        expect(g.pass).toBe(true);
    });
});

describe("composeSimpleThanks / Cari path", () => {
    it("is Thanks! or Hi Cari + Thanks! — never looking into this, never signature", () => {
        const body = composeSimpleThanks({ from: CARI_FROM, bodyText: CARI_BODY });
        expect(body.toLowerCase()).toMatch(/thanks/);
        expect(body.toLowerCase()).not.toMatch(/looking into/);
        expect(body).not.toMatch(/BuildASoil Purchasing/);
        expect(body).not.toMatch(/^Hi cs,/im);

        const routine = composeRoutineDraftBody({
            from: CARI_FROM,
            subject: "Re: order",
            bodyText: CARI_BODY,
        });
        expect(routine).toBe(body);

        const stub = composeHumanEscalationDraftStub({
            from: CARI_FROM,
            subject: "Re: order",
            bodyText: CARI_BODY,
        });
        expect(stub).toBe(body);
    });
});

describe("templateWarmVendorReply — Megan kelp", () => {
    it("never claims COA received; no Gmail signature block; acknowledges help", () => {
        const body = templateWarmVendorReply({
            from: MEGAN_FROM,
            subject: MEGAN_SUBJECT,
            bodyText: MEGAN_BODY,
        });

        expect(body).toMatch(/^Hi Megan,/m);
        expect(body).not.toMatch(/BuildASoil Purchasing/);
        expect(body).not.toMatch(/\nBill\s*$/m);
        expect(body.toLowerCase()).not.toMatch(/coa received/);
        expect(body).toMatch(/don't typically issue a COA|do not typically/i);
        expect(body).toMatch(/traceab|video|testing/i);
        expect(body).toMatch(/sample/i);
        expect(body.toLowerCase()).toMatch(/thanks/);

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

describe("BILL_VENDOR_REPLY_VOICE few-shot examples", () => {
    it("includes example keywords", () => {
        expect(BILL_VENDOR_REPLY_VOICE).toMatch(/example/i);
        expect(BILL_VENDOR_REPLY_VOICE).toMatch(/Megan/i);
        expect(BILL_VENDOR_REPLY_VOICE).toMatch(/Thanks/i);
    });

    it("examples don't contradict rules", () => {
        const examples = BILL_VENDOR_REPLY_VOICE.split("EXAMPLES")[1] || "";
        expect(examples).not.toMatch(/BuildASoil Purchasing/);
        expect(examples).not.toMatch(/follow up if useful/i);
    });
});
