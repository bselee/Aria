-- Migration: Create vendor_invoices table
-- Created: 2026-03-17
-- Purpose: Unified archive of every vendor invoice across all intake channels.
--          Single source of truth for "What did we pay vendor X this year?"
-- Rollback: DROP TABLE IF EXISTS vendor_invoices;

CREATE TABLE IF NOT EXISTS vendor_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name     TEXT NOT NULL,
    invoice_number  TEXT,
    invoice_date    DATE,
    due_date        DATE,
    po_number       TEXT,                          -- Matched Finale PO (null if unmatched)
    subtotal        NUMERIC(12,2) DEFAULT 0,
    freight         NUMERIC(12,2) DEFAULT 0,
    tax             NUMERIC(12,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','reconciled','paid','disputed','void')),
    source          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('email_attachment','portal_scrape','csv_import',
                                          'sandbox_drop','payment_confirm','manual')),
    source_ref      TEXT,                          -- Gmail msg ID, scrape run ID, filename, etc.
    pdf_storage_path TEXT,                         -- Supabase Storage path (documents/{type}/{vendor}/...)
    line_items      JSONB DEFAULT '[]',            -- [{sku, description, qty, unit_price, ext_price}]
    raw_data        JSONB DEFAULT '{}',            -- Full original parsed payload for audit
    reconciled_at   TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate imports of the same invoice from the same vendor
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_invoices_vendor_inv
    ON vendor_invoices (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL;

-- Common query indexes
CREATE INDEX IF NOT EXISTS idx_vi_vendor      ON vendor_invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_vi_date        ON vendor_invoices (invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_vi_po          ON vendor_invoices (po_number)   WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vi_status      ON vendor_invoices (status);
CREATE INDEX IF NOT EXISTS idx_vi_source      ON vendor_invoices (source);
CREATE INDEX IF NOT EXISTS idx_vi_created     ON vendor_invoices (created_at DESC);

COMMENT ON TABLE vendor_invoices IS
    'Unified vendor invoice archive — single source of truth for every invoice regardless of intake channel.';

-- ── Backfill from existing invoices table ─────────────────────────────────────
INSERT INTO vendor_invoices (
    vendor_name, invoice_number, invoice_date, due_date, po_number,
    subtotal, freight, tax, total, status, source, source_ref,
    line_items, raw_data, reconciled_at, created_at
)
SELECT
    COALESCE(i.vendor_name, 'Unknown'),
    i.invoice_number,
    i.invoice_date::DATE,
    CASE WHEN i.due_date ~ '^\d{4}-\d{2}-\d{2}' THEN i.due_date::DATE ELSE NULL END,
    i.po_number,
    i.subtotal,
    i.freight,
    i.tax,
    i.total,
    CASE
        WHEN i.status IN ('reconciled','matched_approved') THEN 'reconciled'
        WHEN i.status = 'paid'                             THEN 'paid'
        ELSE 'received'
    END,
    'email_attachment',
    i.document_id::TEXT,
    COALESCE(i.raw_data->'lineItems', '[]'::JSONB),
    COALESCE(i.raw_data, '{}'::JSONB),
    CASE WHEN i.status IN ('reconciled','matched_approved') THEN i.updated_at ELSE NULL END,
    i.created_at
FROM invoices i
ON CONFLICT (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL
    DO NOTHING;

-- ── Backfill from paid_invoices table ─────────────────────────────────────────
INSERT INTO vendor_invoices (
    vendor_name, invoice_number, total, po_number,
    status, source, source_ref, paid_at, created_at,
    notes
)
SELECT
    pi.vendor_name,
    pi.invoice_number,
    pi.amount_paid,
    pi.po_number,
    'paid',
    'payment_confirm',
    pi.gmail_message_id,
    pi.created_at,          -- treat logged-at as paid-at
    pi.created_at,
    CONCAT_WS(' | ',
        NULLIF(pi.product_description, ''),
        NULLIF(pi.email_subject, '')
    )
FROM paid_invoices pi
ON CONFLICT (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL
    DO UPDATE SET
        status  = 'paid',
        paid_at = EXCLUDED.paid_at,
        notes   = CONCAT_WS(' | ', vendor_invoices.notes, EXCLUDED.notes);
