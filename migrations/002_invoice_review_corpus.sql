CREATE TABLE IF NOT EXISTS invoice_review_corpus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_invoice_id UUID NOT NULL,
    pdf_storage_path TEXT,
    gmail_message_id TEXT,
    source_ref TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    expected_vendor_name TEXT,
    expected_invoice_number TEXT,
    expected_po_number TEXT,
    expected_invoice_date DATE,
    expected_total DECIMAL(12, 2),
    expected_freight DECIMAL(12, 2),
    expected_tax DECIMAL(12, 2),
    expected_line_item_count INTEGER,
    expected_match_status TEXT,
    expected_order_id TEXT,
    first_pass_strategy TEXT,
    first_pass_confidence TEXT,
    first_pass_po_number TEXT,
    first_pass_vendor_name TEXT,
    first_pass_total DECIMAL(12, 2),
    first_pass_line_item_count INTEGER,
    retry_pass_strategy TEXT,
    retry_pass_confidence TEXT,
    retry_pass_po_number TEXT,
    retry_pass_vendor_name TEXT,
    retry_pass_total DECIMAL(12, 2),
    retry_pass_line_item_count INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT invoice_review_corpus_vendor_invoice_unique UNIQUE (vendor_invoice_id)
);

CREATE INDEX IF NOT EXISTS invoice_review_corpus_status_idx
    ON invoice_review_corpus(review_status);

CREATE INDEX IF NOT EXISTS invoice_review_corpus_expected_po_idx
    ON invoice_review_corpus(expected_po_number);
