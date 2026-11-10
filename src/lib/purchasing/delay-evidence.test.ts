/**
 * @file delay-evidence.test.ts
 * @purpose Lock the extraction against the real vendor sentences that the old
 *          notes got wrong.
 * @author Hermia
 * @created 2026-11-09
 * @deps vitest, ./delay-evidence
 */

import { describe, expect, it } from "vitest";
import { cleanLine, formatDelayNote, isOurOwnSender, pickDelaySentence, stripQuotedText } from "./delay-evidence";

describe("pickDelaySentence", () => {
    it("finds the Certis backorder statement", () => {
        const body = "We've received your order and have placed it on backorder. Please note that product will be on backorder until August.\nI am sorry to say but we are now on backorder until January, 2027.";
        const s = pickDelaySentence(body);
        expect(s).toContain("January, 2027");
    });

    it("finds the Rapid Packaging ship date, not the small talk", () => {
        const body =
            "Sounds good! We will update you when the pallet arrives here and ships out.\n" +
            "Current ETA is 11/16 for arrival to our warehouse putting the ship-date as 11/17. We still have plenty of stock of the 35x35x46 bag.";
        const s = pickDelaySentence(body);
        expect(s).toContain("11/16");
        expect(s).toContain("ship-date");
    });

    it("ignores our own boilerplate and empty chatter", () => {
        expect(pickDelaySentence("[EXTERNAL EMAIL - ONLY OPEN ATTACHMENTS OR CLICK ON LINKS IF THIS EMAIL IS EXPECTED FROM A TRUSTED SOURCE]")).toBeNull();
        expect(pickDelaySentence("Thanks, talk soon.")).toBeNull();
    });
});

describe("formatDelayNote", () => {
    it("keeps the vendor wording and cites the mail date", () => {
        const note = formatDelayNote("I am sorry to say but we are now on backorder until January, 2027.", "2026-08-12");
        expect(note).toBe("We are now on backorder until January, 2027. (vendor 8/12)");
    });

    it("trims a long sentence rather than cutting the citation", () => {
        const note = formatDelayNote(
            "We have had some major production issues that have not allowed us to keep up with demand and we are very sorry about that and hope to be back soon.",
            "2026-09-28"
        );
        expect(note.endsWith("(vendor 9/28)")).toBe(true);
        expect(note.length).toBeLessThan(120);
    });
});

describe("cleanLine / sender", () => {
    it("strips quote markers", () => {
        expect(cleanLine(">>> I am sorry about the delays.")).toBe("I am sorry about the delays.");
    });

    it("recognises our own mail", () => {
        expect(isOurOwnSender("Bill Selee <bill.selee@buildasoil.com>")).toBe(true);
        expect(isOurOwnSender("Certis USA <orders@certisusa.com>")).toBe(false);
    });
});

describe("stripQuotedText", () => {
    it("drops quoted history so our own words are never attributed to the vendor", () => {
        const body =
            "I am sorry about the delays. We have had some major production issues.\n\n" +
            "On Mon, Sep 14, 2026 at 1:25 PM Bill Selee <bill.selee@buildasoil.com> wrote:\n" +
            "> Any update on tracking or an ETA?";
        const own = stripQuotedText(body);
        expect(own).toContain("sorry about the delays");
        expect(own).not.toContain("Any update");
    });

    it("keeps a vendor sentence that the quote scan would otherwise lose", () => {
        const body =
            "> > Any update on tracking or an ETA?\n" +
            "We are now on backorder until January, 2027.";
        expect(pickDelaySentence(stripQuotedText(body))).toContain("January, 2027");
    });
});
