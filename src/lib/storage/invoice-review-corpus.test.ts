import { beforeEach, describe, expect, it, vi } from "vitest";

// upsertInvoiceReviewSample now uses getLocalDb() (SQLite), not Supabase.
// Commit bd9caa3 (2026-07-01) migrated from Supabase to local SQLite.
const { getLocalDbMock, dbRunMock } = vi.hoisted(() => {
    const dbRunMock = vi.fn();
    const getLocalDbMock = vi.fn(() => ({
        exec: vi.fn(),
        prepare: vi.fn(() => ({
            run: dbRunMock,
        })),
    }));
    return { getLocalDbMock, dbRunMock };
});

vi.mock("./local-db", () => ({
    getLocalDb: getLocalDbMock,
}));

import {
    buildInvoiceReviewSamplePayload,
    upsertInvoiceReviewSample,
} from "./invoice-review-corpus";

describe("invoice review corpus helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbRunMock.mockReturnValue(undefined);
        getLocalDbMock.mockReturnValue({
            exec: vi.fn(),
            prepare: vi.fn(() => ({
                run: dbRunMock,
            })),
        });
    });

    it("builds a review sample payload from raw invoice references and reviewed truth", () => {
        const payload = buildInvoiceReviewSamplePayload({
            vendorInvoiceId: "invoice-row-1",
            pdfStoragePath: "vendor_invoices/msg-1-sample.pdf",
            gmailMessageId: "gmail-123",
            sourceRef: "email-billing@vendor.example",
            reviewStatus: "reviewed",
            reviewedBy: "Will",
            reviewedFields: {
                vendorName: "Coats Agri Aloe, Inc.",
                invoiceNumber: "1000930",
                poNumber: "124547",
                total: 4688.72,
                freight: 88.72,
                matchStatus: "matched",
            },
            firstPass: {
                strategy: "pdf-parse",
                confidence: "low",
                poNumber: null,
                vendorName: "UNKNOWN",
                total: 0,
                lineItemCount: 0,
            },
            retryPass: {
                strategy: "anthropic",
                confidence: "low",
                poNumber: "124547",
                vendorName: "Coats Agri Aloe, Inc.",
                total: 4688.72,
                lineItemCount: 2,
            },
        });

        expect(payload).toMatchObject({
            vendor_invoice_id: "invoice-row-1",
            pdf_storage_path: "vendor_invoices/msg-1-sample.pdf",
            gmail_message_id: "gmail-123",
            source_ref: "email-billing@vendor.example",
            review_status: "reviewed",
            reviewed_by: "Will",
            expected_vendor_name: "Coats Agri Aloe, Inc.",
            expected_invoice_number: "1000930",
            expected_po_number: "124547",
            expected_total: 4688.72,
            expected_freight: 88.72,
            expected_match_status: "matched",
            first_pass_strategy: "pdf-parse",
            retry_pass_strategy: "anthropic",
            retry_pass_po_number: "124547",
        });
        expect(payload.reviewed_at).toBeTruthy();
        expect(payload.created_at).toBeTruthy();
        expect(payload.updated_at).toBeTruthy();
    });

    it("writes a review sample to local SQLite and returns the vendorInvoiceId", async () => {
        const id = await upsertInvoiceReviewSample({
            vendorInvoiceId: "invoice-row-1",
            reviewStatus: "pending_review",
            reviewedFields: {
                vendorName: "Example Vendor",
                invoiceNumber: "INV-1",
            },
        });

        // After migration to SQLite (bd9caa3), the function returns input.vendorInvoiceId directly
        expect(id).toBe("invoice-row-1");
        // Called once in ensureTable() and once in upsertInvoiceReviewSample()
        expect(getLocalDbMock).toHaveBeenCalledTimes(2);
        expect(dbRunMock).toHaveBeenCalledTimes(1);
    });
});
