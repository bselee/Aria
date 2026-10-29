/**
 * @file    src/lib/purchasing/po-match-provenance.test.ts
 * @purpose Pin the match-provenance module: HOW an invoice→PO link was made is
 *          surfaced so a human can tell a deterministic match from a guess.
 *          Pure functions only — no DB, no Finale.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    po-match-provenance
 */
import { describe, expect, it } from "vitest";

import {
    confirmedPairKey,
    inferLinkedPoMatchMethod,
    isSolidMatchMethod,
    PO_MATCH_METHOD_LABELS,
} from "./po-match-provenance";

describe("isSolidMatchMethod", () => {
    it("treats deterministic methods as solid", () => {
        expect(isSolidMatchMethod("exact_po")).toBe(true);
        expect(isSolidMatchMethod("sku_exact")).toBe(true);
        expect(isSolidMatchMethod("confirmed")).toBe(true);
    });

    it("treats guessed/unrecorded methods as not solid", () => {
        expect(isSolidMatchMethod("vendor_date")).toBe(false);
        expect(isSolidMatchMethod("fast_path")).toBe(false);
        expect(isSolidMatchMethod("unknown")).toBe(false);
        expect(isSolidMatchMethod(null)).toBe(false);
        expect(isSolidMatchMethod(undefined)).toBe(false);
    });

    it("has a label for every method", () => {
        for (const key of Object.keys(PO_MATCH_METHOD_LABELS)) {
            expect(PO_MATCH_METHOD_LABELS[key as keyof typeof PO_MATCH_METHOD_LABELS].label.length).toBeGreaterThan(0);
        }
    });
});

describe("inferLinkedPoMatchMethod", () => {
    it("is exact_po when the printed PO equals the linked PO", () => {
        expect(
            inferLinkedPoMatchMethod({ poNumber: "125429", ocrPoCandidate: "125429" }),
        ).toBe("exact_po");
        expect(
            inferLinkedPoMatchMethod({ poNumber: "125429", ocrPoCandidate: "PO125429" }),
        ).toBe("exact_po");
    });

    it("is confirmed when the vendor→PO pair was human-confirmed", () => {
        expect(
            inferLinkedPoMatchMethod({
                poNumber: "125429",
                vendorName: "ULINE",
                confirmedPairs: new Set(["uline::125429"]),
            }),
        ).toBe("confirmed");
    });

    it("is unknown otherwise — it never guesses vendor+date", () => {
        expect(
            inferLinkedPoMatchMethod({ poNumber: "125429", vendorName: "ULINE" }),
        ).toBe("unknown");
        expect(inferLinkedPoMatchMethod({ poNumber: null })).toBe("unknown");
    });
});

describe("confirmedPairKey", () => {
    it("is case-insensitive and whitespace-tolerant", () => {
        expect(confirmedPairKey("ULINE", "125429")).toBe("uline::125429");
        expect(confirmedPairKey(" Uline ", " 125429 ")).toBe("uline::125429");
        expect(confirmedPairKey("", "125429")).toBe("");
    });
});
