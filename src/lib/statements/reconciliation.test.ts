import { describe, expect, it } from "vitest";

import type { NormalizedStatement, StatementReconciliationLineResult } from "./types";
import { reconcileStatementAgainstInvoices } from "./reconciliation";

function makeStatement(
    line: NormalizedStatement["lines"][number],
): NormalizedStatement {
    return {
        vendorName: "FedEx",
        statementDate: "2026-03-31",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        accountNumber: "ACCT-1",
        totals: {
            openingBalance: 0,
            totalCharges: 120,
            totalCredits: 0,
            endingBalance: 120,
        },
        lines: [line],
        sourceMeta: {
            adapterKey: "fedex_download",
            sourceRef: "FEDEX_MARCH.csv",
        },
    };
}

describe("reconcileStatementAgainstInvoices", () => {
    it("verifies an exact vendor + invoice-number + amount match", () => {
        const result = reconcileStatementAgainstInvoices(
            makeStatement({
                referenceNumber: "INV-100",
                documentType: "invoice",
                date: "2026-03-15",
                amount: 120,
                balance: 120,
            }),
            [
                {
                    id: "vi_1",
                    vendor_name: "FedEx",
                    invoice_number: "INV-100",
                    invoice_date: "2026-03-15",
                    po_number: "PO-100",
                    total: 120,
                },
            ],
        );

        expect(result.summary.matchedCount).toBe(1);
        expect(result.summary.mismatchCount).toBe(0);
        expect(result.lines[0]).toMatchObject<Partial<StatementReconciliationLineResult>>({
            status: "verified",
            matchedInvoiceIds: ["vi_1"],
        });
    });

    it("flags amount mismatches when the invoice number matches but totals differ", () => {
        const result = reconcileStatementAgainstInvoices(
            makeStatement({
                referenceNumber: "INV-100",
                documentType: "invoice",
                date: "2026-03-15",
                amount: 150,
                balance: 150,
            }),
            [
                {
                    id: "vi_1",
                    vendor_name: "FedEx",
                    invoice_number: "INV-100",
                    invoice_date: "2026-03-15",
                    po_number: "PO-100",
                    total: 120,
                },
            ],
        );

        expect(result.summary.mismatchCount).toBe(1);
        expect(result.lines[0]).toMatchObject<Partial<StatementReconciliationLineResult>>({
            status: "amount_mismatch",
            matchedInvoiceIds: ["vi_1"],
        });
    });

    it("flags duplicate candidates when multiple archived invoices match the same statement line", () => {
        const result = reconcileStatementAgainstInvoices(
            makeStatement({
                referenceNumber: "INV-100",
                documentType: "invoice",
                date: "2026-03-15",
                amount: 120,
                balance: 120,
            }),
            [
                {
                    id: "vi_1",
                    vendor_name: "FedEx",
                    invoice_number: "INV-100",
                    invoice_date: "2026-03-15",
                    po_number: "PO-100",
                    total: 120,
                },
                {
                    id: "vi_2",
                    vendor_name: "FedEx",
                    invoice_number: "INV-100",
                    invoice_date: "2026-03-16",
                    po_number: "PO-101",
                    total: 120,
                },
            ],
        );

        expect(result.summary.duplicateCount).toBe(1);
        expect(result.lines[0]).toMatchObject<Partial<StatementReconciliationLineResult>>({
            status: "duplicate_candidate",
            matchedInvoiceIds: ["vi_1", "vi_2"],
        });
    });

    it("falls back to needs_review for weak partial matches instead of forcing a match", () => {
        const result = reconcileStatementAgainstInvoices(
            makeStatement({
                referenceNumber: "",
                documentType: "invoice",
                date: "2026-03-15",
                amount: 120,
                balance: 120,
                poNumber: "PO-100",
            }),
            [
                {
                    id: "vi_1",
                    vendor_name: "FedEx",
                    invoice_number: "INV-100",
                    invoice_date: "2026-03-11",
                    po_number: "PO-100",
                    total: 120,
                },
                {
                    id: "vi_2",
                    vendor_name: "FedEx",
                    invoice_number: "INV-101",
                    invoice_date: "2026-03-18",
                    po_number: "PO-100",
                    total: 120,
                },
            ],
        );

        expect(result.summary.needsReviewCount).toBe(1);
        expect(result.lines[0]).toMatchObject<Partial<StatementReconciliationLineResult>>({
            status: "needs_review",
            matchedInvoiceIds: ["vi_1", "vi_2"],
        });
    });
});
