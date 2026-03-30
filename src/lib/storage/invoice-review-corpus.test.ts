import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, upsertMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    upsertMock: vi.fn(),
}));

vi.mock("../supabase", () => ({
    createClient: createClientMock,
}));

import {
    buildInvoiceReviewSamplePayload,
    upsertInvoiceReviewSample,
} from "./invoice-review-corpus";

describe("invoice review corpus helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        upsertMock.mockResolvedValue({ data: { id: "sample-1" }, error: null });
        createClientMock.mockReturnValue({
            from: vi.fn(() => ({
                upsert: upsertMock.mockReturnValue({
                    select: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue({ data: { id: "sample-1" }, error: null }),
                    })),
                }),
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

    it("writes a review sample to supabase", async () => {
        const id = await upsertInvoiceReviewSample({
            vendorInvoiceId: "invoice-row-1",
            reviewStatus: "pending_review",
            reviewedFields: {
                vendorName: "Example Vendor",
                invoiceNumber: "INV-1",
            },
        });

        expect(id).toBe("sample-1");
        expect(createClientMock).toHaveBeenCalledTimes(1);
        expect(upsertMock).toHaveBeenCalledTimes(1);
        expect(upsertMock).toHaveBeenCalledWith(
            expect.objectContaining({
                vendor_invoice_id: "invoice-row-1",
                review_status: "pending_review",
                expected_vendor_name: "Example Vendor",
                expected_invoice_number: "INV-1",
            }),
            { onConflict: "vendor_invoice_id" },
        );
    });
});
