/**
 * @file    src/lib/intelligence/workers/ap-local-forwarder.suspect.test.ts
 * @purpose Unit tests for the suspect-subject classifier (2026-09-17 plan 4.1).
 *          Suspect subjects — dispute letters, dunning notices, remittance
 *          advice, payment receipts — carry an attachment that LOOKS like an
 *          invoice but is not a payable. They are still forwarded (never
 *          blocked) and flagged `suspect:<reason>` so the morning health report
 *          and the weekly reconcile surface them for human review.
 * @author  Hermia
 * @created 2026-09-17
 */

import { describe, expect, it } from "vitest";
import { suspectSubjectReason } from "./ap-local-forwarder";

describe("suspectSubjectReason", () => {
    // ── Real subjects that slipped through every existing gate ──────────────
    it("flags the FedEx Freight 'vs' claim letter (id 741)", () => {
        expect(suspectSubjectReason("FedEx Freight vs Buildasoil LLC File# 20056901")).toBe(
            "dispute-letter",
        );
    });

    it("flags the 'Notice of Invoice Due' dunning notice (id 704)", () => {
        expect(suspectSubjectReason("Notice of Invoice Due ID: 16 C# (9897269)")).toBe(
            "dunning-notice",
        );
    });

    it("flags a payment-information document", () => {
        expect(suspectSubjectReason("US Payment information PDF")).toBe("payment-doc");
        expect(suspectSubjectReason("Your payment receipt is attached")).toBe("payment-doc");
    });

    it("flags remittance advice", () => {
        expect(suspectSubjectReason("Remittance Advice for invoice 12345")).toBe("remittance");
    });

    it("flags past-due and collection notices", () => {
        expect(suspectSubjectReason("PAST DUE INVOICE GY-098644-01")).toBe("past-due");
        expect(suspectSubjectReason("Final Notice — account 9897269")).toBe("collection-letter");
    });

    it("flags statements of account", () => {
        expect(suspectSubjectReason("Statement of Account — August 2026")).toBe(
            "statement-of-account",
        );
    });

    // ── Must NOT flag real invoices (a false positive costs a manual review) ──
    it("does not flag a AAA Cooper invoice/stmt subject with a Pro#", () => {
        expect(
            suspectSubjectReason("Invoice Stmt - Cust 0001159492 Pro#: 64058907"),
        ).toBeNull();
    });

    it("does not flag a FedEx Billing Online invoice", () => {
        expect(suspectSubjectReason("Your New FedEx Billing Online invoice is attached")).toBeNull();
    });

    it("does not flag a dropship payment request that carries a real invoice", () => {
        expect(
            suspectSubjectReason("New payment request from AutoPot USA - Invoice APUS-247442"),
        ).toBeNull();
    });

    it("handles null/empty subjects", () => {
        expect(suspectSubjectReason(null)).toBeNull();
        expect(suspectSubjectReason(undefined)).toBeNull();
        expect(suspectSubjectReason("")).toBeNull();
    });
});
