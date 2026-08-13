/**
 * @file    src/lib/intelligence/ap/vendor-invoice-patterns.test.ts
 * @purpose Unit tests for the declarative per-vendor invoice-number + bundle
 *          detection table. Every pattern in the table must fire correctly,
 *          the AAA Cooper individual-only rule must protect against bundle
 *          duplicates, and the generic fallback must preserve the historical
 *          subject-only extraction chain.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    @/lib/intelligence/ap/vendor-invoice-patterns
 */
import { describe, it, expect } from "vitest";
import {
    matchVendorInvoicePattern,
    extractInvoiceNumber,
    deriveCanonicalVendorName,
    isBundleEmail,
} from "./vendor-invoice-patterns";

// ─── Real senders observed in ap_local_forwards (2026-08-13) ────────────────
const AAA_COOPER_STMT = "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>";
const AAA_COOPER_REP = "Becky Seehaver <BECKY.SEEHAVER@aaacooper.com>";
const AAA_COOPER_CORR =
    "AAA Cooper Transportation <correspondence.aaacooper@jas.collectiontoolbox.com>";
const BELT_POWER = "\"Belt Power, LLC\" <remitto@beltpower.com>";

describe("extractInvoiceNumber — AAA Cooper Pro# (subject is the source of truth)", () => {
    it("'Invoice Stmt - Cust 0001159492 Pro#: 64058431' → 64058431", () => {
        // Spec test 1. Real subject from act.statement@aaacooper.com.
        expect(
            extractInvoiceNumber(AAA_COOPER_STMT, "Invoice Stmt - Cust 0001159492 Pro#: 64058431"),
        ).toBe("64058431");
    });

    it("bare subject '64471555' → 64471555", () => {
        // Spec test 2. Real subject from Becky Seehaver.
        expect(extractInvoiceNumber(AAA_COOPER_REP, "64471555")).toBe("64471555");
    });

    it("account-number decoy: Pro# group wins; '3746570' never mistaken for the Pro#", () => {
        // Spec test 9. OCR pulled "3746570" (AAA Cooper's ACCOUNT number, not an
        // invoice number). When a Pro#: group is present in the subject it must
        // win over any decoy digits — the pattern ORDER (Pro# first) guarantees it.
        expect(
            extractInvoiceNumber(
                AAA_COOPER_STMT,
                "Invoice Stmt - Cust 0001159492 Acct 3746570 Pro#: 64058431",
            ),
        ).toBe("64058431");
        expect(
            extractInvoiceNumber(AAA_COOPER_STMT, "Invoice Stmt - Cust 0001159492 Pro#: 64058431"),
        ).not.toBe("3746570");
        // Bundle subject whose digits are an account/cust number, not an invoice#:
        expect(extractInvoiceNumber(AAA_COOPER_CORR, "Account 1159492 - BUILDASOIL")).toBeUndefined();
    });
});

describe("extractInvoiceNumber — Belt Power", () => {
    it("'Belt Power, LLC - Invoice# 3198860 Belt Power Invoice' → 3198860", () => {
        // Spec test 6. Real subject from remitto@beltpower.com.
        expect(extractInvoiceNumber(BELT_POWER, "Belt Power, LLC - Invoice# 3198860 Belt Power Invoice")).toBe(
            "3198860",
        );
    });

    it("'Invoice 3196029 Reminder from Belt Power, LLC' → 3196029", () => {
        // Real subject from beltpowerar@beltpower.com (reminders still forward).
        expect(extractInvoiceNumber("Belt Power AR <beltpowerar@beltpower.com>", "Invoice 3196029 Reminder from Belt Power, LLC")).toBe(
            "3196029",
        );
    });
});

describe("extractInvoiceNumber — generic fallback (no vendor row)", () => {
    it("unknown vendor 'Invoice #12345' → 12345", () => {
        // Spec test 7.
        expect(extractInvoiceNumber("some-vendor@example.com", "Invoice #12345")).toBe("12345");
    });

    it("no vendor: Pro# / bare-digit subjects still extract (historical subject-only chain)", () => {
        // The forwarder's subject-only helper has no sender context; the generic
        // chain must keep the historical Pro# → bare → invoice behaviour so the
        // dedup vendor+invoice# gate keeps firing for AAA Cooper.
        expect(extractInvoiceNumber("", "Invoice Stmt - Cust 0001159492 Pro#: 64058431")).toBe("64058431");
        expect(extractInvoiceNumber("", "64471555")).toBe("64471555");
        expect(extractInvoiceNumber("", "Invoice #12345")).toBe("12345");
    });

    it("no invoice number in subject → undefined", () => {
        expect(extractInvoiceNumber("", "RE: Need remittance")).toBeUndefined();
        expect(extractInvoiceNumber("", "Account 1159492 - BUILDASOIL")).toBeUndefined();
    });
});

