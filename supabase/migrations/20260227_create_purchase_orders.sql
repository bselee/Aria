-- Migration: Create purchase_orders table
-- Created: 2026-02-27
-- Purpose: Track PO records, vendor response times, and tracking numbers for
--          deduplication of Telegram tracking alerts.

CREATE TABLE IF NOT EXISTS purchase_orders (
    id              BIGSERIAL PRIMARY KEY,
    po_number       TEXT UNIQUE NOT NULL,
    vendor_name     TEXT,
    status          TEXT DEFAULT 'open',
    issue_date      TIMESTAMPTZ,
    required_date   TIMESTAMPTZ,
    total_amount    NUMERIC(12, 2) DEFAULT 0,
    total           NUMERIC(12, 2) DEFAULT 0,
    line_items      JSONB DEFAULT '[]',
    vendor_response_at          TIMESTAMPTZ,
    vendor_response_time_minutes INTEGER,
    tracking_numbers TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_status       ON purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_vendor       ON purchase_orders (vendor_name);
CREATE INDEX IF NOT EXISTS idx_po_created      ON purchase_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_tracking     ON purchase_orders USING GIN (tracking_numbers);

COMMENT ON TABLE purchase_orders IS 'PO records synced from Gmail PO threads. Tracks vendor response times and tracking numbers for dedup.';
COMMENT ON COLUMN purchase_orders.tracking_numbers IS 'Tracking numbers seen for this PO — prevents duplicate Telegram alerts.';
COMMENT ON COLUMN purchase_orders.status IS 'open | partial | received | closed';
