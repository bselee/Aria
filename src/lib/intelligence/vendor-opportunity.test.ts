/**
 * @file    vendor-opportunity.test.ts
 * @purpose Regression: American BioChar inquiry must never be treated as routine thanks.
 */
import { describe, expect, it } from "vitest";
import {
    detectVendorOpportunity,
    templateOpportunityDraft,
} from "./vendor-opportunity";

describe("detectVendorOpportunity", () => {
    it("flags the American BioChar pricing + tech sheet response as high-confidence opportunity", () => {
        const signal = detectVendorOpportunity({
            from: "Jessica Kusmiz <jessica@ambiochar.com>",
            subject: "response to your BioChar inquiry",
            bodyText: [
                "Hi Bill,",
                "Thank you so much for reaching out. I have attached our tier 2 distributor pricing schedule",
                "that lists all of our products including the NAKED Char and NAKED Char 5M.",
                "I've also included the tech sheets for both.",
                "Our BioChar is IBI certified, OMRI listed, and USDA Bio-preferred.",
                "I would love to schedule a call to address any additional questions and ideas.",
                "Jessica Kusmiz - product manager",
            ].join("\n"),
            hasPdf: true,
            pdfFilenames: [
                "2026 tier 2 distributor pricing.pdf",
                "NAKED Char tds.pdf",
                "NAKED Char 5M tds.pdf",
            ],
        });

        expect(signal.isOpportunity).toBe(true);
        expect(signal.highConfidence).toBe(true);
    });

    it("does not flag operational PO / tracking mail as opportunity", () => {
        const signal = detectVendorOpportunity({
            from: "cooper@sustainablevillage.com",
            subject: "BuildASoil PO # 125165 - Sustainable Village - 8/4/2026",
            bodyText: "Thanks Bill, PO acknowledged. Tracking will follow when shipped.",
            hasPdf: false,
        });
        expect(signal.isOpportunity).toBe(false);
    });

    it("does not flag pure invoices as opportunity", () => {
        const signal = detectVendorOpportunity({
            from: "billing@uline.com",
            subject: "Invoice 12345 for PO 124999",
            bodyText: "Please find attached your invoice. Amount due $420.00",
            hasPdf: true,
            pdfFilenames: ["invoice-12345.pdf"],
        });
        expect(signal.isOpportunity).toBe(false);
    });
});

describe("templateOpportunityDraft", () => {
    it("produces a short draft — not a monologue", () => {
        const draft = templateOpportunityDraft({
            from: "Jessica Kusmiz <jessica@ambiochar.com>",
            subject: "response to your BioChar inquiry",
            bodyText: "I would love to schedule a call. OMRI listed. Tier 2 distributor pricing attached.",
            pdfFilenames: ["2026 tier 2 distributor pricing.pdf", "NAKED Char tds.pdf"],
        });

        const bodyWords = draft.draftBody.split(/\s+/).length;
        expect(bodyWords).toBeLessThan(55);
        expect(draft.draftBody.toLowerCase()).not.toMatch(/^received, thank you!?$/);
        expect(draft.draftBody).toMatch(/Jessica/);
        expect(draft.draftBody).toMatch(/pric|tech|cert|materials/i);
        expect(draft.summaryForBill.length).toBeGreaterThan(10);
        expect(draft.nextAction.length).toBeGreaterThan(10);
    });
});
