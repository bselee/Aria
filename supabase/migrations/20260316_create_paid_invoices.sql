-- Migration: Create paid_invoices table
-- Purpose: Logs paid invoice confirmation emails for recall and PO correlation.
-- Rollback: DROP TABLE IF EXISTS paid_invoices;

CREATE TABLE IF NOT EXISTS paid_invoices (
    id              BIGSERIAL PRIMARY KEY,
    vendor_name     TEXT NOT NULL,
    invoice_number  TEXT NOT NULL,
    amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,
    date_paid       DATE,
    po_number       TEXT,                         -- Matched Finale PO orderId (null if unmatched)
    po_matched      BOOLEAN NOT NULL DEFAULT FALSE,
    product_description TEXT,
    vendor_address  TEXT,
    email_from      TEXT,
    email_subject   TEXT,
    gmail_message_id TEXT,
    confidence      TEXT DEFAULT 'medium',         -- high | medium | low
    source_inbox    TEXT DEFAULT 'default',
    draft_po_id     TEXT,                          -- Draft PO created by Aria (null if matched or failed)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick lookups by vendor and invoice number
CREATE INDEX IF NOT EXISTS idx_paid_invoices_vendor ON paid_invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_paid_invoices_invoice ON paid_invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_paid_invoices_gmail ON paid_invoices (gmail_message_id);
