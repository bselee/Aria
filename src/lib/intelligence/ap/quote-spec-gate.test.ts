/**
 * @file    src/lib/intelligence/ap/quote-spec-gate.test.ts
 * @purpose Unit tests for the quote/spec-sheet gate. Every fixture is a REAL
 *          attachment from the Century Equipment (peter.capone@centuryeq.com)
 *          thread forwarded to Bill.com on 2026-09-16/17 and flagged as
 *          MISSING/OCR_SUSPECT by reconcile-billcom on 2026-09-21.
 * @author  Hermia
 * @created 2026-09-21
 * @deps    vitest, quote-spec-gate.ts (pure)
 */

import { describe, expect, it } from "vitest";
import { isQuoteOrSpecDocument, isQuoteOrSpecName, isQuoteOrSpecText } from "./quote-spec-gate";

describe("isQuoteOrSpecName — filename/subject gate", () => {
    it("skips Century Equipment quote PDF", () => {
        expect(
            isQuoteOrSpecName({
                subject: "Fwd: Century Equipment",
                filename: "Nick Schwab Used 2024 CX50 quote 9-10.pdf",
            }),
        ).toBe(true);
    });

    it("skips Century Equipment spec sheets", () => {
        for (const filename of [
            "CX37C specs.pdf",
            "CX50D Specs.pdf",
            "580SN spec.pdf",
            "UTILITY PLUS 575N spec.pdf",
        ]) {
            expect(isQuoteOrSpecName({ subject: "Fwd: Century Equipment", filename })).toBe(true);
        }
    });

    it("skips Century Equipment second quote PDF", () => {
        expect(
            isQuoteOrSpecName({
                subject: "Fwd: Century Equipment",
                filename: "Nick Schwab 2025 575n CP PC quote 9-10.pdf",
            }),
        ).toBe(true);
    });

    it("skips Century Equipment backhoe quote", () => {
        expect(
            isQuoteOrSpecName({
                subject: "Fwd: Century Equipment",
                filename: "Nick Schwab 2012 used 580 Backhoe Quote.pdf",
            }),
        ).toBe(true);
    });

    it("ALLOWS the real Century Equipment invoice (GJ17176-1)", () => {
        expect(
            isQuoteOrSpecDocument({
                subject: "Century Equipment Invoice",
                filename: "Build A Soil invoice 9-17-26.pdf",
            }),
        ).toBe(false);
    });

    it("ALLOWS a quote-converted vendor invoice (invoice signal wins)", () => {
        expect(
            isQuoteOrSpecName({ subject: "Invoice 88421", filename: "Quote_88421_INVOICE.pdf" }),
        ).toBe(false);
    });
});

describe("isQuoteOrSpecText — ambiguous filename, decide on document text", () => {
    it("skips spec text with no payable signal", () => {
        expect(
            isQuoteOrSpecText({
                pdfText: "JOHN DEERE CX37C SPECIFICATIONS Engine: 74 hp. Operating weight 12000 lb.",
            }),
        ).toBe(true);
    });

    it("ALLOWS text that carries a total due (real bill)", () => {
        expect(
            isQuoteOrSpecText({
                pdfText: "SPECIFICATIONS per contract. Total Due: $9,638.89 Please pay by 10/17/2026.",
            }),
        ).toBe(false);
    });

    it("ALLOWS too little text to judge (scanned invoice)", () => {
        expect(isQuoteOrSpecText({ pdfText: "spec" })).toBe(false);
    });
});