describe("deriveCanonicalVendorName", () => {
    it("act.statement@aaacooper.com → 'AAA Cooper Transportation'", () => {
        // Spec test 8.
        expect(deriveCanonicalVendorName("act.statement@aaacooper.com")).toBe("AAA Cooper Transportation");
    });

    it("'AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>' → AAA Cooper via display name", () => {
        expect(deriveCanonicalVendorName(AAA_COOPER_STMT)).toBe("AAA Cooper Transportation");
    });

    it("beltpower sender → 'Belt Power'", () => {
        expect(deriveCanonicalVendorName("beltpowerar@beltpower.com")).toBe("Belt Power");
    });

    it("unknown sender → undefined", () => {
        expect(deriveCanonicalVendorName("random@vendor.com")).toBeUndefined();
        expect(deriveCanonicalVendorName("")).toBeUndefined();
    });
});

describe("isBundleEmail — AAA Cooper individual-only rule (spec tests 3-5)", () => {
    it("'Account 1159492 - BUILDASOIL' from aaacooper → bundle", () => {
        // Real correspondence bundle subject (jas.collectiontoolbox.com).
        expect(isBundleEmail(AAA_COOPER_CORR, "Account 1159492 - BUILDASOIL")).toBe(true);
    });

    it("'RE: Need remittance' from aaacooper → bundle", () => {
        // Real reply thread from Becky Seehaver.
        expect(isBundleEmail(AAA_COOPER_REP, "RE: Need remittance")).toBe(true);
    });

    it("'Invoice Stmt - Cust 0001159492 Pro#: 64058431' from aaacooper → NOT a bundle", () => {
        expect(isBundleEmail(AAA_COOPER_STMT, "Invoice Stmt - Cust 0001159492 Pro#: 64058431")).toBe(false);
    });

    it("bare '64471555' from aaacooper → NOT a bundle", () => {
        expect(isBundleEmail(AAA_COOPER_REP, "64471555")).toBe(false);
    });

    it("anything else from aaacooper is a bundle — that is what stops the duplicates", () => {
        expect(isBundleEmail(AAA_COOPER_STMT, "Statement of Account")).toBe(true);
        expect(isBundleEmail(AAA_COOPER_REP, "Need remittance")).toBe(true);
    });
});

describe("isBundleEmail — generic bundle signatures apply to ALL vendors", () => {
    it("unknown vendor, 'Account 12345 - FOO' subject → bundle", () => {
        expect(isBundleEmail("unknown@vendor.com", "Account 12345 - FOO")).toBe(true);
    });

    it("unknown vendor, 'Correspondence' in subject → bundle", () => {
        expect(isBundleEmail("unknown@vendor.com", "Correspondence re: invoice 12345")).toBe(true);
    });

    it("unknown vendor, plain invoice subject → NOT a bundle", () => {
        expect(isBundleEmail("unknown@vendor.com", "Invoice #12345")).toBe(false);
        expect(isBundleEmail("unknown@vendor.com", "")).toBe(false);
    });
});

describe("matchVendorInvoicePattern", () => {
    it("aaacooper sender → aaacooper row", () => {
        expect(matchVendorInvoicePattern(AAA_COOPER_STMT)?.vendorKey).toBe("aaacooper");
        expect(matchVendorInvoicePattern(AAA_COOPER_STMT)?.canonicalName).toBe("AAA Cooper Transportation");
    });

    it("beltpower sender → beltpower row", () => {
        expect(matchVendorInvoicePattern(BELT_POWER)?.vendorKey).toBe("beltpower");
        expect(matchVendorInvoicePattern(BELT_POWER)?.canonicalName).toBe("Belt Power");
    });

    it("unknown sender → null", () => {
        expect(matchVendorInvoicePattern("random@vendor.com")).toBeNull();
    });
});

describe("regression — ap_local_forwards observed subjects (spec test 10)", () => {
    it("3 bundle subjects are bundles; 2 individual subjects are not — byte-identical to production", () => {
        const bundles: Array<[string, string]> = [
            ["Account 1159492 - BUILDASOIL", AAA_COOPER_CORR],
            ["RE: Need remittance", AAA_COOPER_REP],
            ["RE: Buildasoil", AAA_COOPER_REP],
        ];
        for (const [subject, from] of bundles) {
            expect(isBundleEmail(from, subject), `bundle subject: ${subject}`).toBe(true);
        }

        const individuals: Array<[string, string]> = [
            ["Invoice Stmt - Cust 0001159492 Pro#: 64058431", AAA_COOPER_STMT],
            ["64471555", AAA_COOPER_REP],
        ];
        for (const [subject, from] of individuals) {
            expect(isBundleEmail(from, subject), `individual subject: ${subject}`).toBe(false);
            // Individual invoices always yield a real invoice number from the subject.
            expect(extractInvoiceNumber(from, subject), `invoice# for: ${subject}`).toBeTruthy();
        }
    });
});
