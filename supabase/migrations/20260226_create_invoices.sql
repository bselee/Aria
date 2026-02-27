-- Migration: Create invoices table
-- Created: 2026-02-26
-- Purpose: Base table for storing parsed invoice data from AP Agent processing.
--          Supports invoice → PO reconciliation, vendor intelligence, and audit trail.
-- Rollback: DROP TABLE IF EXISTS invoices;
CREATE TABLE IF NOT EXISTS invoices (
    id BIGSERIAL PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    vendor_name TEXT,
    po_number TEXT,
    invoice_date TEXT,
    due_date TEXT,
    payment_terms TEXT,
    subtotal NUMERIC(12, 2) DEFAULT 0,
    freight NUMERIC(12, 2) DEFAULT 0,
    tax NUMERIC(12, 2) DEFAULT 0,
    total NUMERIC(12, 2) DEFAULT 0,
    amount_due NUMERIC(12, 2) DEFAULT 0,
    status TEXT DEFAULT 'unmatched',
    discrepancies JSONB DEFAULT '[]',
    document_id BIGINT,
    raw_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices (po_number);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices (created_at DESC);
COMMENT ON TABLE invoices IS 'Parsed invoice data from AP Agent email processing. Powers reconciliation and vendor intelligence.';
COMMENT ON COLUMN invoices.status IS 'Processing status: unmatched | matched_approved | matched_review | reconciled';
COMMENT ON COLUMN invoices.discrepancies IS 'Array of price/quantity discrepancies found during PO matching';