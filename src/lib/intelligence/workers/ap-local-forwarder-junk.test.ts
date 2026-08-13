/**
 * @file    ap-local-forwarder-junk.test.ts
 * @purpose Unit tests for isNonInvoiceEmail — the exported pre-send junk gate
 *          in ap-local-forwarder.ts. Every fixture below is a REAL row
 *          observed in ap_local_forwards (2026-08-13 audit: 37 of 106
 *          FORWARDED rows were not invoices), sender + subject verbatim.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    vitest, ap-local-forwarder.ts (pure helpers only — no Gmail/DB)
 */

import { describe, expect, it } from "vitest";
import { isNonInvoiceEmail } from "./ap-local-forwarder";

describe("isNonInvoiceEmail — junk pre-send gate", () => {
    // ── AAA Cooper remittance threads (must skip) ─────────────────────────
    it("skips AAA Cooper RE: remittance thread (Becky Seehaver)", () => {
        expect(
            isNonInvoiceEmail({
                from: "Becky Seehaver <BECKY.SEEHAVER@aaacooper.com>",
                subject: "RE: Need remittance",
            }),
        ).toBe(true);
    });

    it("skips AAA Cooper account correspondence bundle (no Invoice Stmt / Pro#)", () => {
        expect(
            isNonInvoiceEmail({
                from: "AAA Cooper Transportation <correspondence.aaacooper@jas.collectiontoolbox.com>",
                subject: "Account 1159492 - BUILDASOIL",
            }),
        ).toBe(true);
    });

    it("ALLOWS AAA Cooper individual invoice stmt with Pro#", () => {
        expect(
            isNonInvoiceEmail({
                from: "act.statement@aaacooper.com",
                subject: "Invoice Stmt - Cust 0001159492 Pro#: 35943009",
            }),
        ).toBe(false);
    });

    // ── FedEx Billing Online statement packets (must skip) ────────────────
    it("skips FedEx Billing Online invoice-attached email (multi-invoice statement packet)", () => {
        expect(
            isNonInvoiceEmail({
                from: "FedEx Billing Online <noreply@fedex.com>",
                subject: "Your New FedEx Billing Online invoice is attached",
            }),
        ).toBe(true);
    });

    it("skips FedEx Billing Online past-due notice", () => {
        expect(
            isNonInvoiceEmail({
                from: "BillingOnline <BillingOnline@fedex.com>",
                subject: "FedEx Billing Online - Invoice(s) Past Due",
            }),
        ).toBe(true);
    });

    // ── Vendor order acknowledgments (must skip) ──────────────────────────
    it("skips BFG order acknowledgment (not an invoice)", () => {
        expect(
            isNonInvoiceEmail({
                from: "BFG Supply Customer Relations <customerrelations@bfgsupply.com>",
                subject: "Acknowledgment for OrderNumber: 3259787-00 has been created.",
            }),
        ).toBe(true);
    });

    // ── Due notices vs real invoices (must skip the notice, allow the invoice)
    it("skips Uline notice of invoice due (the notice, not the invoice PDF)", () => {
        expect(
            isNonInvoiceEmail({
                from: "noreply@ar.uline.com",
                subject: "Notice of Invoice Due ID: 16 C# (9897269)",
            }),
        ).toBe(true);
    });

    it("ALLOWS real Uline invoice email", () => {
        expect(
            isNonInvoiceEmail({
                from: "accounts.receivable@uline.com",
                subject: "Uline Invoice 211897049 ID# 16",
            }),
        ).toBe(false);
    });

    // ── Credit memos (must skip — negative documents are not bills) ───────
    it("skips Evergreen credit memo", () => {
        expect(
            isNonInvoiceEmail({
                from: "<order@evergreengrowers.com>",
                subject: "Credit Memo 149505 from Evergreen Growers Supply",
            }),
        ).toBe(true);
    });

    // ── Account-management correspondence (must skip) ─────────────────────
    it("skips Berger urgent-update correspondence", () => {
        expect(
            isNonInvoiceEmail({
                from: "Lucy DeLuca <lucyd@berger.ca>",
                subject: "BUISA1 - URGENT UPDATE REQUIRED",
            }),
        ).toBe(true);
    });

    // ── Regression guards: over-broad rules must not block real invoices ──
    it("ALLOWS a plain generic invoice subject", () => {
        expect(
            isNonInvoiceEmail({
                from: "vendor-accounts@example.com",
                subject: "Invoice #12345",
            }),
        ).toBe(false);
    });

    it("ALLOWS an invoice-numbered reply thread (RE: is only junk for bundle vendors)", () => {
        expect(
            isNonInvoiceEmail({
                from: "accounts.receivable@uline.com",
                subject: "RE: Uline Invoice 211897049 ID# 16",
            }),
        ).toBe(false);
    });
});
