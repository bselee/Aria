import { createClient } from "../supabase";

export interface ReviewedInvoiceFields {
    vendorName?: string | null;
    invoiceNumber?: string | null;
    poNumber?: string | null;
    invoiceDate?: string | null;
    total?: number | null;
    freight?: number | null;
    tax?: number | null;
    lineItemCount?: number | null;
    matchStatus?: string | null;
    matchedOrderId?: string | null;
}

export interface ExtractionPassSummary {
    strategy?: string | null;
    confidence?: string | null;
    poNumber?: string | null;
    vendorName?: string | null;
    total?: number | null;
    lineItemCount?: number | null;
}

export interface InvoiceReviewSampleInput {
    vendorInvoiceId: string;
    pdfStoragePath?: string | null;
    gmailMessageId?: string | null;
    sourceRef?: string | null;
    reviewStatus: "pending_review" | "reviewed" | "rejected";
    reviewedBy?: string | null;
    reviewedFields: ReviewedInvoiceFields;
    firstPass?: ExtractionPassSummary | null;
    retryPass?: ExtractionPassSummary | null;
    notes?: string | null;
}

export function buildInvoiceReviewSamplePayload(input: InvoiceReviewSampleInput) {
    const now = new Date().toISOString();
    return {
        vendor_invoice_id: input.vendorInvoiceId,
        pdf_storage_path: input.pdfStoragePath ?? null,
        gmail_message_id: input.gmailMessageId ?? null,
        source_ref: input.sourceRef ?? null,
        review_status: input.reviewStatus,
        reviewed_by: input.reviewedBy ?? null,
        reviewed_at: input.reviewStatus === "reviewed" ? now : null,
        expected_vendor_name: input.reviewedFields.vendorName ?? null,
        expected_invoice_number: input.reviewedFields.invoiceNumber ?? null,
        expected_po_number: input.reviewedFields.poNumber ?? null,
        expected_invoice_date: input.reviewedFields.invoiceDate ?? null,
        expected_total: input.reviewedFields.total ?? null,
        expected_freight: input.reviewedFields.freight ?? null,
        expected_tax: input.reviewedFields.tax ?? null,
        expected_line_item_count: input.reviewedFields.lineItemCount ?? null,
        expected_match_status: input.reviewedFields.matchStatus ?? null,
        expected_order_id: input.reviewedFields.matchedOrderId ?? null,
        first_pass_strategy: input.firstPass?.strategy ?? null,
        first_pass_confidence: input.firstPass?.confidence ?? null,
        first_pass_po_number: input.firstPass?.poNumber ?? null,
        first_pass_vendor_name: input.firstPass?.vendorName ?? null,
        first_pass_total: input.firstPass?.total ?? null,
        first_pass_line_item_count: input.firstPass?.lineItemCount ?? null,
        retry_pass_strategy: input.retryPass?.strategy ?? null,
        retry_pass_confidence: input.retryPass?.confidence ?? null,
        retry_pass_po_number: input.retryPass?.poNumber ?? null,
        retry_pass_vendor_name: input.retryPass?.vendorName ?? null,
        retry_pass_total: input.retryPass?.total ?? null,
        retry_pass_line_item_count: input.retryPass?.lineItemCount ?? null,
        notes: input.notes ?? null,
        created_at: now,
        updated_at: now,
    };
}

export async function upsertInvoiceReviewSample(input: InvoiceReviewSampleInput): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) {
        console.warn("[invoice-review-corpus] Supabase unavailable");
        return null;
    }

    const payload = buildInvoiceReviewSamplePayload(input);
    const { data, error } = await supabase
        .from("invoice_review_corpus")
        .upsert(payload, { onConflict: "vendor_invoice_id" })
        .select("id")
        .single();

    if (error) {
        console.error("[invoice-review-corpus] Upsert failed:", error.message);
        return null;
    }

    return data?.id ?? null;
}
