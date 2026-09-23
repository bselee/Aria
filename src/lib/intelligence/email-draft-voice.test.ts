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
    isNoResponseNeededFyi,
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

    it("Noah.Julin@ is Noah, never last-name Julin", () => {
        const from = "Noah.Julin@destinationtrans.com";
        expect(extractReplyFirstName(from)).toBe("Noah");
        expect(extractReplyFirstName(from)).not.toBe("Julin");
        expect(extractReplyFirstName("Noah Julin <Noah.Julin@destinationtrans.com>")).toBe("Noah");
        expect(
            extractReplyFirstName(
                from,
                "Hey Bill,\n\nGot this secured at $2,250 today.\n\nThanks,\n\nNoah Julin\nNational Account Executive",
            ),
        ).toBe("Noah");
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

describe("isNoResponseNeededFyi", () => {
    it("flags broker FYI rate-secured with no question", () => {
        expect(
            isNoResponseNeededFyi({
                subject: "Re: Load",
                bodyText:
                    "Hey Bill,\n\nGot this secured at $2,250 today.\n\nThanks,\n\nNoah Julin\nNational Account Executive",
            }),
        ).toBe(true);
    });

    it("does not flag a real ask", () => {
        expect(
            isNoResponseNeededFyi({
                subject: "Re: Load",
                bodyText: "Hey Bill, can you confirm the delivery hours for tomorrow?",
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

    it("FAILS a draft that invents a shipping address", () => {
        const bad = `Hi Surya,

A sample would be welcome. Please ship to:
BuildASoil
123 Main Street
Montrose, CO 81401

Thanks!`;
        const g = gradeVendorReplyDraft({
            draftBody: bad,
            inboundFrom: "Surya <care@medikonda.com>",
            inboundSubject: "FD Coconut Powder sample",
            inboundBody: "Hi Bill, would you like a sample of our FD Coconut Powder?",
        });
        expect(g.pass).toBe(false);
        expect(g.failures).toEqual(expect.arrayContaining(["invented_address"]));
    });

    it("FAILS a draft that invents a phone number", () => {
        const bad = `Hi David,

Thanks for the spec sheet. Please quote one super sack to start. Call me at 970-123-4567.

Thanks!`;
        const g = gradeVendorReplyDraft({
            draftBody: bad,
            inboundFrom: "David <davidc@lonestarbarite.com>",
            inboundSubject: "Calcium bentonite spec sheet",
            inboundBody: "Hi Bill, here is the spec sheet you requested.",
        });
        expect(g.pass).toBe(false);
        expect(g.failures).toEqual(expect.arrayContaining(["invented_phone"]));
    });

    it("PASSES a draft using the canonical sample ship-to", () => {
        const good = `Hi Surya,

A sample would be welcome. Please ship to BuildASoil, 5016 N Townsend Ave, Montrose, CO 81401.

Thanks!`;
        const g = gradeVendorReplyDraft({
            draftBody: good,
            inboundFrom: "Surya <care@medikonda.com>",
            inboundSubject: "FD Coconut Powder sample",
            inboundBody: "Hi Bill, would you like a sample of our FD Coconut Powder?",
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
