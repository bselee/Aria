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
import { isFedExFreightOnlineBill } from "@/lib/intelligence/ap/fedex-billing-packet";
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

    // ── FedEx is not a Bill.com bill (Bill 2026-09-23) ────────────────
    it("skips FedEx Billing Online invoice-attached email", () => {
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

    it("skips an internal forward of a FedEx Billing Online invoice", () => {
        expect(
            isNonInvoiceEmail({
                from: "BuildASoil Support <support@buildasoil.com>",
                subject: "Fwd: Your New FedEx Billing Online invoice is attached",
            }),
        ).toBe(true);
    });

    it("ALLOWS a vendor invoice that only mentions FedEx tracking", () => {
        expect(
            isNonInvoiceEmail({
                from: "accounts.receivable@uline.com",
                subject: "Uline Invoice 211897049 shipped via FedEx",
            }),
        ).toBe(false);
    });

    // Real mail the 2026-10-07 catch-up pass pulled in (ledger rows 928, 932, 933,
    // 934). The widened ingest must not create a FedEx path into Bill.com.
    it("skips FedEx account/reward mail the catch-up pass now sees", () => {
        const fedex = [
            { from: "FedEx Rewards <noreply@rewardcatalog.fedex.com>", subject: "Thank you for your order!" },
            { from: "FedEx Rewards <no-reply-rewardscatalog@fedex.com>", subject: "Your Reward Has Arrived" },
            { from: "FedEx <FedEx@message.fedex.com>", subject: "Your FedEx Report Is Ready" },
        ];
        for (const m of fedex) {
            expect(isNonInvoiceEmail({ from: m.from, subject: m.subject }), `${m.from} / ${m.subject}`).toBe(true);
        }
    });

    // Documents the boundary honestly: a Stripe receipt is NOT gated by the
    // sender/subject rule. It is stopped later by the no-invoice-attachment check
    // (ledger row 932: "no PDF/image invoice attachment"). If a future receipt mail
    // ever carries an invoice PDF, that attachment check no longer protects it.
    it("does not gate a Stripe receipt on the sender rule (stopped by the attachment check)", () => {
        expect(
            isNonInvoiceEmail({
                from: "The Amazing Doctor Zymes <receipts+acct_1PXRf@stripe.com>",
                subject: "Your The Amazing Doctor Zymes refund [#3478-6844]",
            }),
        ).toBe(false);
    });

    // ── FedEx Freight LTL (billed online, never entered in Bill.com) ──────
    // Bill, 2026-09-21: acct 646135168 bills are paid online. Real rows from
    // ap_local_forwards (ids 782, 783) forwarded 2026-09-21.
    it("skips FedEx Freight online bill notice (acct 646135168)", () => {
        expect(
            isNonInvoiceEmail({
                from: "BuildASoil Support <support@buildasoil.com>",
                subject:
                    "Fwd: Acct No. 646135168: Your Bill from FedEx Freight is Available Online - No Action Required",
            }),
        ).toBe(true);
    });

    it("skips FedEx Freight statement attachment by filename", () => {
        expect(
            isFedExFreightOnlineBill({
                from: "BuildASoil Support <support@buildasoil.com>",
                subject: "Fwd: FedEx Freight bill",
                filename: "fedex_646135168_20260921_10340598_4926466165.pdf",
                invoiceNumber: "300408064402",
            }),
        ).toBe(true);
    });

    // Freight detector stays narrow. Parcel is excluded by isFedExExcludedFromBillCom,
    // not by this helper. A parcel 9-XXX number must not look like Freight.
    it("ALLOWS FedEx Billing Online parcel invoice (9-XXX-XXXXX)", () => {
        expect(
            isFedExFreightOnlineBill({
                from: "FedEx Billing Online <noreply@fedex.com>",
                subject: "Your New FedEx Billing Online invoice is attached",
                filename: "FedEx_Ground_9-462-62548.pdf",
                invoiceNumber: "9-462-62548",
            }),
        ).toBe(false);
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
