/**
 * @file    email-reply-rules.test.ts
 * @purpose Unit tests for learned vendor reply rule store — pure inference +
 *          template application (no DB needed for these paths).
 */
import { describe, expect, it } from "vitest";
import {
    applyReplyTemplate,
    inferReplyContext,
    normalizeVendorKey,
} from "./email-reply-rules";

describe("normalizeVendorKey", () => {
    it("extracts domain from display-name form", () => {
        expect(normalizeVendorKey("Donna Padilla <donna@crminerals.com>")).toBe("crminerals.com");
    });

    it("extracts domain from bare address", () => {
        expect(normalizeVendorKey("donna@CRMINERALS.com")).toBe("crminerals.com");
    });

    it("returns the address when no @ present", () => {
        expect(normalizeVendorKey("some display name")).toBe("some display name");
    });
});

describe("inferReplyContext", () => {
    it("classifies PO acknowledgment", () => {
        expect(
            inferReplyContext("routine", "BuildASoil PO #125180 - CR Minerals", "Received with thanks!"),
        ).toBe("po_ack");
    });

    it("classifies tracking", () => {
        expect(
            inferReplyContext("routine", "Shipment update", "Your tracking number is 1Z999..."),
        ).toBe("tracking");
    });

    it("classifies invoice", () => {
        expect(
            inferReplyContext("routine", "Invoice 99122", "Total $5,965.74"),
        ).toBe("invoice");
    });

    it("classifies simple confirm", () => {
        expect(
            inferReplyContext("routine", "Re: order", "Sounds good! I'll send the invoice when restocked."),
        ).toBe("simple_confirm");
    });

    it("classifies human question", () => {
        expect(
            inferReplyContext("routine", "Question", "Can you confirm the delivery address?"),
        ).toBe("human_question");
    });

    it("classifies opportunity from kind", () => {
        expect(
            inferReplyContext("opportunity", "Pricing", "Tier 2 distributor pricing attached"),
        ).toBe("opportunity");
    });
});

describe("applyReplyTemplate", () => {
    it("substitutes {name} with first name", () => {
        expect(applyReplyTemplate("Thanks {name}", "Donna")).toBe("Thanks Donna");
    });

    it("substitutes case-insensitively", () => {
        expect(applyReplyTemplate("Thanks {Name}", "Lisa")).toBe("Thanks Lisa");
    });

    it("returns template verbatim when no name", () => {
        expect(applyReplyTemplate("Thanks {name}", "")).toBe("Thanks {name}");
    });
});
