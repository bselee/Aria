/**
 * @file    invoice-review-corpus.ts
 * @purpose Local SQLite-based invoice review corpus store.
 *          Replaces Supabase-based storage for invoice review samples.
 * @created 2026-07-01 — migrated from Supabase to SQLite
 * @deps    src/lib/storage/local-db.ts
 */

import { getLocalDb } from "./local-db";

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

function ensureTable(): void {
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS invoice_review_corpus (
            vendor_invoice_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

export async function upsertInvoiceReviewSample(input: InvoiceReviewSampleInput): Promise<string | null> {
    try {
        ensureTable();
        const db = getLocalDb();
        const payload = buildInvoiceReviewSamplePayload(input);

        db.prepare(`
            INSERT OR REPLACE INTO invoice_review_corpus (vendor_invoice_id, payload_json, updated_at)
            VALUES (?, ?, datetime('now'))
        `).run(input.vendorInvoiceId, JSON.stringify(payload));

        return input.vendorInvoiceId;
    } catch (err: any) {
        console.error("[invoice-review-corpus] Upsert failed:", err.message);
        return null;
    }
}
